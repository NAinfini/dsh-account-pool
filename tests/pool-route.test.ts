import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type LlmAdapter, type LlmModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { boundKey } from '../src/pool/call-key.ts'
import { UsageLedger } from '../src/pool/ledger.ts'
import { entryKey, normalizeModelId, sharedModelIds, sortByOrder } from '../src/pooling.ts'
import { PoolRouteAdapter } from '../src/providers/pool-route.ts'
import type { ProviderHandle } from '../src/providers/pool-wiring.ts'
import { harness, tempDir } from './helpers.ts'

interface Call { provider: string; model: string; key: string }

/** One provider: its own pool, a catalog, and an inner adapter that records what it was asked. */
function member(provider: 'opencode' | 'commandcode', ids: string[], models: string[], calls: Call[], limited: Set<string> = new Set()) {
  const h = harness(ids, { provider })
  const inner = {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      const key = boundKey() ?? 'none'
      calls.push({ provider: options.provider, model: options.model, key })
      if (limited.has(key)) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'Too Many Requests' } } } as StreamChunk
        return
      }
      yield { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
    },
  } as unknown as LlmAdapter
  const handle: ProviderHandle = {
    provider,
    displayName: provider,
    pool: h.pool,
    inner,
    slots: () => h.slots.list,
    apiBase: () => 'https://x.test',
    pinned: () => h.pinned.id,
    quota: () => Promise.resolve({ windows: [], fetchedAt: h.now.value }),
    models: () => Promise.resolve(models.map((id): LlmModelInfo => ({ provider, id, name: id }))),
  }
  return { h, handle }
}

function route(order: string[], calls: Call[], limited: Set<string> = new Set()) {
  const oc = member('opencode', ['a', 'b'], ['deepseek-v4.1-flash', 'glm-5.1'], calls, limited)
  const cc = member('commandcode', ['a'], ['deepseek/deepseek-v4.1-flash', 'qwen/only-here'], calls, limited)
  const ledger = new UsageLedger(join(tempDir(), 'ledger.json'), (error) => { throw error }, () => oc.h.now.value)
  const adapter = new PoolRouteAdapter({ members: [oc.handle, cc.handle], ledger, order: () => order, now: () => oc.h.now.value })
  return { oc, cc, adapter, ledger }
}

const request = (): GenerateOptions => ({ provider: 'pool', model: 'deepseek-v4.1-flash', messages: [] })

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('ordering helpers: listed first in listed order, the rest keep their order; ids meet across providers', () => {
  assert.deepEqual(sortByOrder(['x', 'y', 'z', 'w'], (item) => item, ['z', 'x']), ['z', 'x', 'y', 'w'])
  assert.equal(entryKey('opencode', 'A'), 'opencode:A')
  assert.equal(normalizeModelId('deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(normalizeModelId('glm-5.1'), 'glm-5.1')
  assert.deepEqual(sharedModelIds([['deepseek/m', 'only-a'], ['m', 'only-b']]), ['m'])
})

test('the pool route lists only models at least two providers serve, under the neutral id', async () => {
  const { adapter } = route([], [])
  const models = await adapter.listModels('pool')
  assert.deepEqual(models.map((model) => [model.provider, model.id]), [['pool', 'deepseek-v4.1-flash']])
})

test('requests walk the global order across providers and use each provider\'s own model id', async () => {
  const calls: Call[] = []
  const { adapter } = route(['commandcode:a', 'opencode:b', 'opencode:a'], calls)
  await collect(adapter.stream(request()))
  assert.deepEqual(calls, [{ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', key: 'key-a' }])
})

test('a limited account hands the request to the next one in order, even in another provider, and is parked', async () => {
  const calls: Call[] = []
  const { adapter, oc } = route(['opencode:b', 'commandcode:a', 'opencode:a'], calls, new Set(['key-b']))
  await collect(adapter.stream(request()))
  assert.deepEqual(calls.map((call) => `${call.provider}:${call.key}`), ['opencode:key-b', 'commandcode:key-a'])
  const [b] = await oc.h.pool.resolved()
  assert.equal(b?.slot.id === 'a' ? oc.h.pool.skipReason(b) === undefined : true, true)
  assert.equal((await oc.h.pool.servable()).map((account) => account.slot.id).includes('b'), false, 'the rejected account is parked')
})

test('a pinned account goes first whatever the order says', async () => {
  const calls: Call[] = []
  const { adapter, oc } = route(['commandcode:a', 'opencode:a', 'opencode:b'], calls)
  oc.h.pinned.id = 'b'
  await collect(adapter.stream(request()))
  assert.equal(calls[0]?.key, 'key-b')
})

test('when every account is at its limit the pool route names the earliest reset', async () => {
  const calls: Call[] = []
  const { adapter, oc, cc } = route([], calls)
  for (const key of ['key-a', 'key-b']) oc.h.pool.reject(key, { kind: 'quota-exhausted', retryAfterMs: 120_000 })
  cc.h.pool.reject('key-a', { kind: 'quota-exhausted', retryAfterMs: 60_000 })
  await assert.rejects(() => collect(adapter.stream(request())), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.equal(error.failure.providerRetryAfterMs, 60_000)
    return true
  })
  assert.equal(calls.length, 0)
})
