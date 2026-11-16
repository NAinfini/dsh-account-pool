/**
 * Browser-side state of the settings page: the Host's live report, the staged
 * edits, and the actions that persist them. Framework-free so node tests can
 * drive it; the React layer only renders `state()` and calls actions.
 *
 * Persistence rules:
 *  - API keys are write-only and travel through the credentials Remote, never
 *    through the settings document.
 *  - Account lists, model allowlists, rules and rotation policy are one atomic
 *    `mutate` fenced by the revision the editor read.
 *  - Pinning an account (and returning to automatic) is immediate and does not
 *    wait for Save: it is an action, not a draft.
 *
 * @module dsh-account-pool/client/controller
 */

import type { PoolCatalog, PoolReport } from '../remote/wire.ts'
import { entryKey, sortByOrder } from '../pooling.ts'
import { PROVIDERS, providerMeta, type ProviderKey } from './providers.ts'

/** `RemoteResult` from the typert protocol, restated so tests need no engine. */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }

export interface CredentialInfo { configured: boolean; writable: boolean }

export interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  revision: number | undefined
  writable: boolean
}

export type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

export interface PoolApi {
  report(): Promise<RemoteResult<PoolReport>>
  models(): Promise<RemoteResult<PoolCatalog>>
  switchAccount(provider: string, accountId: string | null): Promise<RemoteResult<PoolReport>>
  clear(provider?: string): Promise<RemoteResult<PoolReport>>
}

export interface ControllerDeps {
  scope: {
    getSnapshot(): ScopeSnapshot
    subscribe(listener: () => void): () => void
    mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<boolean>
  }
  credentials: {
    describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
    set(ref: string, value: string): Promise<RemoteResult<unknown>>
    unset(ref: string): Promise<RemoteResult<unknown>>
  }
  /** Undefined while the `pool/*` Remote is still mounting. */
  pool(): PoolApi | undefined
  /** Why `pool()` is unavailable, when mounting failed. */
  poolError(): string | undefined
  now(): number
}

export interface AccountDraft {
  /** Slot id the Host uses: the credential reference name. */
  id: string
  label: string
  refName: string
  /** Typed key; empty means "keep the stored one". Never read back from the Host. */
  keyDraft: string
  isNew: boolean
}

export interface ProviderDraft {
  accounts: AccountDraft[]
  /** Credential references removed in this draft; their stored keys are deleted on Save. */
  removed: string[]
  visibleModels: string[]
  rules: { models: string[]; account: string }[]
  apiBase: string
}

export interface RotationDraft { switchAtPercent: number; cooldownMs: number }

export interface Notice { kind: 'ok' | 'error'; text: string }

/** A page tab: the global order, or one provider. */
export type View = ProviderKey | 'order'

export interface PageState {
  scope: ScopeSnapshot['status']
  writable: boolean
  provider: View
  report: PoolReport | undefined
  reportError: string | undefined
  reportAt: number | undefined
  refreshing: boolean
  catalog: PoolCatalog
  credentials: Record<string, CredentialInfo>
  drafts: Record<ProviderKey, ProviderDraft>
  rotation: RotationDraft
  /** Stored global order (`provider:slotId`); accounts it does not list follow in configured order. */
  order: string[]
  dirty: boolean
  saving: boolean
  notice: Notice | undefined
}

const DEFAULT_ROTATION: RotationDraft = { switchAtPercent: 100, cooldownMs: 300_000 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [])

/** The draft the stored section implies for one provider. */
export function draftFromSection(provider: ProviderKey, section: unknown): ProviderDraft {
  const meta = providerMeta(provider)
  const record = isRecord(section) ? section : {}
  const accounts: AccountDraft[] = []
  for (const entry of Array.isArray(record.accounts) ? record.accounts : []) {
    if (!isRecord(entry)) continue
    const refName = typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv.trim() : ''
    if (refName === '') continue // composition-only literal keys are invisible to the browser and not editable here
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : refName
    accounts.push({ id: refName, label, refName, keyDraft: '', isNew: false })
  }
  // An empty list means the Host serves the provider's default reference as one account.
  if (accounts.length === 0 && meta !== undefined) {
    accounts.push({ id: meta.defaultRef, label: meta.name, refName: meta.defaultRef, keyDraft: '', isNew: false })
  }
  const rules = (Array.isArray(record.modelAccountRules) ? record.modelAccountRules : [])
    .filter(isRecord)
    .map((rule) => ({ models: strings(rule.models), account: typeof rule.account === 'string' ? rule.account : '' }))
  return {
    accounts,
    removed: [],
    visibleModels: strings(record.visibleModels),
    rules,
    apiBase: typeof record.apiBase === 'string' ? record.apiBase : '',
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export interface OrderEntry {
  key: string
  provider: ProviderKey
  account: AccountDraft
}

/** Every account of every provider in the global order. */
export function orderedEntries(state: Pick<PageState, 'drafts' | 'order'>): OrderEntry[] {
  const all = PROVIDERS.flatMap((meta) => state.drafts[meta.id].accounts.map((account): OrderEntry => ({
    key: entryKey(meta.id, account.id), provider: meta.id, account,
  })))
  return sortByOrder(all, (entry) => entry.key, state.order)
}

/** One provider's accounts in the global order (the order the Host serves them in). */
export const accountsInOrder = (state: Pick<PageState, 'drafts' | 'order'>, provider: ProviderKey): AccountDraft[] =>
  orderedEntries(state).filter((entry) => entry.provider === provider).map((entry) => entry.account)

export class SettingsController {
  private readonly deps: ControllerDeps
  private readonly listeners = new Set<() => void>()
  private readonly disposers: (() => void)[] = []
  private current: PageState
  private baseline: Pick<PageState, 'drafts' | 'rotation' | 'order'>
  private generation = 0
  private disposed = false

  constructor(deps: ControllerDeps) {
    this.deps = deps
    const read = this.readScope()
    const snapshot = deps.scope.getSnapshot()
    this.baseline = { drafts: structuredClone(read.drafts), rotation: { ...read.rotation }, order: [...read.order] }
    this.current = {
      scope: snapshot.status,
      writable: snapshot.writable,
      provider: 'order',
      report: undefined,
      reportError: undefined,
      reportAt: undefined,
      refreshing: false,
      catalog: {},
      credentials: {},
      drafts: read.drafts,
      rotation: read.rotation,
      order: read.order,
      dirty: false,
      saving: false,
      notice: undefined,
    }
    this.disposers.push(deps.scope.subscribe(() => { this.onScopeChanged() }))
  }

  state(): PageState {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const dispose of this.disposers) dispose()
    this.listeners.clear()
  }

  private publish(patch: Partial<PageState>): void {
    if (this.disposed) return
    this.current = { ...this.current, ...patch }
    for (const listener of this.listeners) listener()
  }

  private readScope(): Pick<PageState, 'drafts' | 'rotation' | 'order'> {
    const value = this.deps.scope.getSnapshot().value ?? {}
    const drafts = {} as Record<ProviderKey, ProviderDraft>
    for (const meta of PROVIDERS) drafts[meta.id] = draftFromSection(meta.id, value[meta.id])
    const rotation = isRecord(value.rotation) ? value.rotation : {}
    return {
      drafts,
      order: strings(value.order),
      rotation: {
        switchAtPercent: typeof rotation.switchAtPercent === 'number' ? rotation.switchAtPercent : DEFAULT_ROTATION.switchAtPercent,
        cooldownMs: typeof rotation.cooldownMs === 'number' ? rotation.cooldownMs : DEFAULT_ROTATION.cooldownMs,
      },
    }
  }

  private onScopeChanged(): void {
    const snapshot = this.deps.scope.getSnapshot()
    // A settled re-read never clobbers a draft the user is editing.
    if (this.current.dirty || this.current.saving) {
      this.publish({ scope: snapshot.status, writable: snapshot.writable })
      return
    }
    const read = this.readScope()
    this.baseline = { drafts: structuredClone(read.drafts), rotation: { ...read.rotation }, order: [...read.order] }
    this.publish({ scope: snapshot.status, writable: snapshot.writable, drafts: read.drafts, rotation: read.rotation, order: read.order })
    void this.refreshCredentials()
  }

  // ---- reads ---------------------------------------------------------------

  async refresh(): Promise<void> {
    if (this.current.refreshing) return
    const pool = this.deps.pool()
    if (pool === undefined) {
      this.publish({ reportError: this.deps.poolError() ?? 'the pool service is still starting' })
      return
    }
    const generation = ++this.generation
    this.publish({ refreshing: true })
    try {
      const [report, catalog] = await Promise.all([pool.report(), pool.models()])
      if (this.disposed || generation !== this.generation) return
      this.publish({
        refreshing: false,
        report: report.ok ? report.value : this.current.report,
        reportError: report.ok ? undefined : report.error.message,
        reportAt: report.ok ? this.deps.now() : this.current.reportAt,
        catalog: catalog.ok ? catalog.value : this.current.catalog,
      })
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return
      this.publish({ refreshing: false, reportError: error instanceof Error ? error.message : String(error) })
    }
    await this.refreshCredentials()
  }

  async refreshCredentials(): Promise<void> {
    const refs = new Set<string>()
    for (const draft of Object.values(this.current.drafts)) for (const account of draft.accounts) refs.add(account.refName)
    if (refs.size === 0) return
    try {
      const response = await this.deps.credentials.describe([...refs])
      if (this.disposed || !response.ok) return
      this.publish({ credentials: { ...this.current.credentials, ...response.value } })
    } catch {
      // The row simply reads as "not configured" until the next refresh.
    }
  }

  // ---- immediate actions ---------------------------------------------------

  setProvider(provider: View): void {
    this.publish({ provider })
  }

  private async withPool(run: (pool: PoolApi) => Promise<RemoteResult<PoolReport>>): Promise<void> {
    const pool = this.deps.pool()
    if (pool === undefined) {
      this.publish({ notice: { kind: 'error', text: this.deps.poolError() ?? 'the pool service is still starting' } })
      return
    }
    try {
      const response = await run(pool)
      if (response.ok) this.publish({ report: response.value, reportAt: this.deps.now(), reportError: undefined })
      else this.publish({ notice: { kind: 'error', text: response.error.message } })
    } catch (error: unknown) {
      this.publish({ notice: { kind: 'error', text: error instanceof Error ? error.message : String(error) } })
    }
  }

  pin(provider: ProviderKey, accountId: string | null): Promise<void> {
    return this.withPool((pool) => pool.switchAccount(provider, accountId))
  }

  clearMarks(provider?: ProviderKey): Promise<void> {
    return this.withPool((pool) => pool.clear(provider))
  }

  // ---- staged edits --------------------------------------------------------

  private edit(update: (drafts: Record<ProviderKey, ProviderDraft>, rotation: RotationDraft, order: string[]) => void): void {
    const drafts = structuredClone(this.current.drafts)
    const rotation = { ...this.current.rotation }
    const order = [...this.current.order]
    update(drafts, rotation, order)
    const dirty = !sameJson(drafts, this.baseline.drafts) || !sameJson(rotation, this.baseline.rotation) || !sameJson(order, this.baseline.order)
    this.publish({ drafts, rotation, order, dirty, notice: undefined })
  }

  addAccount(provider: ProviderKey): void {
    this.edit((drafts) => {
      const draft = drafts[provider]
      const meta = providerMeta(provider)
      if (meta === undefined) return
      const taken = new Set([...draft.accounts.map((account) => account.refName), ...draft.removed])
      let n = 2
      while (taken.has(`${meta.defaultRef}_${n}`)) n += 1
      const refName = `${meta.defaultRef}_${n}`
      draft.accounts.push({ id: refName, label: `Account ${draft.accounts.length + 1}`, refName, keyDraft: '', isNew: true })
    })
  }

  removeAccount(provider: ProviderKey, id: string): void {
    this.edit((drafts) => {
      const draft = drafts[provider]
      const gone = draft.accounts.find((account) => account.id === id)
      if (gone === undefined) return
      draft.accounts = draft.accounts.filter((account) => account.id !== id)
      if (!gone.isNew) draft.removed.push(gone.refName)
      draft.rules = draft.rules.filter((rule) => rule.account !== id)
    })
  }

  /** Move one account up or down the global order. */
  moveEntry(key: string, delta: -1 | 1): void {
    this.edit((drafts, _rotation, order) => {
      const keys = orderedEntries({ drafts, order }).map((entry) => entry.key)
      const index = keys.indexOf(key)
      const target = index + delta
      if (index < 0 || target < 0 || target >= keys.length) return
      const [moved] = keys.splice(index, 1)
      if (moved !== undefined) keys.splice(target, 0, moved)
      order.splice(0, order.length, ...keys)
    })
  }

  editLabel(provider: ProviderKey, id: string, label: string): void {
    this.edit((drafts) => {
      const account = drafts[provider].accounts.find((candidate) => candidate.id === id)
      if (account !== undefined) account.label = label
    })
  }

  editKey(provider: ProviderKey, id: string, key: string): void {
    this.edit((drafts) => {
      const account = drafts[provider].accounts.find((candidate) => candidate.id === id)
      if (account !== undefined) account.keyDraft = key
    })
  }

  toggleModel(provider: ProviderKey, modelId: string, checked: boolean): void {
    this.edit((drafts) => {
      const set = new Set(drafts[provider].visibleModels)
      if (checked) set.add(modelId)
      else set.delete(modelId)
      drafts[provider].visibleModels = [...set]
    })
  }

  /** Show every model: an empty allowlist means "no filter". */
  showAllModels(provider: ProviderKey): void {
    this.edit((drafts) => { drafts[provider].visibleModels = [] })
  }

  addRule(provider: ProviderKey): void {
    this.edit((drafts) => {
      const first = drafts[provider].accounts[0]
      drafts[provider].rules.push({ models: [], account: first?.id ?? '' })
    })
  }

  editRule(provider: ProviderKey, index: number, patch: { models?: string[]; account?: string }): void {
    this.edit((drafts) => {
      const rule = drafts[provider].rules[index]
      if (rule === undefined) return
      if (patch.models !== undefined) rule.models = patch.models
      if (patch.account !== undefined) rule.account = patch.account
    })
  }

  removeRule(provider: ProviderKey, index: number): void {
    this.edit((drafts) => { drafts[provider].rules.splice(index, 1) })
  }

  editApiBase(provider: ProviderKey, value: string): void {
    this.edit((drafts) => { drafts[provider].apiBase = value })
  }

  editRotation(patch: Partial<RotationDraft>): void {
    this.edit((_drafts, rotation) => { Object.assign(rotation, patch) })
  }

  discard(): void {
    this.publish({ drafts: structuredClone(this.baseline.drafts), rotation: { ...this.baseline.rotation }, order: [...this.baseline.order], dirty: false, notice: undefined })
  }

  // ---- save ----------------------------------------------------------------

  /** Why the draft cannot be saved, or undefined when it can. */
  validate(): string | undefined {
    for (const meta of PROVIDERS) {
      const draft = this.current.drafts[meta.id]
      const refs = new Set<string>()
      for (const account of draft.accounts) {
        if (refs.has(account.refName)) return `${meta.name}: duplicate account ${account.refName}`
        refs.add(account.refName)
        if (account.isNew && account.keyDraft.trim() === '') return `${meta.name}: "${account.label}" needs an API key`
      }
    }
    const { switchAtPercent, cooldownMs } = this.current.rotation
    if (!(switchAtPercent >= 1 && switchAtPercent <= 100)) return 'switch threshold must be between 1 and 100'
    if (!(cooldownMs >= 1000)) return 'cooldown must be at least 1000 ms'
    return undefined
  }

  async save(): Promise<void> {
    if (this.current.saving || !this.current.dirty) return
    const problem = this.validate()
    if (problem !== undefined) {
      this.publish({ notice: { kind: 'error', text: problem } })
      return
    }
    const revision = this.deps.scope.getSnapshot().revision
    this.publish({ saving: true, notice: undefined })
    try {
      const ops: SettingsOp[] = []
      for (const meta of PROVIDERS) {
        const draft = this.current.drafts[meta.id]
        const base = this.baseline.drafts[meta.id]
        for (const account of draft.accounts) {
          const key = account.keyDraft.trim()
          if (key === '') continue
          const response = await this.deps.credentials.set(account.refName, key)
          if (!response.ok) throw new Error(`${meta.name} / ${account.label}: ${response.error.message}`)
        }
        for (const ref of draft.removed) {
          // A reference another account of this draft still uses must survive.
          if (draft.accounts.some((account) => account.refName === ref)) continue
          const response = await this.deps.credentials.unset(ref)
          if (!response.ok) throw new Error(`${meta.name}: ${response.error.message}`)
        }
        const listing = (accounts: AccountDraft[]) => accounts.map((account) => [account.refName, account.label])
        if (!sameJson(listing(draft.accounts), listing(base.accounts)) || draft.removed.length > 0) {
          ops.push({
            op: 'set',
            path: [meta.id, 'accounts'],
            value: draft.accounts.map((account) => ({ label: account.label.trim() || account.refName, apiKeyEnv: account.refName })),
          })
        }
        if (!sameJson(draft.visibleModels, base.visibleModels)) ops.push({ op: 'set', path: [meta.id, 'visibleModels'], value: draft.visibleModels })
        if (!sameJson(draft.rules, base.rules)) {
          ops.push({ op: 'set', path: [meta.id, 'modelAccountRules'], value: draft.rules.filter((rule) => rule.account !== '' && rule.models.length > 0) })
        }
        if (draft.apiBase !== base.apiBase) {
          ops.push(draft.apiBase.trim() === '' ? { op: 'unset', path: [meta.id, 'apiBase'] } : { op: 'set', path: [meta.id, 'apiBase'], value: draft.apiBase.trim() })
        }
      }
      for (const field of ['switchAtPercent', 'cooldownMs'] as const) {
        if (this.current.rotation[field] !== this.baseline.rotation[field]) {
          ops.push({ op: 'set', path: ['rotation', field], value: this.current.rotation[field] })
        }
      }
      if (!sameJson(this.current.order, this.baseline.order)) ops.push({ op: 'set', path: ['order'], value: this.current.order })
      if (ops.length > 0 && !(await this.deps.scope.mutate(ops, revision))) {
        throw new Error('the configuration changed elsewhere; reload and retry')
      }
      // Keys are never kept in the draft once stored.
      const drafts = structuredClone(this.current.drafts)
      for (const draft of Object.values(drafts)) {
        for (const account of draft.accounts) { account.keyDraft = ''; account.isNew = false }
        draft.removed = []
      }
      this.baseline = { drafts: structuredClone(drafts), rotation: { ...this.current.rotation }, order: [...this.current.order] }
      this.publish({ saving: false, dirty: false, drafts, notice: { kind: 'ok', text: 'saved' } })
      await this.refreshCredentials()
      await this.refresh()
    } catch (error: unknown) {
      // The draft survives a failed save so nothing typed is lost.
      this.publish({ saving: false, notice: { kind: 'error', text: error instanceof Error ? error.message : String(error) } })
    }
  }
}
