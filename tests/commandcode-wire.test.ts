import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'

import { parseCredits } from '../src/providers/commandcode/driver.ts'
import {
  createAssembler, handleEvent, httpError, messagesToWire, parseCatalog, parseEventLine, parseRetryAfterMs,
  systemTextOf, toolParametersSchema,
} from '../src/providers/commandcode/wire.ts'

const msg = (value: unknown): RequestMessage => value as RequestMessage
const text = (t: string) => ({ type: 'text', text: t })
const call = (id: string, name = 'read', args = '{"path":"a"}') => ({ type: 'tool-call', id, name, arguments: args })

test('tool schemas always reach the gateway with an object root', () => {
  assert.deepEqual(toolParametersSchema(undefined), { type: 'object', properties: {}, additionalProperties: true })
  assert.deepEqual(toolParametersSchema({}), { type: 'object', properties: {}, additionalProperties: true })
  assert.equal(toolParametersSchema({ properties: { a: { type: 'string' } } }).type, 'object')
  const original = { type: 'object', properties: { a: {} } }
  const kept = toolParametersSchema(original)
  assert.deepEqual(kept, original)
  assert.notEqual(kept, original, 'a copy, never the frozen original')
  const withRef = toolParametersSchema({ $ref: '#/$defs/args', $defs: { args: { type: 'object', properties: { x: {} }, required: ['x'] } } })
  assert.deepEqual(Object.keys(withRef.properties as object), ['x'])
  const anyOf = toolParametersSchema({ anyOf: [{ type: 'object', properties: { a: {} }, required: ['a'] }, { type: 'object', properties: { b: {} }, required: ['a', 'b'] }] })
  assert.deepEqual(anyOf.required, ['a'], 'only what every alternative demands stays required')
  assert.deepEqual(Object.keys(anyOf.properties as object).sort(), ['a', 'b'])
  const cyclic: Record<string, unknown> = { $ref: '#/$defs/a', $defs: {} }
  ;(cyclic.$defs as Record<string, unknown>).a = { $ref: '#/$defs/a' }
  assert.equal(toolParametersSchema(cyclic).type, 'object', 'a self-referential schema degrades instead of spinning')
})

test('only tool calls with a result are replayed, and results without a call are dropped', () => {
  const wire = messagesToWire([
    msg({ role: 'user', content: [text('hi')] }),
    msg({ role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, text('ok'), call('c1'), call('c2')] }),
    msg({ role: 'tool', toolCallId: 'c1', content: [text('result one')] }),
    msg({ role: 'tool', toolCallId: 'ghost', content: [text('orphan')] }),
  ]) as { role: string; content: Record<string, unknown>[] }[]
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'tool'])
  const assistant = wire[1]?.content ?? []
  assert.deepEqual(assistant.map((p) => p.type), ['reasoning', 'text', 'tool-call'], 'reasoning replays in order; the unanswered call is dropped')
  assert.equal(assistant[2]?.toolCallId, 'c1')
  assert.deepEqual(assistant[2]?.input, { path: 'a' })
  const result = wire[2]?.content[0]
  assert.equal(result?.toolName, 'read')
  assert.deepEqual(result?.output, { type: 'text', value: 'result one' })
})

test('a failed tool result is sent as error text; empty user messages and system messages are not sent', () => {
  const wire = messagesToWire([
    msg({ role: 'system', content: [text('sys')] }),
    msg({ role: 'user', content: [] }),
    msg({ role: 'assistant', content: [call('c1')] }),
    msg({ role: 'tool', toolCallId: 'c1', isError: true, content: [text('boom')] }),
  ]) as { role: string; content: Record<string, unknown>[] }[]
  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'tool'])
  assert.deepEqual(wire[1]?.content[0]?.output, { type: 'error-text', value: 'boom' })
  assert.equal(systemTextOf([msg({ role: 'system', content: [text('sys')] })], 'one-shot'), 'one-shot\n\nsys')
})

test('over-long tool call ids are remapped to the same short id on both sides', () => {
  const longId = 'call_' + 'x'.repeat(100)
  const wire = messagesToWire([
    msg({ role: 'assistant', content: [call(longId)] }),
    msg({ role: 'tool', toolCallId: longId, content: [text('r')] }),
  ]) as { content: Record<string, unknown>[] }[]
  const callId = wire[0]?.content[0]?.toolCallId as string
  assert.ok(callId.length <= 64)
  assert.equal(wire[1]?.content[0]?.toolCallId, callId)
})

const run = (events: unknown[]): StreamChunk[] => {
  const asm = createAssembler()
  return events.flatMap((event) => handleEvent(asm, event))
}

test('stream events assemble blocks in order and report disjoint usage', () => {
  const chunks = run([
    { type: 'reasoning-delta', text: 'a' },
    { type: 'text-delta', text: 'b' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'read', input: { p: 1 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 100, outputTokens: 7, inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 10 } } },
  ])
  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end',
    'block-start', 'tool-call-delta', 'block-end', 'usage', 'finish',
  ])
  const usage = chunks.find((c) => c.type === 'usage')
  assert.deepEqual(usage?.type === 'usage' && usage.usage, { inputTokens: 30, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 10 })
  const finish = chunks.at(-1)
  assert.deepEqual(finish?.type === 'finish' && finish.reason, { kind: 'tool-calls' })
})

test('in-band errors keep their retry semantics', () => {
  const failure = (event: unknown): LlmError => {
    try { run([event]) } catch (error) { return error as LlmError }
    throw new Error('expected a throw')
  }
  assert.equal(failure({ type: 'error', error: { message: 'prompt is too long' } }).failure.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.equal(failure({ type: 'error', error: { message: 'premium_credits_exhausted' } }).failure.code, 'PROVIDER_STREAM_ERROR')
  assert.equal(failure({ type: 'error', error: { message: 'upstream blip', statusCode: 503 } }).failure.code, 'SERVER')
  assert.equal(failure({ type: 'error', error: { message: 'nope', statusCode: 400 } }).failure.code, 'PROVIDER_STREAM_ERROR')
})

test('pre-stream HTTP rejections map to stable codes', () => {
  assert.equal(httpError(401, '', undefined).failure.code, 'INVALID_CREDENTIAL')
  assert.equal(httpError(413, '', undefined).failure.code, 'PROVIDER_HTTP_ERROR')
  assert.equal(httpError(520, '<html>Upstream model provider is temporarily unavailable</html>', undefined).failure.code, 'SERVER')
  assert.equal(httpError(400, JSON.stringify({ error: { message: 'prompt is too long' } }), undefined).failure.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  const limited = httpError(429, '', 30_000)
  assert.equal(limited.failure.code, 'RATE_LIMIT')
  assert.equal(limited.failure.providerRetryAfterMs, 30_000)
  assert.equal(httpError(429, '', 7_200_000).failure.providerRetryAfterMs, 7_200_000, 'a long wait is kept so the pool can park the account')
  const forbidden = httpError(403, JSON.stringify({ error: { code: 'MODEL_NOT_IN_PLAN', message: 'upgrade' } }), undefined)
  assert.match(forbidden.message, /MODEL_NOT_IN_PLAN/)
})

test('event lines tolerate SSE framing and noise', () => {
  assert.deepEqual(parseEventLine('data: {"type":"finish"}'), { type: 'finish' })
  assert.equal(parseEventLine(': keep-alive'), undefined)
  assert.equal(parseEventLine('data: [DONE]'), undefined)
  assert.equal(parseEventLine('{broken'), undefined)
  assert.equal(parseRetryAfterMs('12'), 12_000)
  assert.equal(parseRetryAfterMs('soon'), undefined)
})

test('catalog parsing rejects anything that is not a model list', () => {
  const models = parseCatalog({ object: 'list', data: [{ id: 'a', name: 'A', context_length: 1000 }, { id: 'bad' }] })
  assert.deepEqual(models, [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 1000 }])
  assert.throws(() => parseCatalog({ object: 'list', data: [] }))
  assert.throws(() => parseCatalog({}))
})

test('credits: absent windows stay absent; uncapped has no percentage; seconds become ms', () => {
  const snapshot = parseCredits({
    windowLimits: { fiveHour: { used: 0.12, cap: 3, exceeded: false, resetAt: 1_790_000_000 }, weekly: { used: 5, cap: 0, exceeded: false, resetAt: 1_790_000_000_000 } },
  }, 1)
  const [five, weekly] = snapshot.windows
  assert.equal(five?.percent, 4)
  assert.equal(five?.resetAt, 1_790_000_000_000)
  assert.equal(weekly?.percent, undefined)
  assert.equal(weekly?.cap, 0)
  assert.equal(parseCredits({ credits: { monthlyCredits: 1 } }, 1).windows.length, 0)
  const exhausted = parseCredits({ windowLimits: { fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: 1_790_000_000_000 } } }, 1)
  assert.equal(exhausted.windows[0]?.status, 'limited')
  assert.equal(exhausted.windows[0]?.percent, 100)
  assert.throws(() => parseCredits({}, 1))
})
