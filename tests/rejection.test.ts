import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyFailure, retryHintOf } from '../src/pool/rejection.ts'

const kind = (facts: Parameters<typeof classifyFailure>[0]) => classifyFailure(facts)?.kind

test('401 and missing subscription are key-level', () => {
  assert.equal(kind({ code: 'INVALID_CREDENTIAL', message: '' }), 'invalid-credential')
  assert.equal(kind({ code: '', message: 'HTTP 401 Unauthorized' }), 'invalid-credential')
  assert.equal(kind({ code: '', status: 403, message: 'OpenCode Go subscription required' }), 'invalid-credential')
})

test('a model-level 403 never disables the key', () => {
  assert.equal(kind({ code: '', status: 403, message: 'MODEL_NOT_IN_PLAN: this model is not in your plan' }), 'model-not-allowed')
  assert.equal(kind({ code: 'MODEL_NOT_IN_PLAN', message: 'nope' }), 'model-not-allowed')
})

test('a quota wording wins over a bare 429', () => {
  assert.equal(kind({ code: '', status: 429, message: 'GoUsageLimitError: Resets in 3 days' }), 'quota-exhausted')
  assert.equal(kind({ code: '', message: 'Upstream request failed: [insufficient balance]' }), 'quota-exhausted')
})

test('a plain 429 is a burst limit', () => {
  assert.equal(kind({ code: 'RATE_LIMIT', message: 'slow down' }), 'rate-limited')
  assert.equal(kind({ code: '', status: 429, message: 'Too Many Requests' }), 'rate-limited')
})

test('transport faults and 5xx say nothing about the key', () => {
  assert.equal(kind({ code: 'TRANSPORT', message: 'ECONNRESET' }), undefined)
  assert.equal(kind({ code: 'SERVER', status: 520, message: 'Upstream model provider is temporarily unavailable' }), undefined)
})

test('reset hints are read from structure first, then wording', () => {
  assert.equal(retryHintOf({ message: 'x', providerRetryAfterMs: 5_000 }), 5_000)
  assert.equal(retryHintOf({ message: 'Resets in 3 days' }), 3 * 86_400_000)
  assert.equal(retryHintOf({ message: 'please retry after 30 seconds' }), 30_000)
  assert.equal(retryHintOf({ message: 'no hint here' }), undefined)
})
