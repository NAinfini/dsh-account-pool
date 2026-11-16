import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { boundKey } from '../src/pool/call-key.ts'
import { UsageLedger } from '../src/pool/ledger.ts'
import { RotatingAdapter } from '../src/providers/openai-compat/rotating-adapter.ts'
import { harness, tempDir } from './helpers.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

type Behaviour = (key: string) => 'ok' | { error: { code: string; message: string; status?: number } }

/** A stand-in for the pi-ai adapter that reads its key the way the real one does. */
function fakeInner(behaviour: Behaviour, seen: string[][] = []): PiAiAdapter {
  return {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      const keys: string[] = []
      seen.push(keys)
      keys.push(boundKey() ?? 'none')
      await tick()
      keys.push(boundKey() ?? 'none')
      const outcome = behaviour(keys[0] ?? 'none')
      if (outcome !== 'ok') {
        yield { type: 'finish', reason: { kind: 'error', failure: outcome.error } } as StreamChunk
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
      await tick()
      keys.push(boundKey() ?? 'none')
      yield { type: 'text-delta', index: 0, text: `served:${options.model}` } as StreamChunk
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
    },
  } as unknown as PiAiAdapter
}

function make(ids: string[], behaviour: Behaviour, seen?: string[][]) {
  const h = harness(ids)
  const ledger = new UsageLedger(join(tempDir(), 'ledger.json'), (error) => { throw error }, () => h.now.value)
  const adapter = new RotatingAdapter({ provider: 'opencode', inner: fakeInner(behaviour, seen), pool: h.pool, ledger, })
  return { h, ledger, adapter }
}

const options = (model = 'm'): GenerateOptions => ({ provider: 'opencode', model, messages: [] })

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('interleaved requests each keep their own key for their whole stream', async () => {
  const seen: string[][] = []
  const { h, adapter, ledger } = make(['a', 'b'], () => 'ok', seen)
  // Pin nothing: both requests would pick `a` — route the second to `b`.
  h.rules.list = [{ models: ['second'], account: 'b' }]
  const [first, second] = await Promise.all([collect(adapter.stream(options('first'))), collect(adapter.stream(options('second')))])
  assert.equal(first.length > 0 && second.length > 0, true)
  const byKey = seen.map((keys) => [...new Set(keys)])
  assert.deepEqual(byKey.map((keys) => keys.length), [1, 1], 'a stream never sees another stream\'s key')
  assert.deepEqual(new Set(byKey.flat()), new Set(['key-a', 'key-b']))
  assert.equal(ledger.window('opencode|a').requests, 1)
  assert.equal(ledger.window('opencode|b').requests, 1)
  assert.equal(ledger.window('opencode|a').inputTokens, 10)
})

test('a pre-stream 429 rotates to the next account and marks the first', async () => {
  const { h, adapter, ledger } = make(['a', 'b'], (key) => key === 'key-a'
    ? { error: { code: 'RATE_LIMIT', status: 429, message: 'GoUsageLimitError: Resets in 2 hours' } }
    : 'ok')
  const chunks = await collect(adapter.stream(options()))
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  const state = h.store.scopes.values().next().value
  assert.equal(state?.kind, 'cooldown')
  assert.equal(ledger.window('opencode|a').failures, 1)
  assert.equal(ledger.window('opencode|b').successes, 1)
})

test('when every account rejects, the last provider failure is surfaced once', async () => {
  const { adapter } = make(['a', 'b'], () => ({ error: { code: 'RATE_LIMIT', status: 429, message: 'Too Many Requests' } }))
  const chunks = await collect(adapter.stream(options()))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.type, 'finish')
})

test('a failure that says nothing about the key is surfaced without rotating', async () => {
  const { h, adapter } = make(['a', 'b'], () => ({ error: { code: 'TRANSPORT', message: 'ECONNRESET' } }))
  const chunks = await collect(adapter.stream(options()))
  assert.equal(chunks[0]?.type, 'finish')
  assert.equal(h.store.scopes.size, 0)
})

test('a model-level refusal tries another account but keeps the first usable for other models', async () => {
  const { adapter, h } = make(['a', 'b'], (key) => key === 'key-a'
    ? { error: { code: '', status: 403, message: 'MODEL_NOT_IN_PLAN' } }
    : 'ok')
  const chunks = await collect(adapter.stream(options('pro')))
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  assert.equal(h.store.keys.size, 0, 'the key is not disabled')
})
