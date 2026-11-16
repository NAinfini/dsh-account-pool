/**
 * Per-call key binding.
 *
 * The wrapped pi-ai adapter asks for its API key through one adapter-wide
 * callback, which cannot tell concurrent requests apart. A global queue of
 * "who is asking" breaks as soon as two requests interleave (sub-agents, two
 * sessions), attributing a key, a usage sample or a 429 to the wrong request.
 *
 * Here the pool chooses the key *before* the inner stream starts and binds it
 * to that one stream through AsyncLocalStorage: the callback reads the key from
 * the async context, so it is correct by construction however many requests
 * run at once.
 *
 * Every `next()` on the inner iterator is run inside the binding. That is what
 * makes it hold for async generators, whose body runs under the context of the
 * caller of `next()`, not the context where the generator object was created.
 *
 * @module dsh-account-pool/pool/call-key
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const bound = new AsyncLocalStorage<{ key: string }>()

/** The key bound to the current inner stream, if any. */
export function boundKey(): string | undefined {
  return bound.getStore()?.key
}

/** Iterate `source` with `key` bound for the whole iteration. */
export async function* withBoundKey<T>(key: string, source: () => AsyncIterable<T>): AsyncGenerator<T, void, undefined> {
  const store = { key }
  const iterator = bound.run(store, () => source()[Symbol.asyncIterator]())
  try {
    while (true) {
      const step = await bound.run(store, () => iterator.next())
      if (step.done === true) return
      yield step.value
    }
  } finally {
    await bound.run(store, async () => { await iterator.return?.() })
  }
}
