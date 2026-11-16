/**
 * Live model discovery (`GET {apiBase}/models`), cached on disk. Discovery is
 * best-effort: a failure keeps the last cached list (or none) and the route
 * keeps serving whatever configuration declares.
 *
 * @module dsh-account-pool/providers/openai-compat/catalog
 */

import { readJsonSafe, writeJsonAtomic } from '../../pool/persist.ts'

/** How long one discovered list is trusted before a background refetch. */
export const CATALOG_TTL_MS = 10 * 60_000

interface CacheFile {
  version: number
  apiBase: string
  fetchedAt: number
  ids: string[]
}

export class ModelCatalog {
  private ids: string[] = []
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
    if (file.version !== 1 || !Array.isArray(file.ids)) return
    this.ids = file.ids.filter((id): id is string => typeof id === 'string' && id !== '')
    this.apiBase = typeof file.apiBase === 'string' ? file.apiBase : ''
    this.fetchedAt = typeof file.fetchedAt === 'number' ? file.fetchedAt : 0
  }

  /** Ids discovered for the endpoint currently configured. */
  list(apiBase: string): readonly string[] {
    return this.apiBase === apiBase ? this.ids : []
  }

  stale(apiBase: string, now = Date.now()): boolean {
    return this.apiBase !== apiBase || now - this.fetchedAt >= CATALOG_TTL_MS
  }

  /** Fetch the list; concurrent calls collapse. Returns whether the ids changed. */
  async refresh(apiBase: string, apiKey: string | undefined): Promise<boolean> {
    if (this.refreshing) return false
    this.refreshing = true
    const before = this.list(apiBase).join('\n')
    try {
      const root = apiBase.replace(/\/+$/, '')
      const response = await this.fetchImpl(`${root}/models`, {
        headers: apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GET ${root}/models failed with HTTP ${response.status}`)
      const payload = await response.json() as { data?: unknown }
      const ids = [...new Set((Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id !== ''))]
      if (ids.length === 0) throw new Error(`GET ${root}/models returned no models`)
      this.ids = ids
      this.apiBase = apiBase
      this.fetchedAt = Date.now()
      await writeJsonAtomic(this.path, { version: 1, apiBase, fetchedAt: this.fetchedAt, ids } satisfies CacheFile)
      return ids.join('\n') !== before
    } catch (error) {
      this.onError(error)
      return false
    } finally {
      this.refreshing = false
    }
  }
}
