import assert from 'node:assert/strict'
import { test } from 'node:test'

import { accountsInOrder, orderedEntries, SettingsController, type ControllerDeps, type PoolApi, type RemoteResult, type ScopeSnapshot, type SettingsOp } from '../src/client/controller.ts'
import { fillOf, formatPercent, formatRemaining, overviewOf, toneOf } from '../src/client/format.ts'
import type { PoolReport } from '../src/remote/wire.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })

function setup(section: Record<string, unknown> = {}, options: { mutateResult?: boolean } = {}) {
  let snapshot: ScopeSnapshot = { status: 'ready', value: section, revision: 7, writable: true }
  const listeners = new Set<() => void>()
  const mutations: { ops: readonly SettingsOp[]; revision: number | undefined }[] = []
  const stored = new Map<string, string>()
  const removed: string[] = []
  const switches: [string, string | null][] = []
  const report: PoolReport = { providers: [] }
  const pool: PoolApi = {
    report: () => Promise.resolve(ok(report)),
    models: () => Promise.resolve(ok({ opencode: [{ id: 'm1' }] })),
    switchAccount: (provider, id) => { switches.push([provider, id]); return Promise.resolve(ok({ providers: [{ provider: 'opencode', displayName: 'x', apiBase: '', accounts: [] }] } as PoolReport)) },
    clear: () => Promise.resolve(ok(report)),
  }
  const deps: ControllerDeps = {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      mutate: (ops, revision) => { mutations.push({ ops, revision }); return Promise.resolve(options.mutateResult ?? true) },
    },
    credentials: {
      describe: (refs) => Promise.resolve(ok(Object.fromEntries(refs.map((ref) => [ref, { configured: stored.has(ref), writable: true }])))),
      set: (ref, value) => { stored.set(ref, value); return Promise.resolve(ok(undefined)) },
      unset: (ref) => { stored.delete(ref); removed.push(ref); return Promise.resolve(ok(undefined)) },
    },
    pool: () => pool,
    poolError: () => undefined,
    now: () => 1_000,
  }
  const controller = new SettingsController(deps)
  return {
    controller, mutations, stored, removed, switches,
    replaceScope: (value: Record<string, unknown>) => { snapshot = { ...snapshot, value }; for (const listener of listeners) listener() },
  }
}

const accounts = (...refs: string[]) => ({ accounts: refs.map((apiKeyEnv) => ({ label: apiKeyEnv, apiKeyEnv })) })

test('an empty account list shows the provider default as one account', () => {
  const { controller } = setup()
  const draft = controller.state().drafts.opencode
  assert.deepEqual(draft.accounts.map((account) => account.refName), ['OPENCODE_API_KEY'])
  assert.equal(controller.state().dirty, false)
})

test('new accounts take the next free reference, never one that is in use or just removed', () => {
  const { controller } = setup({ opencode: accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_2') })
  controller.removeAccount('opencode', 'OPENCODE_API_KEY_2')
  controller.addAccount('opencode')
  assert.deepEqual(controller.state().drafts.opencode.accounts.map((account) => account.refName), ['OPENCODE_API_KEY', 'OPENCODE_API_KEY_3'])
})

test('save writes keys through credentials, the list through one fenced mutate, and forgets typed keys', async () => {
  const { controller, mutations, stored } = setup({ opencode: accounts('OPENCODE_API_KEY') })
  controller.addAccount('opencode')
  controller.editLabel('opencode', 'OPENCODE_API_KEY_2', 'second')
  controller.editKey('opencode', 'OPENCODE_API_KEY_2', ' sk-secret ')
  await controller.save()
  assert.equal(stored.get('OPENCODE_API_KEY_2'), 'sk-secret')
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0]?.revision, 7)
  assert.deepEqual(mutations[0]?.ops, [{
    op: 'set',
    path: ['opencode', 'accounts'],
    value: [{ label: 'OPENCODE_API_KEY', apiKeyEnv: 'OPENCODE_API_KEY' }, { label: 'second', apiKeyEnv: 'OPENCODE_API_KEY_2' }],
  }])
  const state = controller.state()
  assert.equal(state.dirty, false)
  assert.equal(state.drafts.opencode.accounts.every((account) => account.keyDraft === '' && !account.isNew), true)
  assert.doesNotMatch(JSON.stringify(mutations), /sk-secret/, 'a key never enters the settings document')
})

test('a new account without a key cannot be saved', async () => {
  const { controller, mutations } = setup({ opencode: accounts('OPENCODE_API_KEY') })
  controller.addAccount('opencode')
  await controller.save()
  assert.equal(mutations.length, 0)
  assert.equal(controller.state().notice?.kind, 'error')
  assert.equal(controller.state().dirty, true)
})

test('removing an account deletes its stored key on save and drops the rules that named it', async () => {
  const { controller, mutations, removed } = setup({
    opencode: { ...accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_2'), modelAccountRules: [{ models: ['m1'], account: 'OPENCODE_API_KEY_2' }] },
  })
  controller.removeAccount('opencode', 'OPENCODE_API_KEY_2')
  await controller.save()
  assert.deepEqual(removed, ['OPENCODE_API_KEY_2'])
  const paths = mutations[0]?.ops.map((op) => op.path.join('.'))
  assert.deepEqual(paths, ['opencode.accounts', 'opencode.modelAccountRules'])
})

test('a refused save keeps the draft and says why', async () => {
  const { controller } = setup({ opencode: accounts('OPENCODE_API_KEY') }, { mutateResult: false })
  controller.editRotation({ switchAtPercent: 90 })
  await controller.save()
  const state = controller.state()
  assert.equal(state.dirty, true)
  assert.equal(state.rotation.switchAtPercent, 90)
  assert.equal(state.notice?.kind, 'error')
})

test('a scope update never clobbers a draft being edited, but lands once the draft is clean', () => {
  const { controller, replaceScope } = setup({ opencode: accounts('OPENCODE_API_KEY') })
  controller.editLabel('opencode', 'OPENCODE_API_KEY', 'mine')
  replaceScope({ opencode: accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_9') })
  assert.equal(controller.state().drafts.opencode.accounts.length, 1)
  controller.discard()
  replaceScope({ opencode: accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_9') })
  assert.equal(controller.state().drafts.opencode.accounts.length, 2)
})

test('pinning is an immediate action that adopts the Host report', async () => {
  const { controller, switches } = setup({ opencode: accounts('OPENCODE_API_KEY') })
  await controller.pin('opencode', 'OPENCODE_API_KEY')
  assert.deepEqual(switches, [['opencode', 'OPENCODE_API_KEY']])
  assert.equal(controller.state().report?.providers.length, 1)
  assert.equal(controller.state().dirty, false)
})

test('display helpers: tone, fill, remaining time, overview', () => {
  assert.deepEqual([toneOf(undefined), toneOf(10), toneOf(80), toneOf(100)], ['none', 'ok', 'warn', 'limit'])
  assert.deepEqual([fillOf(undefined), fillOf(-5), fillOf(41.4), fillOf(250)], [0, 0, 41, 100])
  assert.equal(formatPercent(undefined), '—')
  assert.equal(formatPercent(41.2), '41%')
  const now = 1_000_000
  assert.equal(formatRemaining(now + 13 * 60_000 + 2 * 3_600_000, now), '2h13m')
  assert.equal(formatRemaining(now + 4 * 86_400_000 + 6 * 3_600_000, now), '4d6h')
  assert.equal(formatRemaining(now - 1, now), '')
  const overview = overviewOf([{
    provider: 'opencode', displayName: 'x', apiBase: '',
    accounts: [
      { id: 'a', label: 'a', status: 'cooldown', until: now + 5, serving: false, pinned: false, usage: {} as never },
      { id: 'b', label: 'b', status: 'disabled', serving: false, pinned: false, usage: {} as never },
    ],
  }])
  assert.deepEqual([overview.ok, overview.parked, overview.disabled, overview.allDown, overview.earliestReturn], [0, 1, 1, true, now + 5])
})

test('the global order spans providers; moving writes one `order` op and a provider sees its share', async () => {
  const { controller, mutations } = setup({
    opencode: accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_2'),
    commandcode: accounts('COMMANDCODE_API_KEY'),
  })
  const keys = () => orderedEntries(controller.state()).map((entry) => entry.key)
  assert.deepEqual(keys(), ['commandcode:COMMANDCODE_API_KEY', 'opencode:OPENCODE_API_KEY', 'opencode:OPENCODE_API_KEY_2', 'opendesign:OPENDESIGN_API_KEY'])
  controller.moveEntry('opencode:OPENCODE_API_KEY_2', -1)
  controller.moveEntry('opencode:OPENCODE_API_KEY_2', -1)
  assert.deepEqual(keys(), ['opencode:OPENCODE_API_KEY_2', 'commandcode:COMMANDCODE_API_KEY', 'opencode:OPENCODE_API_KEY', 'opendesign:OPENDESIGN_API_KEY'])
  assert.deepEqual(accountsInOrder(controller.state(), 'opencode').map((account) => account.id), ['OPENCODE_API_KEY_2', 'OPENCODE_API_KEY'])
  controller.moveEntry('opencode:OPENCODE_API_KEY_2', -1)
  assert.equal(controller.state().dirty, true)
  await controller.save()
  assert.deepEqual(mutations[0]?.ops, [{ op: 'set', path: ['order'], value: keys() }])
  assert.equal(controller.state().dirty, false)
})

test('an untouched order is never written, and discard restores it', async () => {
  const { controller, mutations } = setup({ opencode: accounts('OPENCODE_API_KEY', 'OPENCODE_API_KEY_2') })
  controller.moveEntry('opencode:OPENCODE_API_KEY_2', -1)
  controller.discard()
  assert.deepEqual(controller.state().order, [])
  controller.editRotation({ switchAtPercent: 90 })
  await controller.save()
  assert.equal(mutations[0]?.ops.some((op) => op.path[0] === 'order'), false)
})
