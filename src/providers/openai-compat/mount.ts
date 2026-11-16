/**
 * Mounts one OpenAI-Chat-Completions provider (OpenCode Go, Open Design) onto
 * the harness: its account pool, quota reader, model catalog, pi-ai adapter
 * and the rotating wrapper registered as the provider's route.
 *
 * @module dsh-account-pool/providers/openai-compat/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import type { ProviderConfig } from '../../config.ts'
import type { AccountPool, AccountSlot } from '../../pool/account-pool.ts'
import { boundKey } from '../../pool/call-key.ts'
import type { ProviderDriver } from '../driver.ts'
import { createProviderPool, registerRoute, type ProviderHandle, type SharedServices } from '../pool-wiring.ts'
import { buildAuth } from './auth.ts'
import { CATALOG_TTL_MS, ModelCatalog } from './catalog.ts'
import { buildProfile, builtinModelIds, type ModelEntry } from './profile.ts'
import { RotatingAdapter } from './rotating-adapter.ts'

export interface MountSpec<C extends ProviderConfig> {
  driver: ProviderDriver
  /** Credential reference standing in when no account is configured. */
  defaultRef: string
  defaultApiBase: string
  /** Models served until discovery answers (and when it never does). */
  seedModels: readonly string[]
  section(): C
  /** Provider-specific fields the quota reader needs. */
  quotaExtras?(section: C): { monthlyUsd?: number | undefined }
}

export interface Mounted {
  pool: AccountPool
  adapter: RotatingAdapter
  slots(): AccountSlot[]
  handle: ProviderHandle
}

export function mountOpenAiCompat<C extends ProviderConfig>(ctx: Context, shared: SharedServices, spec: MountSpec<C>): Mounted {
  const { driver } = spec
  const provider = driver.id
  const owner = `llm-account-pool:${provider}`
  const parts = createProviderPool(ctx, shared, {
    driver,
    defaultRef: spec.defaultRef,
    defaultApiBase: spec.defaultApiBase,
    section: spec.section,
    quotaExtras: () => spec.quotaExtras?.(spec.section()) ?? {},
  })
  const { pool, slots, apiBase } = parts

  // Model catalog: seeded from the on-disk cache, refreshed on a timer.
  const catalog = new ModelCatalog(
    dshHomePath('storages', 'dsh-account-pool', `models-${provider}.json`),
    (error) => { ctx.logger.warn(`${owner}: model discovery failed: ${String(error)}`) },
  )
  let memo: Map<string, ResolvedPiAiProviderProfile> | undefined
  const profiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    if (memo !== undefined) return memo
    const section = spec.section()
    const base = apiBase()
    const ids = [...new Set([...catalog.list(base), ...spec.seedModels, ...(catalog.list(base).length === 0 ? builtinModelIds(provider) : [])])]
    const models: ModelEntry[] = ids.map((id) => ({ id }))
    memo = new Map([[provider, buildProfile({
      provider,
      displayName: driver.displayName,
      baseUrl: base,
      models,
      headers: section.headers,
      timeoutMs: section.requestTimeoutMs,
      streamIdleTimeoutMs: section.streamIdleTimeoutMs,
    })]])
    return memo
  }

  let refreshing = false
  const refreshCatalog = async (): Promise<void> => {
    if (refreshing || !catalog.stale(apiBase())) return
    refreshing = true
    try {
      const key = await pool.acquire().then((selection) => selection?.account.key).catch(() => undefined)
      if (await catalog.refresh(apiBase(), key)) {
        memo = undefined
        ctx.logger.info(`${owner}: discovered ${catalog.list(apiBase()).length} model(s)`)
      }
    } finally {
      refreshing = false
    }
  }
  void catalog.load().then(() => {
    memo = undefined
    void refreshCatalog()
  })
  ctx.effect(() => {
    const timer = setInterval(() => { void refreshCatalog() }, CATALOG_TTL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, `${owner}: catalog refresh`)

  const inner = new PiAiAdapter({
    profiles,
    // A request runs with the key the pool bound to it. The engine also asks
    // for a key when merely listing models, and treats a missing one as "this
    // provider is unavailable", so outside a request any configured account does.
    resolveApiKey: async () => {
      const key = boundKey() ?? (await pool.resolved())[0]?.key
      if (key === undefined) {
        throw new LlmError(`${owner}: no API key configured; add an account in Settings → Account Pool`, 'MISSING_CREDENTIAL')
      }
      return key
    },
    auth: buildAuth(ctx, owner),
    resolveAttachments: () => ctx.get('attachments'),
  })

  const adapter = new RotatingAdapter({
    provider,
    inner,
    pool,
    ledger: shared.ledger,
    visibleModels: () => spec.section().visibleModels,
    onRotate: (info) => {
      ctx.logger.info(`${owner}: account "${info.slotId}" rejected (${info.reason}); trying the next account`)
    },
  })

  registerRoute(ctx, provider, driver.displayName, adapter)

  return { pool, adapter, slots, handle: { ...parts, inner, models: () => adapter.allModels(provider) } }
}
