/**
 * The rotation loop shared by every route: take an account from a source, bind
 * its key to one inner stream, attribute usage to it, and — when the provider
 * rejects the request before anything was streamed — mark the account and try
 * the next one.
 *
 * Rotation is only ever pre-stream: once a chunk has reached the caller a
 * failure is surfaced as it is, never replayed on another account.
 *
 * @module dsh-account-pool/providers/rotate
 */

import { LlmError, type GenerateOptions, type LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { RETRY_MAX_DELAY_MS, type AccountPool } from '../pool/account-pool.ts'
import { withBoundKey } from '../pool/call-key.ts'
import { ledgerKey, type UsageLedger } from '../pool/ledger.ts'
import { classifyFailure, factsOfError } from '../pool/rejection.ts'
import type { FailureFacts, ProviderId } from '../pool/types.ts'

/** One account chosen to serve one attempt. */
export interface Attempt {
  /** Identity for the "already tried" set; unique across everything the source can offer. */
  id: string
  key: string
  slotId: string
  provider: ProviderId
  pool: AccountPool
  /** The adapter that owns the wire protocol for this provider. */
  inner: LlmAdapter
  /** The request as this provider must see it. */
  options: GenerateOptions
}

export interface AttemptSource {
  /**
   * The next account to try, `undefined` once everything offered was tried.
   * Throws when accounts remain but none can serve (the thrown error is the
   * better instruction for the harness retry policy than a raw rejection).
   */
  next(tried: ReadonlySet<string>): Promise<Attempt | undefined>
}

/**
 * The pool reads the provider's full wait, but the harness abandons (rather
 * than clamps) a retry whose attached wait exceeds the policy cap, so a longer
 * wait must not travel upstream on a surfaced failure.
 */
function withinRetryCap(error: unknown): unknown {
  if (!(error instanceof LlmError)) return error
  const wait = error.failure.providerRetryAfterMs
  if (wait === undefined || wait <= RETRY_MAX_DELAY_MS) return error
  return new LlmError(error.message, error.failure.code, {
    ...(error.failure.status === undefined ? {} : { status: error.failure.status }),
    cause: error,
  })
}

function chunkWithinRetryCap(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  const { providerRetryAfterMs, ...failure } = chunk.reason.failure
  if (providerRetryAfterMs === undefined || providerRetryAfterMs <= RETRY_MAX_DELAY_MS) return chunk
  return { ...chunk, reason: { ...chunk.reason, failure } }
}

export async function* rotateStream(
  source: AttemptSource,
  ledger: UsageLedger,
  onRotate?: (info: { slotId: string; reason: string }) => void,
): AsyncGenerator<StreamChunk, void, undefined> {
  const tried = new Set<string>()
  /** The last rotatable failure, surfaced when every account has been tried. */
  let last: { chunk: StreamChunk | undefined; error: unknown } | undefined

  while (true) {
    const attempt = await source.next(tried)
    if (attempt === undefined) break
    const { pool, inner, options } = attempt
    const ledgerId = ledgerKey(attempt.provider, attempt.slotId)
    ledger.recordAttempt(ledgerId)

    let yielded = false
    let failure: FailureFacts | undefined
    let failureChunk: StreamChunk | undefined
    let failureError: unknown
    try {
      for await (const chunk of withBoundKey(attempt.key, () => inner.stream(options))) {
        if (chunk.type === 'usage') {
          ledger.recordUsage(ledgerId, chunk.usage)
          yield chunk
          continue
        }
        // pi-ai reports provider failures as a terminal error finish, not a throw.
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure
          failureChunk = chunk
          break
        }
        yielded = true
        yield chunk
      }
    } catch (error: unknown) {
      failure = factsOfError(error)
      failureError = error
    }

    if (failure === undefined) {
      ledger.recordSuccess(ledgerId)
      return
    }
    ledger.recordFailure(ledgerId)
    const rejection = classifyFailure(failure)
    if (rejection !== undefined) pool.reject(attempt.key, rejection, options.model)
    if (yielded || rejection === undefined) {
      // Surface exactly what the provider said.
      if (failureChunk !== undefined) {
        yield chunkWithinRetryCap(failureChunk)
        return
      }
      throw withinRetryCap(failureError)
    }
    tried.add(attempt.id)
    last = { chunk: failureChunk, error: failureError }
    onRotate?.({ slotId: attempt.slotId, reason: rejection.kind })
  }

  // Every account was tried and rejected the request.
  if (last?.chunk !== undefined) {
    yield chunkWithinRetryCap(last.chunk)
    return
  }
  throw withinRetryCap(last?.error) ?? new Error('llm-account-pool: no account could serve the request')
}
