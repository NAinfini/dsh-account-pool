/**
 * Command Code model catalog (`GET /provider/v1/models`), cached on disk.
 * Best-effort like the other providers' discovery: a failure keeps the last
 * list and the route keeps serving it.
 *
 * @module dsh-account-pool/providers/commandcode/catalog
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

import { readJsonSafe, writeJsonAtomic } from '../../pool/persist.ts'
import { parseCatalog, type CatalogModel } from './wire.ts'

export const CATALOG_TTL_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

interface CacheFile {
  version: number
  apiBase: string
  fetchedAt: number
  models: CatalogModel[]
}

export class CommandCodeCatalog {
  private models: CatalogModel[] = []
  private apiBase = ''
  private fetchedAt = 0
  private refreshing = false
  private readonly path: string
  private readonly onError: (error: unknown) => void
  private readonly fetchImpl: typeof fetch

  constructor(path: string, onError: (error: unknown) => void, fetchImpl: typeof fetch = fetch) {
    this.path = path
    this.onError = onError
    this.fetchImpl = fetchImpl
  }

  async load(): Promise<void> {
    const raw = await readJsonSafe(this.path, (error) => { this.onError(error) })
    if (typeof raw !== 'object' || raw === null) return
    const file = raw as Partial<CacheFile>
    if (file.version !== 1 || !Array.isArray(file.models)) return
    this.models = file.models.filter((model) => typeof model?.id === 'string' && typeof model.contextWindow === 'number')
    this.apiBase = typeof file.apiBase === 'string' ? file.apiBase : ''
    this.fetchedAt = typeof file.fetchedAt === 'number' ? file.fetchedAt : 0
  }

  list(apiBase: string): readonly CatalogModel[] {
    return this.apiBase === apiBase ? this.models : []
  }

  stale(apiBase: string, now = Date.now()): boolean {
    return this.apiBase !== apiBase || now - this.fetchedAt >= CATALOG_TTL_MS
  }

  /** Fetch the catalog; concurrent calls collapse. Returns whether the model ids changed. */
  async refresh(apiBase: string): Promise<boolean> {
    if (this.refreshing) return false
    this.refreshing = true
    const before = this.list(apiBase).map((model) => model.id).join('\n')
    try {
      const response = await this.fetchImpl(`${apiBase.replace(/\/+$/, '')}/provider/v1/models`, {
        headers: { accept: 'application/json', ...attributionHeaders() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`GET /provider/v1/models failed with HTTP ${response.status}`)
      const models = parseCatalog(await response.json())
      this.models = models
      this.apiBase = apiBase
      this.fetchedAt = Date.now()
      await writeJsonAtomic(this.path, { version: 1, apiBase, fetchedAt: this.fetchedAt, models } satisfies CacheFile)
      return models.map((model) => model.id).join('\n') !== before
    } catch (error) {
      this.onError(error)
      return false
    } finally {
      this.refreshing = false
    }
  }
}
