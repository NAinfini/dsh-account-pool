/**
 * Local usage ledger: what this installation actually sent through each
 * account. Stored as hourly buckets so 24-hour, 7-day and lifetime figures all
 * aggregate from one structure; buckets older than the retention period are
 * dropped. Provider-side quota lives in the quota cache, not here.
 *
 * @module dsh-account-pool/pool/ledger
 */

import { Debouncer, readJsonSafe, writeJsonAtomic } from './persist.ts'

const HOUR_MS = 3_600_000
const VERSION = 1

/** Hourly buckets are kept this long (covers the 30-day window). */
export const LEDGER_RETENTION_MS = 35 * 24 * HOUR_MS

/** Counters for one hour of one account. */
export interface Bucket {
  requests: number
  successes: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Aggregated counters over a span, plus the cache-hit rate they imply. */
export interface UsageTotals extends Bucket {
  totalTokens: number
  /** Cache-read share of billed prompt tokens, 0–100. */
  cacheRate: number
}

const emptyBucket = (): Bucket => ({
  requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
})

/** Token counts one stream reported. */
export interface UsageSample {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

interface StoredFile {
  version: number
  /** `provider|slotId` → hour start (ms, as string) → bucket. */
  accounts: Record<string, Record<string, Bucket>>
}

/** Totals over a list of buckets. */
export function totalsOf(buckets: Iterable<Bucket>): UsageTotals {
  const sum = emptyBucket()
  for (const bucket of buckets) {
    sum.requests += bucket.requests
    sum.successes += bucket.successes
    sum.failures += bucket.failures
    sum.inputTokens += bucket.inputTokens
    sum.outputTokens += bucket.outputTokens
    sum.cacheReadTokens += bucket.cacheReadTokens
    sum.cacheWriteTokens += bucket.cacheWriteTokens
  }
  const prompt = sum.inputTokens + sum.cacheReadTokens + sum.cacheWriteTokens
  return {
    ...sum,
    totalTokens: prompt + sum.outputTokens,
    cacheRate: prompt === 0 ? 0 : (sum.cacheReadTokens / prompt) * 100,
  }
}

/** The ledger. Writes are coalesced; reads aggregate from memory. */
export class UsageLedger {
  private readonly accounts = new Map<string, Map<number, Bucket>>()
  private readonly writer: Debouncer
  private readonly path: string
  private readonly onError: (error: unknown) => void
  private readonly clock: () => number

  constructor(path: string, onError: (error: unknown) => void, clock: () => number = Date.now, debounceMs = 5_000) {
    this.path = path
    this.onError = onError
    this.clock = clock
    this.writer = new Debouncer(() => this.write(), debounceMs)
  }

  async load(): Promise<void> {
    const raw = await readJsonSafe(this.path, (error) => { this.onError(error) })
    if (typeof raw !== 'object' || raw === null) return
    const file = raw as Partial<StoredFile>
    if (file.version !== VERSION || typeof file.accounts !== 'object' || file.accounts === null) return
    const cutoff = this.clock() - LEDGER_RETENTION_MS
    for (const [account, buckets] of Object.entries(file.accounts)) {
      const map = new Map<number, Bucket>()
      for (const [hour, bucket] of Object.entries(buckets)) {
        const start = Number(hour)
        if (Number.isFinite(start) && start >= cutoff) map.set(start, { ...emptyBucket(), ...bucket })
      }
      if (map.size > 0) this.accounts.set(account, map)
    }
  }

  private bucket(account: string): Bucket {
    const hour = Math.floor(this.clock() / HOUR_MS) * HOUR_MS
    let map = this.accounts.get(account)
    if (map === undefined) {
      map = new Map()
      this.accounts.set(account, map)
    }
    let bucket = map.get(hour)
    if (bucket === undefined) {
      bucket = emptyBucket()
      map.set(hour, bucket)
      const cutoff = hour - LEDGER_RETENTION_MS
      for (const key of map.keys()) if (key < cutoff) map.delete(key)
    }
    return bucket
  }

  recordAttempt(account: string): void {
    this.bucket(account).requests += 1
    this.writer.schedule()
  }

  recordSuccess(account: string): void {
    this.bucket(account).successes += 1
    this.writer.schedule()
  }

  recordFailure(account: string): void {
    this.bucket(account).failures += 1
    this.writer.schedule()
  }

  recordUsage(account: string, usage: UsageSample): void {
    const bucket = this.bucket(account)
    bucket.inputTokens += usage.inputTokens
    bucket.outputTokens += usage.outputTokens
    bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    this.writer.schedule()
  }

  /** Totals for one account over the trailing `spanMs` (undefined = lifetime). */
  window(account: string, spanMs?: number): UsageTotals {
    const map = this.accounts.get(account)
    if (map === undefined) return totalsOf([])
    const since = spanMs === undefined ? 0 : this.clock() - spanMs
    // A bucket belongs to the span when its hour ends after the span starts.
    return totalsOf([...map].filter(([start]) => start + HOUR_MS > since).map(([, bucket]) => bucket))
  }

  async flush(): Promise<void> {
    await this.writer.flush()
  }

  private async write(): Promise<void> {
    const accounts: StoredFile['accounts'] = {}
    for (const [account, map] of this.accounts) {
      accounts[account] = Object.fromEntries([...map].map(([start, bucket]) => [String(start), bucket]))
    }
    try {
      await writeJsonAtomic(this.path, { version: VERSION, accounts } satisfies StoredFile)
    } catch (error) {
      this.onError(error)
    }
  }
}

/** Ledger account key for one slot. */
export function ledgerKey(provider: string, slotId: string): string {
  return `${provider}|${slotId}`
}
