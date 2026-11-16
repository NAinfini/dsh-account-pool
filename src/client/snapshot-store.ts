/**
 * One observable snapshot: the `{ getSnapshot, subscribe }` shape the slot
 * renderer turns into a `use…` hook.
 *
 * @module dsh-account-pool/client/snapshot-store
 */

export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(value) {
      if (Object.is(value, snapshot)) return
      snapshot = value
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-account-pool] snapshot subscriber failed:', error)
        }
      }
    },
  }
}
