/**
 * The host-side control surface: what the settings page, the sidebar card and
 * the usage panel ask of the pool. It reads state and performs the two user
 * actions (pin an account, clear marks); it never holds a key outside a call.
 *
 * @module dsh-account-pool/control
 */

import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

import type { UsageLedger, UsageTotals } from './pool/ledger.ts'
import { ledgerKey } from './pool/ledger.ts'
import type { ProviderId, QuotaSnapshot } from './pool/types.ts'
import type { ProviderHandle } from './providers/pool-wiring.ts'

const DAY_MS = 24 * 60 * 60_000

/**
 * - `ok`: can serve now.
 * - `cooldown`: parked until `until` (a 429, or an exhausted window).
 * - `exhausted`: a metered window is at the switch threshold; resets at `until` when known.
 * - `disabled`: the key was rejected as invalid.
 * - `unconfigured`: the slot has no key.
 */
export type AccountStatus = 'ok' | 'cooldown' | 'exhausted' | 'disabled' | 'unconfigured'

export interface AccountReport {
  id: string
  label: string
  status: AccountStatus
  /** Why the account is not `ok`; absent while it is. */
  reason?: string
  /** Epoch ms the account becomes usable again, when known. */
  until?: number
  /** True for the account that would serve the next request. */
  serving: boolean
  /** True when this slot is the manual pin. */
  pinned: boolean
  quota?: QuotaSnapshot
  usage: { last24h: UsageTotals; last7d: UsageTotals; total: UsageTotals }
}

export interface ProviderReport {
  provider: ProviderId
  displayName: string
  apiBase: string
  /** Pinned slot id, set only while it names a configured slot. */
  pinned?: string
  accounts: AccountReport[]
}

export interface PoolReport {
  providers: ProviderReport[]
}

export interface CatalogEntry {
  id: string
  name?: string
}

export interface ControlDeps {
  handles: readonly ProviderHandle[]
  ledger: UsageLedger
  /** Settings namespace of this plugin's profile entry. */
  settingsNs: string
  mutateSettings(ns: string, ops: readonly SettingsPathOp[]): Promise<void>
}

export class PoolControl {
  private readonly deps: ControlDeps

  constructor(deps: ControlDeps) {
    this.deps = deps
  }

  private handleOf(provider: string): ProviderHandle {
    const handle = this.deps.handles.find((candidate) => candidate.provider === provider)
    if (handle === undefined) throw new Error(`unknown provider "${provider}"`)
    return handle
  }

  async report(): Promise<PoolReport> {
    return { providers: await Promise.all(this.deps.handles.map((handle) => this.reportProvider(handle))) }
  }

  private async reportProvider(handle: ProviderHandle): Promise<ProviderReport> {
    const { pool, provider } = handle
    const resolved = await pool.resolved()
    // One cached read per key; a failure is recorded on the snapshot, never thrown.
    await Promise.allSettled(resolved.map((account) => handle.quota(account.key)))
    const serving = pool.select(resolved)?.account.slot.id
    const byId = new Map(resolved.map((account) => [account.slot.id, account]))
    const slots = handle.slots()
    const pinnedId = handle.pinned()

    const accounts = slots.map((slot): AccountReport => {
      const account = byId.get(slot.id)
      const ledgerId = ledgerKey(provider, slot.id)
      const usage = {
        last24h: this.deps.ledger.window(ledgerId, DAY_MS),
        last7d: this.deps.ledger.window(ledgerId, 7 * DAY_MS),
        total: this.deps.ledger.window(ledgerId),
      }
      const base = { id: slot.id, label: slot.label, serving: slot.id === serving, pinned: slot.id === pinnedId, usage }
      if (account === undefined) {
        return { ...base, status: 'unconfigured', reason: 'no API key' }
      }
      const quota = pool.quotaOf(account.key)
      const withQuota = quota === undefined ? base : { ...base, quota }
      const skip = pool.skipReason(account)
      if (skip === undefined) return { ...withQuota, status: 'ok' }
      switch (skip.kind) {
        case 'disabled': return { ...withQuota, status: 'disabled', reason: skip.reason }
        case 'cooldown': return { ...withQuota, status: 'cooldown', reason: skip.reason, until: skip.until }
        case 'preflight': return {
          ...withQuota,
          status: 'exhausted',
          reason: `${skip.window.kind} window exhausted`,
          ...(skip.window.resetAt === undefined ? {} : { until: skip.window.resetAt }),
        }
        case 'model-denied': return { ...withQuota, status: 'ok' }
      }
    })
    const pinned = pinnedId !== undefined && slots.some((slot) => slot.id === pinnedId) ? pinnedId : undefined
    return {
      provider,
      displayName: handle.displayName,
      apiBase: handle.apiBase(),
      ...(pinned === undefined ? {} : { pinned }),
      accounts,
    }
  }

  /** Every model each route serves (ignores the visibility allowlist). */
  async models(): Promise<Record<string, CatalogEntry[]>> {
    const out: Record<string, CatalogEntry[]> = {}
    for (const handle of this.deps.handles) {
      const models = await handle.models().catch(() => [])
      out[handle.provider] = models.map((model) => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) }))
    }
    return out
  }

  /**
   * Pin one account, or return to automatic rotation with `accountId === null`.
   * There is one pin across all providers (the global order has one head), so
   * pinning clears any pin another provider holds, and "automatic" clears all.
   */
  async switchAccount(provider: string, accountId: string | null): Promise<void> {
    const handle = this.handleOf(provider)
    const unsetPath = (other: ProviderHandle) => ({ op: 'unset' as const, path: [other.provider, 'activeAccount'] })
    const pinnedElsewhere = this.deps.handles.filter((other) => other !== handle && other.pinned() !== undefined)
    if (accountId === null) {
      await this.deps.mutateSettings(this.deps.settingsNs, [handle, ...pinnedElsewhere].map(unsetPath))
      return
    }
    if (!handle.slots().some((slot) => slot.id === accountId)) {
      throw new Error(`"${provider}" has no account "${accountId}"`)
    }
    await this.deps.mutateSettings(this.deps.settingsNs, [
      ...pinnedElsewhere.map(unsetPath),
      { op: 'set', path: [handle.provider, 'activeAccount'], value: accountId },
    ])
  }

  /** Forget cooldowns and invalid-key marks for one provider, or all of them. */
  async clear(provider?: string): Promise<void> {
    const handles = provider === undefined ? this.deps.handles : [this.handleOf(provider)]
    await Promise.all(handles.map((handle) => handle.pool.clear()))
  }
}
