import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import { AccountPool, type AccountSlot, type PoolDeps } from '../src/pool/account-pool.ts'
import { StateStore } from '../src/pool/state-store.ts'
import type { ModelAccountRule, QuotaSnapshot, QuotaWindow } from '../src/pool/types.ts'

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'dsh-account-pool-'))

export function slot(id: string, key?: string): AccountSlot {
  return { id, label: id, ref: id as unknown as CredentialRef, literal: key }
}

export function window(kind: QuotaWindow['kind'], percent: number | undefined, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return { kind, ...(percent === undefined ? {} : { percent }), estimated: false, source: 'provider', status: percent !== undefined && percent >= 100 ? 'limited' : 'ok', ...extra }
}

export interface Harness {
  pool: AccountPool
  store: StateStore
  now: { value: number }
  snapshots: Map<string, QuotaSnapshot>
  refreshed: string[]
  pinned: { id: string | undefined }
  rules: { list: ModelAccountRule[] }
  slots: { list: AccountSlot[] }
  statePath: string
}

/** A pool over literal-key slots; keys are `key-<slot id>`. */
export function harness(ids: string[], overrides: Partial<PoolDeps> = {}, statePath = join(tempDir(), 'state.json')): Harness {
  const store = new StateStore(statePath, (error) => { throw error }, 1)
  const now = { value: 1_000_000_000_000 }
  const snapshots = new Map<string, QuotaSnapshot>()
  const refreshed: string[] = []
  const pinned: Harness['pinned'] = { id: undefined }
  const rules: Harness['rules'] = { list: [] }
  const slots: Harness['slots'] = { list: ids.map((id) => slot(id, `key-${id}`)) }
  const pool = new AccountPool({
    provider: 'opencode',
    slots: () => slots.list,
    resolveRef: () => Promise.resolve(undefined),
    pinnedId: () => pinned.id,
    routeRules: () => rules.list,
    cooldownMs: () => 300_000,
    thresholdPercent: () => 100,
    quotaOf: (key) => snapshots.get(key),
    refreshQuota: (key) => { refreshed.push(key) },
    store,
    now: () => now.value,
    ...overrides,
  })
  return { pool, store, now, snapshots, refreshed, pinned, rules, slots, statePath }
}
