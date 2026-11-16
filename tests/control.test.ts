import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

import { PoolControl } from '../src/control.ts'
import { UsageLedger } from '../src/pool/ledger.ts'
import type { QuotaSnapshot } from '../src/pool/types.ts'
import type { ProviderHandle } from '../src/providers/pool-wiring.ts'
import { harness, tempDir, window } from './helpers.ts'

function setup(ids: string[] = ['a', 'b']) {
  const h = harness(ids)
  const ledger = new UsageLedger(join(tempDir(), 'ledger.json'), (error) => { throw error }, () => h.now.value)
  const writes: { ns: string; ops: readonly SettingsPathOp[] }[] = []
  const handle: ProviderHandle = {
    provider: 'opencode',
    displayName: 'OpenCode Go',
    pool: h.pool,
    inner: {} as ProviderHandle['inner'],
    slots: () => h.slots.list,
    apiBase: () => 'https://x.test',
    pinned: () => h.pinned.id,
    quota: (key) => Promise.resolve(h.snapshots.get(key) ?? { windows: [], fetchedAt: h.now.value }),
    models: () => Promise.resolve([{ provider: 'opencode', id: 'm1', name: 'M1' }]),
  }
  const control = new PoolControl({
    handles: [handle],
    ledger,
    settingsNs: 'llm-account-pool',
    mutateSettings: (ns, ops) => { writes.push({ ns, ops }); return Promise.resolve() },
  })
  return { h, ledger, control, writes, handle }
}

test('the report names who serves, who is parked and why', async () => {
  const { h, control, ledger } = setup(['a', 'b', 'c'])
  const snapshot: QuotaSnapshot = { windows: [window('5h', 100, { resetAt: h.now.value + 3_600_000 })], fetchedAt: h.now.value }
  h.snapshots.set('key-a', snapshot)
  h.pool.reject('key-b', { kind: 'invalid-credential' })
  ledger.recordUsage('opencode|c', { inputTokens: 5, outputTokens: 1 })

  const [provider] = (await control.report()).providers
  const [a, b, c] = provider?.accounts ?? []
  assert.equal(a?.status, 'exhausted')
  assert.equal(a?.until, h.now.value + 3_600_000)
  assert.equal(b?.status, 'disabled')
  assert.equal(c?.status, 'ok')
  assert.equal(c?.serving, true, 'the first account that can serve is marked as serving')
  assert.equal(a?.serving, false)
  assert.equal(c?.usage.last24h.inputTokens, 5)
})

test('a slot without a key is reported, not hidden', async () => {
  const { h, control } = setup(['a'])
  h.slots.list.push({ id: 'empty', label: 'empty', ref: 'EMPTY' as never })
  const [provider] = (await control.report()).providers
  assert.equal(provider?.accounts[1]?.status, 'unconfigured')
})

test('switching writes the pin through settings, and rejects unknown targets', async () => {
  const { control, writes } = setup()
  await control.switchAccount('opencode', 'b')
  await control.switchAccount('opencode', null)
  assert.deepEqual(writes.map((write) => write.ops), [
    [{ op: 'set', path: ['opencode', 'activeAccount'], value: 'b' }],
    [{ op: 'unset', path: ['opencode', 'activeAccount'] }],
  ])
  assert.equal(writes[0]?.ns, 'llm-account-pool')
  await assert.rejects(() => control.switchAccount('opencode', 'nope'))
  await assert.rejects(() => control.switchAccount('nowhere', 'a'))
  assert.equal(writes.length, 2, 'refused switches write nothing')
})

test('there is one pin across providers: pinning or going automatic clears the others', async () => {
  const { h, handle, writes, control } = setup()
  const other: ProviderHandle = { ...handle, provider: 'commandcode', displayName: 'Command Code', pinned: () => 'x' }
  const both = new PoolControl({ handles: [handle, other], ledger: new UsageLedger(join(tempDir(), 'l.json'), (error) => { throw error }), settingsNs: 'llm-account-pool', mutateSettings: (ns, ops) => { writes.push({ ns, ops }); return Promise.resolve() } })
  await both.switchAccount('opencode', 'b')
  await both.switchAccount('opencode', null)
  assert.deepEqual(writes.map((write) => write.ops), [
    [{ op: 'unset', path: ['commandcode', 'activeAccount'] }, { op: 'set', path: ['opencode', 'activeAccount'], value: 'b' }],
    [{ op: 'unset', path: ['opencode', 'activeAccount'] }, { op: 'unset', path: ['commandcode', 'activeAccount'] }],
  ])
  void h; void control
})

test('a pin that names no configured slot is not reported as the pin', async () => {
  const { h, control } = setup()
  h.pinned.id = 'gone'
  const [provider] = (await control.report()).providers
  assert.equal(provider?.pinned, undefined)
  assert.equal(provider?.accounts.some((account) => account.pinned), false)
})

test('clear releases parked accounts', async () => {
  const { h, control } = setup(['a'])
  h.pool.reject('key-a', { kind: 'invalid-credential' })
  await control.clear('opencode')
  assert.equal((await control.report()).providers[0]?.accounts[0]?.status, 'ok')
  assert.deepEqual((await control.models()).opencode, [{ id: 'm1', name: 'M1' }])
})
