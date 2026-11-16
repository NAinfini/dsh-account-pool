/**
 * Failure classification. A provider answers "no" in many ways and only some
 * of them mean "stop using this key": this module separates the four that
 * matter for rotation and extracts whatever reset hint the provider gave.
 *
 * @module dsh-account-pool/pool/rejection
 */

import type { FailureFacts, Rejection } from './types.ts'

const UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  min: 60_000,
  second: 1_000,
  sec: 1_000,
}

function unitMs(unit: string): number {
  const lower = unit.toLowerCase()
  for (const [prefix, ms] of Object.entries(UNIT_MS)) {
    if (lower.startsWith(prefix)) return ms
  }
  return 1_000
}

/**
 * How long the provider asked us to wait, in ms. Prefers the structured
 * `providerRetryAfterMs`, then the wording gateways use ("Resets in 3 days",
 * "retry after 30 seconds").
 */
export function retryHintOf(facts: Pick<FailureFacts, 'message' | 'providerRetryAfterMs'>): number | undefined {
  const structured = facts.providerRetryAfterMs
  if (typeof structured === 'number' && Number.isFinite(structured) && structured > 0) return structured
  const patterns = [
    /resets?\s+in\s+(\d+)\s*(day|hour|minute|min|second|sec)s?\b/i,
    /retry[\s-]*after[\s:]+(\d+)\s*(day|hour|minute|min|second|sec)s?\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(facts.message)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > 0) return value * unitMs(match[2] ?? 'second')
  }
  return undefined
}

const MODEL_NOT_ALLOWED = /MODEL_NOT_IN_PLAN|not (?:included )?in (?:your |the )?plan|model .{0,40}(?:not available|not allowed|not supported) (?:on|for|in) (?:your|this) (?:plan|subscription)/i
const INVALID_KEY = /\b401\b|invalid[\s_-]?(?:api[\s_-]?)?key|unauthori[sz]ed|subscription required|not subscribed|no (?:active )?subscription/i
const QUOTA = /usage[\s_-]?limit|limit[\s_-]?(?:reached|exceeded)|quota|insufficient|out of (?:credits|budget|balance)|billing|\b402\b|GoUsageLimit|credits?[\s_-]*(?:exhausted|depleted)/i
const BURST = /\b429\b|rate[\s_-]?limit|too many requests/i

/**
 * Classify one failure, or return undefined when it says nothing about the
 * key (transport faults, aborts, 5xx — the harness retry policy owns those).
 *
 * Order matters: a model-level 403 must not be read as a dead key, and a
 * message that mentions a quota is a quota even when it also carries a 429.
 */
export function classifyFailure(facts: FailureFacts): Rejection | undefined {
  const { code, message, status } = facts
  const retryAfterMs = retryHintOf(facts)
  const withHint = (kind: Rejection['kind']): Rejection =>
    retryAfterMs === undefined ? { kind } : { kind, retryAfterMs }

  if (status === 403 || code === 'FORBIDDEN' || code === 'MODEL_NOT_IN_PLAN') {
    if (code === 'MODEL_NOT_IN_PLAN' || MODEL_NOT_ALLOWED.test(message)) return withHint('model-not-allowed')
    return withHint('invalid-credential')
  }
  if (MODEL_NOT_ALLOWED.test(message)) return withHint('model-not-allowed')
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || status === 401 || INVALID_KEY.test(message)) {
    return withHint('invalid-credential')
  }
  if (code === 'QUOTA' || status === 402 || QUOTA.test(message)) return withHint('quota-exhausted')
  if (code === 'RATE_LIMIT' || status === 429 || BURST.test(message)) return withHint('rate-limited')
  return undefined
}

/** Read the failure facts off a thrown value. */
export function factsOfError(error: unknown): FailureFacts {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const failure = typeof record.failure === 'object' && record.failure !== null ? record.failure as Record<string, unknown> : record
  const message = typeof failure.message === 'string'
    ? failure.message
    : error instanceof Error ? error.message : String(error)
  const facts: FailureFacts = {
    code: typeof failure.code === 'string' ? failure.code : typeof record.code === 'string' ? record.code : '',
    message,
  }
  if (typeof failure.status === 'number') facts.status = failure.status
  if (typeof failure.providerRetryAfterMs === 'number') facts.providerRetryAfterMs = failure.providerRetryAfterMs
  return facts
}
