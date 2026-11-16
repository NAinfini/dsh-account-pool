/**
 * The wiring every provider shares: account slots from configuration, the
 * quota reader behind the pool's snapshot hooks, and the pool itself.
 *
 * @module dsh-account-pool/providers/pool-wiring
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter, LlmModelInfo } from '@deepseek-ai/dsh-llm'

import type { ProviderConfig } from '../config.ts'
import { AccountPool, DEFAULT_COOLDOWN_MS, type AccountSlot } from '../pool/account-pool.ts'
import type { UsageLedger } from '../pool/ledger.ts'
import type { QuotaCache } from '../pool/quota-cache.ts'
import { factsOfError } from '../pool/rejection.ts'
import type { StateStore } from '../pool/state-store.ts'
import type { ProviderId, QuotaSnapshot } from '../pool/types.ts'
import { entryKey, sortByOrder } from '../pooling.ts'
import { resolveCredentialRef } from './openai-compat/auth.ts'
import type { ProviderDriver } from './driver.ts'

/** Services every provider shares. */
export interface SharedServices {
  store: StateStore
  ledger: UsageLedger
  quota: QuotaCache
  rotation(): { switchAtPercent: number; cooldownMs: number }
  /** The global account order (`provider:slotId`); accounts it does not list follow in configured order. */
  order(): readonly string[]
}

/** Account slots from one provider section (list order = rotation order). */
export function slotsOf(section: ProviderConfig, defaultRef: string, defaultLabel: string): AccountSlot[] {
  const list: AccountSlot[] = []
  for (const [index, account] of (section.accounts ?? []).entries()) {
    const refName = account.apiKeyEnv?.trim() === '' ? undefined : account.apiKeyEnv?.trim()
    const literal = account.apiKey === undefined || account.apiKey === '' ? undefined : account.apiKey
    if (refName === undefined && literal === undefined) continue
    list.push({
      id: refName ?? `account-${index + 1}`,
      label: account.label?.trim() ? account.label.trim() : `Account ${index + 1}`,
      ref: refName === undefined ? undefined : credentialRef(refName),
      literal,
    })
  }
  if (list.length === 0) list.push({ id: defaultRef, label: defaultLabel, ref: credentialRef(defaultRef) })
  return list
}

export interface PoolSpec {
  driver: ProviderDriver
  defaultRef: string
  defaultApiBase: string
  section(): ProviderConfig
  /** Slot list override (e.g. to attach a key fallback to the default slot). */
  slots?(): AccountSlot[]
  quotaExtras?(): { monthlyUsd?: number | undefined }
}

/** What the control surface (reports, switching, clearing) needs of one mounted provider. */
export interface ProviderHandle {
  provider: ProviderId
  displayName: string
  pool: AccountPool
  /** The adapter that owns the wire protocol, reading its key from the bound call context. */
  inner: LlmAdapter
  slots(): AccountSlot[]
  apiBase(): string
  /** Pinned slot id, or undefined while rotation is automatic. */
  pinned(): string | undefined
  /** Cached quota read for a key (shares one in-flight fetch). */
  quota(key: string): Promise<QuotaSnapshot>
  /** Every model the route serves, ignoring the visibility allowlist. */
  models(): Promise<readonly LlmModelInfo[]>
}

type PoolParts = Omit<ProviderHandle, 'models' | 'inner'>

/** A failed quota read says whether the key itself was refused. */
export function probeVerdict(error: unknown): 'invalid' | 'unknown' {
  const facts = factsOfError(error)
  const http = /HTTP (\d{3})/.exec(facts.message)
  const status = facts.status ?? (http === null ? undefined : Number(http[1]))
  return status === 401 || status === 403 ? 'invalid' : 'unknown'
}

export function createProviderPool(ctx: Context, shared: SharedServices, spec: PoolSpec): PoolParts {
  const { driver } = spec
  const provider = driver.id
  const apiBase = (): string => spec.section().apiBase ?? spec.defaultApiBase
  const configured = spec.slots ?? ((): AccountSlot[] => slotsOf(spec.section(), spec.defaultRef, driver.displayName))
  // List order within this provider is its share of the global order.
  const slots = (): AccountSlot[] => sortByOrder(configured(), (slot) => entryKey(provider, slot.id), shared.order())
  const identity = (key: string): string => `${provider}|${apiBase()}|${key}`
  const fetchQuota = (key: string) => driver.fetchQuota({ apiBase: apiBase(), key, monthlyUsd: spec.quotaExtras?.().monthlyUsd })

  const pinned = (): string | undefined => {
    const id = spec.section().activeAccount?.trim()
    return id === undefined || id === '' ? undefined : id
  }

  const pool = new AccountPool({
    provider,
    slots,
    resolveRef: (ref) => resolveCredentialRef(ctx, ref),
    pinnedId: pinned,
    routeRules: () => (spec.section().modelAccountRules ?? [])
      .filter((rule) => rule.account !== undefined && Array.isArray(rule.models))
      .map((rule) => ({ models: rule.models ?? [], account: rule.account ?? '' })),
    cooldownMs: () => shared.rotation().cooldownMs || DEFAULT_COOLDOWN_MS,
    thresholdPercent: () => shared.rotation().switchAtPercent,
    quotaOf: (key) => shared.quota.peek(identity(key)),
    refreshQuota: (key) => { void shared.quota.get(identity(key), () => fetchQuota(key)) },
    store: shared.store,
    probeKey: (key) => fetchQuota(key).then(() => 'valid' as const, probeVerdict),
  })
  return { provider, displayName: driver.displayName, pool, slots, apiBase, pinned, quota: (key) => shared.quota.get(identity(key), () => fetchQuota(key)) }
}

/**
 * Declare the Models-page entry and register the route. The directory is
 * global and one-shot per provider id (a second declaration throws), and a
 * failed registration must not abort plugin loading (the harness boots nothing
 * when an `apply()` throws), so both are reported instead.
 */
export function registerRoute(ctx: Context, provider: string, displayName: string, adapter: LlmAdapter, settingsPath: string[] = [provider]): void {
  const owner = `llm-account-pool:${provider}`
  try {
    if (!ctx.llm.listConfigurableProviders().some((entry) => entry.provider === provider)) {
      ctx.llm.registerConfigurableProviders([{ provider, displayName, settingsNs: 'llm-account-pool', settingsPath }])
    }
  } catch (error) {
    ctx.logger.warn(`${owner}: could not declare the configurable provider: ${String(error)}`)
  }
  try {
    ctx.llm.registerAdapter([provider], adapter)
  } catch (error) {
    ctx.logger.error(
      `${owner}: could not register the "${provider}" route — another adapter already serves it`
        + ` (remove any other plugin configuring "${provider}" and restart). (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}
