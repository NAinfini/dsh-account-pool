import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { StateStore } from '../src/pool/state-store.ts'
import { harness, window } from './helpers.ts'

const keyOf = async (h: ReturnType<typeof harness>, options?: Parameters<typeof h.pool.acquire>[0]) =>
  (await h.pool.acquire(options))?.account.key

test('list order by default; pinned beats routed beats order', async () => {
  const h = harness(['a', 'b', 'c'])
  assert.equal(await keyOf(h), 'key-a')
  h.rules.list = [{ models: ['m1'], account: 'c' }]
  assert.equal(await keyOf(h, { model: 'm1' }), 'key-c')
  assert.equal(await keyOf(h, { model: 'other' }), 'key-a')
  h.pinned.id = 'b'
  assert.equal(await keyOf(h, { model: 'm1' }), 'key-b', 'a pin overrides model routing')
})

test('a pinned account that cannot serve falls through to the normal order', async () => {
  const h = harness(['a', 'b'])
  h.pinned.id = 'b'
  h.pool.reject('key-b', { kind: 'quota-exhausted', retryAfterMs: 60_000 })
  assert.equal(await keyOf(h), 'key-a')
})

test('preflight skips an exhausted account without persisting or counting', async () => {
  const h = harness(['a', 'b'])
  h.snapshots.set('key-a', { fetchedAt: h.now.value, windows: [window('7d', 100, { resetAt: h.now.value + 60_000 })] })
  assert.equal(await keyOf(h), 'key-b')
  assert.equal(h.store.scopes.size, 0, 'a derived skip writes no state')
  // The snapshot recovering (reset passed) puts the account straight back.
  h.now.value += 61_000
  assert.equal(await keyOf(h), 'key-a')
})

test('preflight considers every window, including 30d', async () => {
  const h = harness(['a', 'b'])
  h.snapshots.set('key-a', { fetchedAt: h.now.value, windows: [window('5h', 10), window('30d', 100, { resetAt: h.now.value + 1e9 })] })
  assert.equal(await keyOf(h), 'key-b')
})

test('ten accounts with nine exhausted still reaches the tenth', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `acc${i}`)
  const h = harness(ids)
  for (const id of ids.slice(0, 9)) {
    h.snapshots.set(`key-${id}`, { fetchedAt: h.now.value, windows: [window('5h', 100, { resetAt: h.now.value + 60_000 })] })
  }
  assert.equal(await keyOf(h), 'key-acc9')
})

test('exclude lists keys already tried; all-tried returns undefined', async () => {
  const h = harness(['a', 'b'])
  assert.equal(await keyOf(h, { exclude: new Set(['key-a']) }), 'key-b')
  assert.equal(await h.pool.acquire({ exclude: new Set(['key-a', 'key-b']) }), undefined)
})

test('a 429 does not borrow the weekly reset when every window is healthy', async () => {
  const h = harness(['a', 'b'])
  h.snapshots.set('key-a', { fetchedAt: h.now.value, windows: [window('5h', 3), window('7d', 40, { resetAt: h.now.value + 5 * 86_400_000 })] })
  h.pool.reject('key-a', { kind: 'rate-limited' })
  const state = h.store.scopes.values().next().value
  assert.equal(state?.kind, 'cooldown')
  assert.ok(state !== undefined && 'until' in state && state.until - h.now.value <= 30_000, 'a burst pause, not a week')
})

test('a 429 on an exhausted window parks the account until that window resets', async () => {
  const h = harness(['a', 'b'])
  const reset = h.now.value + 2 * 3_600_000
  h.snapshots.set('key-a', { fetchedAt: h.now.value, windows: [window('5h', 100, { resetAt: reset }), window('7d', 20, { resetAt: reset * 2 })] })
  h.pool.reject('key-a', { kind: 'quota-exhausted' })
  const state = h.store.scopes.values().next().value
  assert.equal(state?.kind === 'cooldown' && state.until, reset)
  assert.equal(state?.kind === 'cooldown' && state.window, '5h')
})

test('an unexplained quota rejection pauses, then a fresh healthy snapshot revives it early', async () => {
  const h = harness(['a', 'b'])
  h.pool.reject('key-a', { kind: 'quota-exhausted' })
  assert.equal(h.store.scopes.values().next().value?.kind, 'unknown')
  assert.equal(await keyOf(h), 'key-b')
  h.now.value += 10_000
  h.snapshots.set('key-a', { fetchedAt: h.now.value, windows: [window('5h', 12)] })
  assert.equal(await keyOf(h), 'key-a', 'a snapshot newer than the mark that shows no limit revives the account')
})

test('an unexplained pause expires on its own', async () => {
  const h = harness(['a', 'b'])
  h.pool.reject('key-a', { kind: 'quota-exhausted' })
  h.now.value += 300_001
  assert.equal(await keyOf(h), 'key-a')
})

test('keys sharing one quota scope share one cooldown', async () => {
  const h = harness(['a', 'b'])
  for (const key of ['key-a', 'key-b']) h.snapshots.set(key, { fetchedAt: h.now.value, scopeId: 'workspace-1', windows: [window('5h', 10)] })
  h.pool.reject('key-a', { kind: 'quota-exhausted', retryAfterMs: 600_000 })
  await assert.rejects(() => h.pool.acquire(), (error: unknown) => error instanceof LlmError && error.failure.code === 'RATE_LIMIT')
})

test('a 401 disables only that key; a model refusal only that model', async () => {
  const h = harness(['a', 'b'])
  h.pool.reject('key-a', { kind: 'invalid-credential' })
  assert.equal(await keyOf(h), 'key-b')
  const h2 = harness(['a', 'b'])
  h2.pool.reject('key-a', { kind: 'model-not-allowed' }, 'm1')
  assert.equal(await keyOf(h2, { model: 'm1' }), 'key-b')
  assert.equal(await keyOf(h2, { model: 'm2' }), 'key-a')
})

test('nothing can serve: RATE_LIMIT names the earliest reset; all-401 is INVALID_CREDENTIAL; no keys is MISSING_CREDENTIAL', async () => {
  const h = harness(['a', 'b'])
  h.pool.reject('key-a', { kind: 'quota-exhausted', retryAfterMs: 120_000 })
  h.pool.reject('key-b', { kind: 'quota-exhausted', retryAfterMs: 60_000 })
  await assert.rejects(() => h.pool.acquire(), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.equal(error.failure.providerRetryAfterMs, 60_000)
    return true
  })
  const dead = harness(['a'])
  dead.pool.reject('key-a', { kind: 'invalid-credential' })
  await assert.rejects(() => dead.pool.acquire(), (error: unknown) => error instanceof LlmError && error.failure.code === 'INVALID_CREDENTIAL')
  const empty = harness([])
  await assert.rejects(() => empty.pool.acquire(), (error: unknown) => error instanceof LlmError && error.failure.code === 'MISSING_CREDENTIAL')
})

test('rejection state survives a restart and never stores the key', async () => {
  const h = harness(['a', 'b'])
  h.pool.reject('key-a', { kind: 'quota-exhausted', retryAfterMs: 600_000 })
  h.pool.reject('key-b', { kind: 'invalid-credential' })
  await h.store.flush()

  const reloaded = new StateStore(h.statePath, (error) => { throw error })
  await reloaded.load(h.now.value)
  assert.equal(reloaded.scopes.size, 1)
  assert.equal(reloaded.keys.size, 1)
  const raw = JSON.stringify([...reloaded.scopes, ...reloaded.keys])
  assert.ok(!raw.includes('key-a') && !raw.includes('key-b'))
  // The restored store answers the same fingerprints.
  assert.equal(reloaded.fingerprint('x'), h.store.fingerprint('x'))
})

test('a damaged state file is treated as empty', async () => {
  const { writeFile } = await import('node:fs/promises')
  const h = harness(['a'])
  await writeFile(h.statePath, '{not json', 'utf8')
  const damaged: unknown[] = []
  const store = new StateStore(h.statePath, (error) => { damaged.push(error) })
  await store.load()
  assert.equal(store.scopes.size, 0)
  assert.equal(damaged.length, 1)
})

test('clear forgets every mark', async () => {
  const h = harness(['a'])
  h.pool.reject('key-a', { kind: 'invalid-credential' })
  await h.pool.clear()
  assert.equal(await keyOf(h), 'key-a')
})

test('clear only removes the marks of its own accounts from the shared store', async () => {
  const h = harness(['a'])
  h.store.keys.set('foreign-fingerprint', { kind: 'disabled', reason: 'r', markedAt: 1 })
  h.pool.reject('key-a', { kind: 'invalid-credential' })
  await h.pool.clear()
  assert.deepEqual([...h.store.keys.keys()], ['foreign-fingerprint'])
})

test('a key the previous run disabled is re-tested; this run\'s own marks are not', async () => {
  const probed: string[] = []
  const verdicts: Record<string, 'valid' | 'invalid' | 'unknown'> = { 'key-a': 'valid', 'key-b': 'invalid', 'key-c': 'unknown' }
  const first = harness(['a', 'b', 'c', 'd'])
  first.now.value -= 10_000
  for (const key of ['key-a', 'key-b', 'key-c', 'key-d']) first.pool.reject(key, { kind: 'invalid-credential' })
  await first.store.flush()

  const second = harness(['a', 'b', 'c', 'd'], {
    probeKey: (key) => { probed.push(key); return Promise.resolve(verdicts[key] ?? 'unknown') },
  }, first.statePath)
  await second.store.load(second.now.value)
  second.now.value += 1_000
  // Made after startup: this run's own mark, never second-guessed.
  second.pool.reject('key-d', { kind: 'invalid-credential' })
  const { pool } = second
  assert.equal((await pool.acquire())?.account.key, 'key-a', 'the revived key serves')
  assert.deepEqual(probed.sort(), ['key-a', 'key-b', 'key-c'])

  await pool.acquire()
  assert.equal(probed.filter((key) => key === 'key-b').length, 1, 'an invalid verdict is final for this run')
  second.now.value += 61_000
  await pool.acquire()
  assert.equal(probed.filter((key) => key === 'key-c').length, 2, 'an unknown verdict is retried after the spacing')
})
