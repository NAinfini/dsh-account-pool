/**
 * The only place provider differences are allowed to live. The pool, the
 * ledger, rotation and the UI never branch on a provider id; they ask the
 * driver.
 *
 * @module dsh-account-pool/providers/driver
 */

import type { ProviderId, QuotaSnapshot } from '../pool/types.ts'

/** What a driver needs to read one account's quota. */
export interface QuotaRequest {
  apiBase: string
  /** The model key of the account. */
  key: string
  /** Separate control-plane key, for providers that meter on another API. */
  controlKey?: string | undefined
  /** The plan's monthly allowance in USD, for providers that report percentages only. */
  monthlyUsd?: number | undefined
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface ProviderDriver {
  readonly id: ProviderId
  readonly displayName: string
  /** Read one account's windows; throws on transport or parse failure. */
  fetchQuota(request: QuotaRequest): Promise<QuotaSnapshot>
}
