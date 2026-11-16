/**
 * What the Host and the browser must agree on for the global account order and
 * the cross-provider `pool` route. Dependency-free: the client bundle inlines it.
 *
 * @module dsh-account-pool/pooling
 */

/** Provider id of the cross-provider route. */
export const POOL_PROVIDER = 'pool'

/** Stable key of one account in the global order: `provider:slotId`. */
export const entryKey = (provider: string, slotId: string): string => `${provider}:${slotId}`

/**
 * Stable sort by a stored order: listed items first in listed order, the rest
 * after, keeping their given relative order.
 */
export function sortByOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[] | undefined): T[] {
  const rank = new Map((order ?? []).map((key, index) => [key, index]))
  return items
    .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) ?? Infinity }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map(({ item }) => item)
}

/**
 * The id the pool route shows for a provider's model: Command Code prefixes the
 * vendor (`deepseek/deepseek-v4.1-flash`), the others do not, and the same model
 * must meet itself across providers.
 */
export const normalizeModelId = (id: string): string => id.slice(id.lastIndexOf('/') + 1)

/** Model ids served by at least two of the given providers' catalogs. */
export function sharedModelIds(catalogs: readonly (readonly string[])[]): string[] {
  const counts = new Map<string, number>()
  for (const catalog of catalogs) {
    for (const id of new Set(catalog.map(normalizeModelId))) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count >= 2).map(([id]) => id)
}
