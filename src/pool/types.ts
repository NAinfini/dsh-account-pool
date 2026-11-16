/**
 * Provider-neutral vocabulary shared by the pool, the quota cache, the ledger
 * and every driver. Nothing in here knows which provider it describes.
 *
 * @module dsh-account-pool/pool/types
 */

/** The provider routes this plugin owns. */
export type ProviderId = 'opencode' | 'opendesign' | 'commandcode'

/** Metered window kinds: five hours, seven days, thirty days. */
export type WindowKind = '5h' | '7d' | '30d'

/**
 * One metered window.
 *
 * `percent` is optional on purpose: a provider that reports no window must not
 * be read as "0 % used", and a window with no cap (`cap: 0`) has no percentage
 * at all. A window the provider did not report is simply absent from the list.
 */
export interface QuotaWindow {
  kind: WindowKind
  /** Consumed share, 0–100; undefined when the provider gave no ratio. */
  percent?: number
  /** Consumed / allowed amount in USD, when known. */
  used?: number
  cap?: number
  /** True when the amounts were derived rather than reported. */
  estimated: boolean
  /** Where the numbers come from. */
  source: 'provider' | 'local'
  status: 'ok' | 'limited' | 'unknown'
  /** Epoch ms of the next reset. */
  resetAt?: number
}

/** One account's quota at one instant. */
export interface QuotaSnapshot {
  windows: QuotaWindow[]
  fetchedAt: number
  /**
   * Identity the quota is metered against. Two keys answering the same scope
   * share one allowance, so they share one cooldown. Absent means "the key
   * itself".
   */
  scopeId?: string
  /** Why the fetch failed; absent on success. */
  error?: string
}

/** Why a key could not serve one request. */
export type RejectionKind =
  /** 401 / no entitlement: the key itself is unusable until it changes. */
  | 'invalid-credential'
  /** A metered window ran out. */
  | 'quota-exhausted'
  /** A short burst limit (RPM); a brief pause is enough. */
  | 'rate-limited'
  /** The plan does not include this model; the key stays usable for others. */
  | 'model-not-allowed'

/** A classified failure plus whatever the provider said about when to retry. */
export interface Rejection {
  kind: RejectionKind
  /** Provider-announced wait in ms (`Retry-After`, "Resets in 3 days"). */
  retryAfterMs?: number
}

/** The failure facts a classifier reads, whichever shape carried them. */
export interface FailureFacts {
  code: string
  message: string
  status?: number | undefined
  providerRetryAfterMs?: number | undefined
}

/**
 * Rotation state of one allowance.
 *
 * - `unknown`: rejected with a 429 whose reset time nobody named; probed for
 *   revival and expires after the default cooldown.
 * - `cooldown`: unusable until `until`.
 * - `disabled`: the key was rejected as invalid; skipped until it changes or
 *   the user clears it. Carries a timestamp so a restart can re-test it.
 */
export type AccountState =
  | { kind: 'unknown'; reason: string; markedAt: number; until: number }
  | { kind: 'cooldown'; reason: string; markedAt: number; until: number; window?: WindowKind }
  | { kind: 'disabled'; reason: string; markedAt: number }

/** A rule routing some models to one account. */
export interface ModelAccountRule {
  models: string[]
  /** Slot id. */
  account: string
}
