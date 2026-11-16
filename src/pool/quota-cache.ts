/**
 * Quota snapshot cache. One entry per allowance identity
 * (`provider | apiBase | key`), a short TTL, a single in-flight fetch per
 * entry, and a brief negative cache so a flapping endpoint is not hammered.
 *
 * The cache answers two different questions: `peek` (synchronous, never
 * touches the network — what the request path uses) and `get` (may fetch — what
 * the UI and the background refresher use).
 *
 * @module dsh-account-pool/pool/quota-cache
 */

import type { QuotaSnapshot, QuotaWindow } from './types.ts'

/** How long one fetched snapshot stays fresh. */
export const QUOTA_TTL_MS = 30_000

/** A failed fetch is retried after this long, not on every poll. */
export const QUOTA_FAILURE_TTL_MS = 5_000

/** Fetches one snapshot; throws on any failure (the cache records it). */
export type QuotaFetcher = () => Promise<QuotaSnapshot>

interface Entry {
  snapshot: QuotaSnapshot
  /** When this entry stops being served without a refetch. */
  freshUntil: number
}

export class QuotaCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<QuotaSnapshot>>()
  /** Bumped by `clear()`; a fetch that started before a clear never lands. */
  private generation = 0
  private readonly ttlMs: number
  private readonly clock: () => number

  constructor(ttlMs: number = QUOTA_TTL_MS, clock: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.clock = clock
  }

  /** The last known snapshot, however old; never fetches. */
  peek(id: string): QuotaSnapshot | undefined {
    return this.entries.get(id)?.snapshot
  }

  /** Whether `peek(id)` would be served without a refetch. */
  fresh(id: string): boolean {
    const entry = this.entries.get(id)
    return entry !== undefined && this.clock() < entry.freshUntil
  }

  /** The snapshot for `id`, refetching when stale; concurrent callers share one fetch. */
  get(id: string, fetcher: QuotaFetcher): Promise<QuotaSnapshot> {
    const entry = this.entries.get(id)
    if (entry !== undefined && this.clock() < entry.freshUntil) return Promise.resolve(entry.snapshot)
    const running = this.inFlight.get(id)
    if (running !== undefined) return running
    const generation = this.generation
    const task = this.fetch(id, fetcher, generation).finally(() => {
      if (this.inFlight.get(id) === task) this.inFlight.delete(id)
    })
    this.inFlight.set(id, task)
    return task
  }

  private async fetch(id: string, fetcher: QuotaFetcher, generation: number): Promise<QuotaSnapshot> {
    const now = this.clock()
    let snapshot: QuotaSnapshot
    let ttl = this.ttlMs
    try {
      snapshot = await fetcher()
    } catch (error) {
      // Keep the last good windows (marked stale by `fetchedAt`) and say why.
      const previous = this.entries.get(id)?.snapshot
      snapshot = {
        windows: previous?.windows ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        ...(previous?.scopeId === undefined ? {} : { scopeId: previous.scopeId }),
        error: error instanceof Error ? error.message : String(error),
      }
      ttl = QUOTA_FAILURE_TTL_MS
    }
    if (generation === this.generation) this.entries.set(id, { snapshot, freshUntil: now + ttl })
    return snapshot
  }

  /** Forget everything, including fetches already in flight. */
  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.inFlight.clear()
  }
}

/** The first window that is limited or at/over `thresholdPercent`, if any. */
export function exhaustedWindow(snapshot: QuotaSnapshot | undefined, thresholdPercent: number): QuotaWindow | undefined {
  if (snapshot === undefined) return undefined
  return snapshot.windows.find((window) =>
    window.status === 'limited' || (window.percent !== undefined && window.percent >= thresholdPercent))
}
