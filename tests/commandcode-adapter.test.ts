import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { withBoundKey } from '../src/pool/call-key.ts'
import { UsageLedger } from '../src/pool/ledger.ts'
import { CommandCodeAdapter } from '../src/providers/commandcode/adapter.ts'
import { RotatingAdapter } from '../src/providers/openai-compat/rotating-adapter.ts'
import { harness, tempDir } from './helpers.ts'

interface Seen { url: string; headers: Record<string, string>; body: { params: Record<string, unknown> } }

const encoder = new TextEncoder()

function jsonl(...events: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const happy = (): Response => jsonl(
  { type: 'text-delta', text: 'hello' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 2 } },
)

function adapter(respond: (key: string) => Response, seen: Seen[] = []): CommandCodeAdapter {
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    seen.push({ url, headers, body: JSON.parse(String(init.body)) as Seen['body'] })
    return Promise.resolve(respond(headers.Authorization?.replace('Bearer ', '') ?? ''))
  }) as typeof fetch
  return new CommandCodeAdapter({
    provider: 'commandcode',
    displayName: 'Command Code',
    apiBase: () => 'https://cc.test',
    workingDir: () => '/work/My Project',
    requestTimeoutMs: () => undefined,
    streamIdleTimeoutMs: () => undefined,
    models: () => [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 65_536 }],
    fetchImpl,
  })
}

const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as unknown as GenerateOptions['messages'],
  ...extra,
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const bound = (key: string, stream: () => AsyncIterable<StreamChunk>) => withBoundKey(key, stream)

test('the request carries the bound key, the CLI headers and a CLI body', async () => {
  const seen: Seen[] = []
  const chunks = await collect(bound('sk-1', () => adapter(happy, seen).stream(options({ reasoningEffort: 'high' as never, maxTokens: 1234 }))))
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  const [call] = seen
  assert.equal(call?.url, 'https://cc.test/alpha/generate')
  assert.equal(call?.headers.Authorization, 'Bearer sk-1')
  assert.equal(call?.headers['x-project-slug'], 'work-my-project')
  assert.equal(call?.body.params.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(call?.body.params.max_tokens, 1234)
  assert.equal(call?.body.params.reasoning_effort, 'high')
  assert.equal(call?.body.params.stream, true)
})

test('an effort the model does not offer is omitted', async () => {
  const seen: Seen[] = []
  await collect(bound('k', () => adapter(happy, seen).stream(options({ reasoningEffort: 'xhigh' as never }))))
  assert.equal('reasoning_effort' in (seen[0]?.body.params ?? {}), false)
})

test('no bound key is a missing credential, never a silent anonymous request', async () => {
  const seen: Seen[] = []
  await assert.rejects(() => collect(adapter(happy, seen).stream(options())), (error: unknown) => error instanceof LlmError && error.failure.code === 'MISSING_CREDENTIAL')
  assert.equal(seen.length, 0)
})

test('a 401 is thrown as INVALID_CREDENTIAL and a stream with no finish is a transport failure', async () => {
  await assert.rejects(
    () => collect(bound('k', () => adapter(() => new Response('', { status: 401 })).stream(options()))),
    (error: unknown) => error instanceof LlmError && error.failure.code === 'INVALID_CREDENTIAL',
  )
  await assert.rejects(
    () => collect(bound('k', () => adapter(() => jsonl({ type: 'text-delta', text: 'partial' })).stream(options()))),
    (error: unknown) => error instanceof LlmError && error.failure.code === 'TRANSPORT',
  )
})

test('models and reasoning metadata come from the catalog and the effort table', async () => {
  const inner = adapter(happy)
  const listed = await inner.listModels('commandcode')
  assert.deepEqual(listed.map((model) => model.id), ['deepseek/deepseek-v4.1-flash'])
  assert.deepEqual(listed[0]?.inputModalities, ['text'])
  const resolved = await inner.resolveModel('commandcode', 'deepseek/deepseek-v4.1-flash')
  assert.equal(resolved.context?.contextWindow, 1_000_000)
  assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high', 'max'])
  const unknown = await inner.resolveModel('commandcode', 'some/new-model')
  assert.equal(unknown.reasoning, undefined)
})

test('rotation: a 429 on the first account moves the same request to the second, over the real wire code', async () => {
  const seen: Seen[] = []
  const h = harness(['a', 'b'])
  const ledger = new UsageLedger(join(tempDir(), 'ledger.json'), (error) => { throw error }, () => h.now.value)
  const rotating = new RotatingAdapter({
    provider: 'commandcode',
    inner: adapter((key) => key === 'key-a'
      ? new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), { status: 429, headers: { 'retry-after': '7200' } })
      : happy(), seen),
    pool: h.pool,
    ledger,
  })
  const chunks = await collect(rotating.stream(options()))
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  assert.deepEqual(seen.map((call) => call.headers.Authorization), ['Bearer key-a', 'Bearer key-b'])
  const state = h.store.scopes.values().next().value
  assert.equal(state?.kind, 'cooldown')
  assert.ok(state !== undefined && 'until' in state && state.until - h.now.value === 7_200_000, 'the provider-named wait is honoured')
  assert.equal(ledger.window('commandcode|b').inputTokens, 10)
})

test('a wait longer than the harness retry cap is learned by the pool but never sent upstream', async () => {
  const h = harness(['a'])
  const ledger = new UsageLedger(join(tempDir(), 'ledger.json'), (error) => { throw error }, () => h.now.value)
  const rotating = new RotatingAdapter({
    provider: 'commandcode',
    inner: adapter(() => new Response('', { status: 429, headers: { 'retry-after': '7200' } })),
    pool: h.pool,
    ledger,
  })
  await assert.rejects(() => collect(rotating.stream(options())), (error: unknown) => {
    return error instanceof LlmError && error.failure.code === 'RATE_LIMIT' && error.failure.providerRetryAfterMs === undefined
  })
  const state = h.store.scopes.values().next().value
  assert.ok(state !== undefined && 'until' in state && state.until - h.now.value === 7_200_000)
})
