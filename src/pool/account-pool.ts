/**
 * The account pool: which key serves the next request, and what a rejection
 * does to the accounts.
 *
 * Selection order is: the manually pinned account, else the account a model
 * rule routes to, else list order. An account is skipped (not marked) when the
 * live quota snapshot says a window is exhausted — a derived, never-persisted
 * hint that costs no attempt. Only real rejections write state, and state is
 * keyed by *allowance* (quota scope) rather than by key, so several keys that
 * draw on one allowance cool down together; a dead key (401) is keyed by the
 * key itself.
 *
 * The pool is deliberately free of the harness: every host fact is injected,
 * so it can be tested with plain objects.
 *
 * @module dsh-account-pool/pool/account-pool
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import { exhaustedWindow } from './quota-cache.ts'
import type { StateStore } from './state-store.ts'
import type {
  AccountState, ModelAccountRule, ProviderId, QuotaSnapshot, QuotaWindow, Rejection,
} from './types.ts'

/**
 * Longest wait the all-exhausted `RATE_LIMIT` error asks the harness retry
 * policy for. The harness honours a provider-specified wait only at or below
 * its policy `maxDelayMs`, so the pool never asks for more.
 */
export const RETRY_MAX_DELAY_MS = 900_000

/** Default pause for a 429 nobody explained. */
export const DEFAULT_COOLDOWN_MS = 5 * 60_000

/** Pause after a plain burst limit with no hint. */
export const BURST_COOLDOWN_MS = 30_000

/** A cooldown never exceeds one week. */
export const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000

/** Minimum spacing between probes of one inherited-disabled key whose check failed. */
export const PROBE_RETRY_MS = 60_000

/** How long a model-level refusal keeps one key away from that model. */
export const MODEL_DENIAL_MS = 10 * 60_000

/** One configured account. */
export interface AccountSlot {
  /** Stable id: the credential reference name, or `account-N` for literal-only slots. */
  id: string
  label: string
  ref?: CredentialRef | undefined
  /** Literal key from composition config (never stored in settings). */
  literal?: string | undefined
  /** Last-resort key source (e.g. the official CLI's auth file), tried after the credential seam. */
  fallback?: (() => string | undefined) | undefined
}

/** A slot paired with its resolved key and identity fingerprints. */
export interface ResolvedAccount {
  slot: AccountSlot
  key: string
  keyFp: string
  scopeFp: string
}

export interface PoolDeps {
  provider: ProviderId
  slots(): readonly AccountSlot[]
  resolveRef(ref: CredentialRef): Promise<string | undefined>
  /** Pinned slot id, re-read per call. */
  pinnedId?(): string | undefined
  routeRules?(): readonly ModelAccountRule[]
  cooldownMs(): number
  /** Preflight threshold in percent (100 = only skip when truly exhausted). */
  thresholdPercent(): number
  /** Last known snapshot for a key; must not touch the network. */
  quotaOf(key: string): QuotaSnapshot | undefined
  /** Ask for a fresh snapshot in the background (fire and forget). */
  refreshQuota(key: string): void
  store: StateStore
  /**
   * Re-test a key the previous run found invalid. `invalid` keeps it disabled,
   * `valid` revives it, `unknown` (the check itself failed) tries again later.
   */
  probeKey?(key: string): Promise<'valid' | 'invalid' | 'unknown'>
  now?(): number
}

/** Why an account cannot serve right now (for errors and the UI). */
export type SkipReason =
  | { kind: 'disabled'; reason: string }
  | { kind: 'cooldown'; reason: string; until: number }
  | { kind: 'preflight'; window: QuotaWindow }
  | { kind: 'model-denied'; until: number }

/**
 * The error for "nothing can serve": all invalid, or at a limit with the
 * earliest reset as the retry wait (never above what the harness honours).
 * `subject` names what was exhausted, e.g. a provider id.
 */
export function exhaustedError(subject: string, reasons: readonly (SkipReason | undefined)[], now: number): LlmError {
  const count = reasons.length
  if (reasons.every((reason) => reason?.kind === 'disabled')) {
    return new LlmError(
      `llm-account-pool: every "${subject}" account (${count}) was rejected as invalid`
        + ' — check the API keys in Settings → Account Pool'
        + `；${count} 个账户的密钥均被拒绝，请检查密钥`,
      'INVALID_CREDENTIAL',
    )
  }
  const resets = reasons.flatMap((reason): number[] => {
    if (reason === undefined) return []
    if (reason.kind === 'cooldown' || reason.kind === 'model-denied') return [reason.until]
    if (reason.kind === 'preflight' && reason.window.resetAt !== undefined) return [reason.window.resetAt]
    return []
  })
  const earliest = resets.length === 0 ? 0 : Math.min(...resets)
  const wait = earliest > now ? Math.min(RETRY_MAX_DELAY_MS, Math.max(1_000, earliest - now)) : undefined
  return new LlmError(
    `llm-account-pool: all ${count} "${subject}" account(s) are at their limit`
      + (earliest > now ? `; the earliest window resets at ${new Date(earliest).toLocaleString()}` : '')
      + '；所有账户均已达到用量上限，将在最早重置后自动恢复',
    'RATE_LIMIT',
    wait === undefined ? undefined : { providerRetryAfterMs: wait },
  )
}

export interface Selection {
  account: ResolvedAccount
}

export class AccountPool {
  private readonly deps: PoolDeps
  private readonly now: () => number
  /** `keyFp|model` → denial expiry. In-memory only: it is a hint, not a fact. */
  private readonly modelDenied = new Map<string, number>()
  private readonly startedAt: number
  /** `keyFp` → when the last probe ran (`Infinity` once the key was confirmed invalid). */
  private readonly probedAt = new Map<string, number>()

  constructor(deps: PoolDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.startedAt = this.now()
  }

  /** Resolve one slot's key: literal first, then the credential seam. */
  private async keyOf(slot: AccountSlot): Promise<string | undefined> {
    const literal = slot.literal?.trim()
    if (literal !== undefined && literal !== '') return literal
    const resolved = slot.ref === undefined ? undefined : (await this.deps.resolveRef(slot.ref))?.trim()
    if (resolved !== undefined && resolved !== '') return resolved
    const fallback = slot.fallback?.()?.trim()
    return fallback === undefined || fallback === '' ? undefined : fallback
  }

  private scopeIdentity(key: string): string {
    const scope = this.deps.quotaOf(key)?.scopeId
    return `${this.deps.provider}|${scope === undefined ? `key:${key}` : `scope:${scope}`}`
  }

  /** Every slot with a resolvable key, deduplicated by key (first slot wins). */
  async resolved(): Promise<ResolvedAccount[]> {
    const out: ResolvedAccount[] = []
    const seen = new Set<string>()
    for (const slot of this.deps.slots()) {
      const key = await this.keyOf(slot)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push({
        slot,
        key,
        keyFp: this.deps.store.fingerprint(`${this.deps.provider}|key:${key}`),
        scopeFp: this.deps.store.fingerprint(this.scopeIdentity(key)),
      })
    }
    return out
  }

  /** The effective state of one account, expiring stale marks as a side effect. */
  stateOf(account: ResolvedAccount): AccountState | undefined {
    const now = this.now()
    const disabled = this.deps.store.keys.get(account.keyFp)
    if (disabled !== undefined) return disabled
    const state = this.deps.store.scopes.get(account.scopeFp)
    if (state === undefined || state.kind === 'disabled') return undefined
    if (now >= state.until) {
      this.deps.store.scopes.delete(account.scopeFp)
      this.deps.store.changed()
      return undefined
    }
    return state
  }

  /** Why this account cannot serve `model` right now, or undefined when it can. */
  skipReason(account: ResolvedAccount, model?: string): SkipReason | undefined {
    const now = this.now()
    const state = this.stateOf(account)
    const snapshot = this.deps.quotaOf(account.key)
    if (state?.kind === 'disabled') return { kind: 'disabled', reason: state.reason }
    const exhausted = exhaustedWindow(snapshot, this.deps.thresholdPercent())
    const stillExhausted = exhausted !== undefined && (exhausted.resetAt === undefined || exhausted.resetAt > now)
    if (state !== undefined) {
      // An unknown-reset 429 is revived as soon as a snapshot taken after the
      // mark shows no exhausted window; a named cooldown is honoured to its end.
      const revived = state.kind === 'unknown'
        && snapshot !== undefined && snapshot.error === undefined
        && snapshot.fetchedAt > state.markedAt && !stillExhausted
      if (revived) {
        this.deps.store.scopes.delete(account.scopeFp)
        this.deps.store.changed()
      } else {
        return { kind: 'cooldown', reason: state.reason, until: state.until }
      }
    }
    if (stillExhausted) return { kind: 'preflight', window: exhausted }
    if (model !== undefined) {
      const until = this.modelDenied.get(`${account.keyFp}|${model}`)
      if (until !== undefined) {
        if (until > now) return { kind: 'model-denied', until }
        this.modelDenied.delete(`${account.keyFp}|${model}`)
      }
    }
    return undefined
  }

  /**
   * Keys disabled by an earlier run are tested once before anyone is told
   * "every account is invalid": the user may have fixed the account since.
   * Marks made during this run are never second-guessed.
   */
  private async reprobe(accounts: readonly ResolvedAccount[]): Promise<void> {
    const probe = this.deps.probeKey
    if (probe === undefined) return
    const now = this.now()
    const due = accounts.filter((account) => {
      const state = this.deps.store.keys.get(account.keyFp)
      if (state === undefined || state.markedAt >= this.startedAt) return false
      const last = this.probedAt.get(account.keyFp)
      return last === undefined || now - last >= PROBE_RETRY_MS
    })
    await Promise.all(due.map(async (account) => {
      this.probedAt.set(account.keyFp, now)
      const verdict = await probe(account.key).catch((): 'unknown' => 'unknown')
      if (verdict === 'valid') {
        this.deps.store.keys.delete(account.keyFp)
        this.deps.store.changed()
      } else if (verdict === 'invalid') {
        this.probedAt.set(account.keyFp, Infinity)
      }
    }))
  }

  /** Candidate order for one request: pinned, routed, then list order. */
  private ordered(accounts: readonly ResolvedAccount[], model: string | undefined): ResolvedAccount[] {
    const pinnedId = this.deps.pinnedId?.()
    const pinned = pinnedId === undefined ? undefined : accounts.find((account) => account.slot.id === pinnedId)
    const rule = model === undefined || model === ''
      ? undefined
      : this.deps.routeRules?.().find((candidate) => candidate.models.includes(model))
    const routed = rule === undefined ? undefined : accounts.find((account) => account.slot.id === rule.account)
    const head = [pinned, routed].filter((account): account is ResolvedAccount => account !== undefined)
    return [...head, ...accounts.filter((account) => !head.includes(account))]
  }

  /**
   * Pick the account that serves next without side effects beyond mark expiry
   * and background refreshes. `exclude` holds keys this request already tried.
   */
  select(
    accounts: readonly ResolvedAccount[],
    model?: string,
    exclude: ReadonlySet<string> = new Set(),
  ): Selection | undefined {
    for (const account of this.ordered(accounts.filter((candidate) => !exclude.has(candidate.key)), model)) {
      if (!this.deps.quotaOf(account.key)) this.deps.refreshQuota(account.key)
      if (this.skipReason(account, model) === undefined) return { account }
    }
    return undefined
  }

  /**
   * Every account that can serve `model` now, in list order (no pin, no model
   * rule: callers merging several providers apply their own order). Probes
   * keys an earlier run disabled first, like `acquire`.
   */
  async servable(model?: string): Promise<ResolvedAccount[]> {
    const all = await this.resolved()
    await this.reprobe(all)
    return all.filter((account) => {
      if (!this.deps.quotaOf(account.key)) this.deps.refreshQuota(account.key)
      return this.skipReason(account, model) === undefined
    })
  }

  /** Why each key-bearing account cannot serve `model` (for the caller's own exhaustion error). */
  async skipReasons(model?: string): Promise<(SkipReason | undefined)[]> {
    return (await this.resolved()).map((account) => this.skipReason(account, model))
  }

  /**
   * Hand out the key for one attempt. Returns `undefined` only when every
   * resolvable key was already tried by this request (the caller then reports
   * the failure it already holds); throws when nothing can serve.
   */
  async acquire(options: { model?: string; exclude?: ReadonlySet<string> } = {}): Promise<Selection | undefined> {
    const all = await this.resolved()
    if (all.length === 0) {
      throw new LlmError(
        `llm-account-pool: no API key configured for "${this.deps.provider}" — add an account in Settings → Account Pool`
          + `；未配置 ${this.deps.provider} 的 API Key，请在「设置 → 账户池」添加账户`,
        'MISSING_CREDENTIAL',
      )
    }
    await this.reprobe(all)
    const exclude = options.exclude ?? new Set<string>()
    const candidates = all.filter((account) => !exclude.has(account.key))
    if (candidates.length === 0) return undefined
    const chosen = this.select(all, options.model, exclude)
    if (chosen !== undefined) return chosen
    throw exhaustedError(this.deps.provider, candidates.map((account) => this.skipReason(account, options.model)), this.now())
  }

  /**
   * Record a real rejection against the exact key that was used. Preflight
   * skips never come through here.
   */
  reject(key: string, rejection: Rejection, model?: string): void {
    const trimmed = key.trim()
    if (trimmed === '') return
    const now = this.now()
    const store = this.deps.store
    const keyFp = store.fingerprint(`${this.deps.provider}|key:${trimmed}`)
    const scopeFp = store.fingerprint(this.scopeIdentity(trimmed))

    if (rejection.kind === 'invalid-credential') {
      store.keys.set(keyFp, { kind: 'disabled', reason: 'rejected as invalid (401/403)', markedAt: now })
      store.changed()
      return
    }
    if (rejection.kind === 'model-not-allowed') {
      if (model !== undefined && model !== '') this.modelDenied.set(`${keyFp}|${model}`, now + MODEL_DENIAL_MS)
      return
    }

    const snapshot = this.deps.quotaOf(trimmed)
    const window = exhaustedWindow(snapshot, this.deps.thresholdPercent())
    const named = window?.resetAt !== undefined && window.resetAt > now ? window.resetAt - now : rejection.retryAfterMs
    let state: AccountState
    if (named !== undefined) {
      const span = Math.min(MAX_COOLDOWN_MS, Math.max(1_000, named))
      state = {
        kind: 'cooldown',
        reason: window === undefined ? 'limited; provider named a wait' : `${window.kind} window exhausted`,
        markedAt: now,
        until: now + span,
        ...(window === undefined ? {} : { window: window.kind }),
      }
    } else if (rejection.kind === 'rate-limited') {
      state = { kind: 'cooldown', reason: 'rate limited (429)', markedAt: now, until: now + Math.min(BURST_COOLDOWN_MS, this.deps.cooldownMs()) }
    } else {
      // Quota gone but nobody said when it returns: pause, then let a fresh
      // snapshot revive it early if the window turns out to be open.
      state = { kind: 'unknown', reason: 'quota exhausted; reset time unknown', markedAt: now, until: now + this.deps.cooldownMs() }
    }
    store.scopes.set(scopeFp, state)
    store.changed()
    // A rejected key's real window is worth knowing: refresh for the UI and revival.
    this.deps.refreshQuota(trimmed)
  }

  /** The last known quota for a key (no network). */
  quotaOf(key: string): QuotaSnapshot | undefined {
    return this.deps.quotaOf(key)
  }

  /**
   * Forget the marks of this provider's accounts (the "clear marks" action).
   * The state store is shared between providers, so only the entries these
   * accounts map to are removed.
   */
  async clear(): Promise<void> {
    this.probedAt.clear()
    this.modelDenied.clear()
    for (const account of await this.resolved()) {
      this.deps.store.keys.delete(account.keyFp)
      this.deps.store.scopes.delete(account.scopeFp)
    }
    this.deps.store.changed()
  }
}
