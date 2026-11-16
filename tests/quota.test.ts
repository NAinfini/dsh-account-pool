import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { UsageLedger } from '../src/pool/ledger.ts'
import { QuotaCache } from '../src/pool/quota-cache.ts'
import { parseOpenCodeUsage } from '../src/providers/opencode/driver.ts'
import { tempDir } from './helpers.ts'

test('opencode usage: absent windows are absent, missing percent is not zero', () => {
  const snapshot = parseOpenCodeUsage({
    usage: {
      rolling: { status: 'ok', percent: 25, resetsAt: '2026-10-19T12:00:00Z' },
      weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-22T00:00:00Z' },
      monthly: { status: 'ok' },
    },
  }, 60, 1)
  assert.deepEqual(snapshot.windows.map((w) => w.kind), ['5h', '7d', '30d'])
  const [five, seven, month] = snapshot.windows
  assert.equal(five?.percent, 25)
  assert.equal(five?.cap, 12)
  assert.equal(five?.used, 3)
  assert.equal(five?.estimated, true)
  assert.equal(seven?.status, 'limited')
  assert.equal(seven?.cap, 30)
  assert.equal(month?.percent, undefined, 'no ratio reported')
  assert.equal(parseOpenCodeUsage({ usage: {} }, 60, 1).windows.length, 0)
  assert.throws(() => parseOpenCodeUsage({}, 60, 1))
})

test('the quota cache shares one in-flight fetch and a clear drops stale in-flight results', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const cache = new QuotaCache(30_000)
  const slow = () => new Promise<{ windows: []; fetchedAt: number }>((resolve) => {
    calls += 1
    release = () => resolve({ windows: [], fetchedAt: calls })
  })
  const a = cache.get('k', slow)
  const b = cache.get('k', slow)
  assert.equal(calls, 1)
  cache.clear()
  release?.()
  await Promise.all([a, b])
  assert.equal(cache.peek('k'), undefined, 'a fetch that started before clear() must not land')
  const fresh = await cache.get('k', () => Promise.resolve({ windows: [], fetchedAt: 99 }))
  assert.equal(fresh.fetchedAt, 99)
})

test('a failed fetch keeps the last good windows and reports the error', async () => {
  let now = 0
  const cache = new QuotaCache(10, () => now)
  await cache.get('k', () => Promise.resolve({ windows: [{ kind: '5h', percent: 40, estimated: false, source: 'provider', status: 'ok' }], fetchedAt: 1 }))
  now = 1_000
  const after = await cache.get('k', () => Promise.reject(new Error('HTTP 500')))
  assert.equal(after.windows[0]?.percent, 40)
  assert.equal(after.error, 'HTTP 500')
})

test('ledger aggregates hourly buckets into windows and survives a reload', async () => {
  const path = join(tempDir(), 'ledger.json')
  const hour = 3_600_000
  let now = 100 * 24 * hour
  const ledger = new UsageLedger(path, (error) => { throw error }, () => now, 1)
  ledger.recordAttempt('p|a')
  ledger.recordUsage('p|a', { inputTokens: 600, outputTokens: 100, cacheReadTokens: 400 })
  ledger.recordSuccess('p|a')
  now += 30 * hour
  ledger.recordAttempt('p|a')
  ledger.recordFailure('p|a')
  const day = ledger.window('p|a', 24 * hour)
  assert.equal(day.requests, 1)
  assert.equal(day.failures, 1)
  const week = ledger.window('p|a', 7 * 24 * hour)
  assert.equal(week.requests, 2)
  assert.equal(week.cacheRate, 40)
  await ledger.flush()
  const reloaded = new UsageLedger(path, (error) => { throw error }, () => now)
  await reloaded.load()
  assert.equal(reloaded.window('p|a').requests, 2)
})
