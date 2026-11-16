/**
 * The "Account pool" settings page: one tab per provider, one row per account.
 *
 * Immediate actions (pin, clear marks, refresh) act at once; everything else is
 * staged in the controller's draft and persisted by Save.
 *
 * @module dsh-account-pool/client/section
 */

import { useEffect, useState } from 'react'

import { accountsInOrder, orderedEntries, type AccountDraft, type OrderEntry, type PageState, type ProviderDraft, type View } from './controller.ts'
import { formatCount, formatMoment, formatPercent, formatTokens, overviewOf } from './format.ts'
import { QuotaRows, StatusBadge } from './components.tsx'
import type { Translate } from './locales.ts'
import { sharedModelIds } from '../pooling.ts'
import { PROVIDERS, providerMeta, type ProviderKey, type ProviderMeta } from './providers.ts'

export interface PageActions {
  setProvider(provider: View): void
  refresh(): void
  pin(provider: ProviderKey, id: string | null): void
  clearMarks(provider: ProviderKey): void
  addAccount(provider: ProviderKey): void
  removeAccount(provider: ProviderKey, id: string): void
  moveEntry(key: string, delta: -1 | 1): void
  editLabel(provider: ProviderKey, id: string, label: string): void
  editKey(provider: ProviderKey, id: string, key: string): void
  toggleModel(provider: ProviderKey, modelId: string, checked: boolean): void
  showAllModels(provider: ProviderKey): void
  addRule(provider: ProviderKey): void
  editRule(provider: ProviderKey, index: number, patch: { models?: string[]; account?: string }): void
  removeRule(provider: ProviderKey, index: number): void
  editApiBase(provider: ProviderKey, value: string): void
  editRotation(patch: { switchAtPercent?: number; cooldownMs?: number }): void
  save(): void
  discard(): void
  setCard(enabled: boolean): void
}

export interface PageProps {
  t: Translate
  usePool<T>(selector: (state: PageState) => T): T
  useCard<T>(selector: (enabled: boolean) => T): T
  actions: PageActions
}

interface AccountRowProps {
  provider: ProviderKey
  account: AccountDraft
  state: PageState
  t: Translate
  actions: PageActions
}

function AccountRow({ provider, account, state, t, actions }: AccountRowProps) {
  const [open, setOpen] = useState(account.isNew)
  const meta = providerMeta(provider)
  const report = state.report?.providers.find((candidate) => candidate.provider === provider)?.accounts.find((candidate) => candidate.id === account.id)
  const configured = state.credentials[account.refName]?.configured === true
  const now = Date.now()
  const inputId = `dap-key-${provider}-${account.id}`
  const nameId = `dap-name-${provider}-${account.id}`
  const pinnedHere = report?.pinned === true
  return (
    <div className={`dap-account${report?.serving === true ? ' dap-accountServing' : ''}`}>
      <div className="dap-accountHead">
        <span className="dap-accountName" title={account.label}>{account.label}</span>
        {report?.serving === true ? <span className="dap-badge dap-badgeBrand">{pinnedHere ? t('pinned') : t('current')}</span> : null}
        {report !== undefined ? <StatusBadge account={report} t={t} /> : <span className="dap-badge">{configured ? t('apiKeyStored') : t('apiKeyMissing')}</span>}
        {report?.until !== undefined && report.status !== 'ok' ? <span className="dap-hint">{t('returnsAt', { time: formatMoment(report.until, now) })}</span> : null}
        <span className="dap-actions">
          <button className="dap-btn dap-btnText" type="button" aria-expanded={open} onClick={() => { setOpen(!open) }}>{open ? t('collapse') : t('edit')}</button>
        </span>
      </div>
      {report !== undefined && meta !== undefined ? <QuotaRows account={report} meta={meta} t={t} now={now} /> : null}
      {report?.status === 'disabled' ? <p className="dap-hint dap-err">{t('reasonDisabled')}</p> : null}
      {open ? (
        <div className="dap-accountBody">
          <div className="dap-field">
            <label className="dap-fieldLabel" htmlFor={nameId}>{t('name')}</label>
            <input id={nameId} className="dap-input" value={account.label} onChange={(event) => { actions.editLabel(provider, account.id, event.target.value) }} />
            <label className="dap-fieldLabel" htmlFor={inputId}>{t('apiKey')}</label>
            <input
              id={inputId}
              className="dap-input dap-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={account.keyDraft}
              placeholder={configured ? t('apiKeyReplace') : t('apiKeyNew')}
              onChange={(event) => { actions.editKey(provider, account.id, event.target.value) }}
            />
          </div>
          {report !== undefined ? (
            <div className="dap-stats">
              <span>{t('last24h')}: <strong>{formatCount(report.usage.last24h.requests)}</strong> {t('requests')} · <strong>{formatTokens(report.usage.last24h.totalTokens)}</strong> {t('tokens')}</span>
              <span>{t('last7d')}: <strong>{formatCount(report.usage.last7d.requests)}</strong></span>
              <span>{t('total')}: <strong>{formatCount(report.usage.total.requests)}</strong></span>
              <span>{t('cacheRate')}: <strong>{formatPercent(report.usage.last7d.cacheRate)}</strong></span>
              <span>{t('failures')}: <strong>{formatCount(report.usage.last7d.failures)}</strong></span>
            </div>
          ) : null}
          <div className="dap-row">
            {pinnedHere
              ? <button className="dap-btn" type="button" onClick={() => { actions.pin(provider, null) }}>{t('backToAuto')}</button>
              : <button className="dap-btn" type="button" disabled={report === undefined || report.status === 'unconfigured' || account.isNew} onClick={() => { actions.pin(provider, account.id) }}>{t('makeCurrent')}</button>}
            <button className="dap-btn dap-btnDanger" type="button" onClick={() => { actions.removeAccount(provider, account.id) }}>{t('remove')}</button>
            {account.isNew ? null : <span className="dap-hint">{t('removeWarn')}</span>}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ModelsSection({ provider, draft, state, t, actions }: { provider: ProviderKey; draft: ProviderDraft; state: PageState; t: Translate; actions: PageActions }) {
  const models = state.catalog[provider] ?? []
  const checked = new Set(draft.visibleModels)
  return (
    <section className="dap-section">
      <div className="dap-sectionHead">
        <h3 className="dap-sectionTitle">{t('models')}</h3>
        <button className="dap-btn dap-btnText" type="button" disabled={draft.visibleModels.length === 0} onClick={() => { actions.showAllModels(provider) }}>{t('showAll')}</button>
      </div>
      <p className="dap-hint">{t('modelsHint')}</p>
      {models.length === 0 ? <p className="dap-hint">{t('noModels')}</p> : (
        <div className="dap-modelList">
          {models.map((model) => (
            <label className="dap-modelRow" key={model.id}>
              <input className="dap-check" type="checkbox" checked={checked.has(model.id)} onChange={(event) => { actions.toggleModel(provider, model.id, event.target.checked) }} />
              <span className="dap-mono">{model.name ?? model.id}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

function RulesSection({ provider, draft, state, t, actions }: { provider: ProviderKey; draft: ProviderDraft; state: PageState; t: Translate; actions: PageActions }) {
  const models = state.catalog[provider] ?? []
  return (
    <section className="dap-section">
      <div className="dap-sectionHead">
        <h3 className="dap-sectionTitle">{t('rules')}</h3>
        <button className="dap-btn" type="button" disabled={draft.accounts.length === 0} onClick={() => { actions.addRule(provider) }}>{t('addRule')}</button>
      </div>
      <p className="dap-hint">{t('rulesHint')}</p>
      {draft.rules.map((rule, index) => (
        <div className="dap-rule" key={index}>
          <input
            className="dap-input dap-mono"
            list={`dap-models-${provider}`}
            aria-label={t('ruleModels')}
            placeholder={t('pickModels')}
            value={rule.models.join(', ')}
            onChange={(event) => { actions.editRule(provider, index, { models: event.target.value.split(',').map((item) => item.trim()).filter((item) => item !== '') }) }}
          />
          <select className="dap-input" aria-label={t('ruleAccount')} value={rule.account} onChange={(event) => { actions.editRule(provider, index, { account: event.target.value }) }}>
            {draft.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
          <button className="dap-btn dap-btnDanger" type="button" onClick={() => { actions.removeRule(provider, index) }}>{t('remove')}</button>
        </div>
      ))}
      <datalist id={`dap-models-${provider}`}>{models.map((model) => <option key={model.id} value={model.id} />)}</datalist>
    </section>
  )
}

/** The global order: every account of every provider, first in the list is tried first. */
function OrderPanel({ state, t, actions }: { state: PageState; t: Translate; actions: PageActions }) {
  const entries = orderedEntries(state)
  const now = Date.now()
  const reportOf = (entry: OrderEntry) =>
    state.report?.providers.find((candidate) => candidate.provider === entry.provider)?.accounts.find((candidate) => candidate.id === entry.account.id)
  const configured = (entry: OrderEntry) => state.credentials[entry.account.refName]?.configured === true || entry.account.keyDraft.trim() !== ''
  const current = entries.find((entry) => reportOf(entry)?.status === 'ok' && configured(entry))
  const pinned = entries.find((entry) => reportOf(entry)?.pinned === true)
  const withKeys = PROVIDERS.filter((meta) => state.drafts[meta.id].accounts.some((account) => state.credentials[account.refName]?.configured === true))
  const shared = sharedModelIds(withKeys.map((meta) => (state.catalog[meta.id] ?? []).map((model) => model.id)))
  return (
    <section className="dap-section">
      <div className="dap-sectionHead">
        <h3 className="dap-sectionTitle">{t('orderTitle')}</h3>
        {pinned !== undefined
          ? <button className="dap-btn dap-btnText" type="button" onClick={() => { actions.pin(pinned.provider, null) }}>{t('backToAuto')}</button>
          : null}
      </div>
      <p className="dap-hint">{t('orderIntro')}</p>
      {entries.length === 0 ? <p className="dap-hint">{t('orderEmpty')}</p> : null}
      {entries.map((entry, index) => {
        const report = reportOf(entry)
        const meta = providerMeta(entry.provider)
        const serving = entry === current
        return (
          <div className={`dap-account${serving ? ' dap-accountServing' : ''}`} key={entry.key}>
            <div className="dap-accountHead">
              <span className="dap-hint dap-mono">{index + 1}</span>
              <span className="dap-badge">{meta?.name ?? entry.provider}</span>
              <span className="dap-accountName" title={entry.account.label}>{entry.account.label}</span>
              {serving ? <span className="dap-badge dap-badgeBrand">{entry === pinned ? t('pinned') : t('current')}</span> : null}
              {report !== undefined ? <StatusBadge account={report} t={t} /> : <span className="dap-badge">{t('stateUnconfigured')}</span>}
              {report?.until !== undefined && report.status !== 'ok' ? <span className="dap-hint">{t('returnsAt', { time: formatMoment(report.until, now) })}</span> : null}
              <span className="dap-actions">
                <button className="dap-btn dap-btnText" type="button" disabled={index === 0} aria-label={t('moveUp')} onClick={() => { actions.moveEntry(entry.key, -1) }}>↑</button>
                <button className="dap-btn dap-btnText" type="button" disabled={index === entries.length - 1} aria-label={t('moveDown')} onClick={() => { actions.moveEntry(entry.key, 1) }}>↓</button>
                {entry === pinned
                  ? null
                  : <button className="dap-btn dap-btnText" type="button" disabled={report === undefined || report.status === 'unconfigured' || entry.account.isNew} onClick={() => { actions.pin(entry.provider, entry.account.id) }}>{t('makeCurrent')}</button>}
              </span>
            </div>
            {report !== undefined && meta !== undefined ? <QuotaRows account={report} meta={meta} t={t} now={now} /> : null}
          </div>
        )
      })}
      <h3 className="dap-sectionTitle">{t('poolModels')}</h3>
      {shared.length === 0
        ? <p className="dap-hint">{t('poolModelsNone')}</p>
        : <><p className="dap-hint">{t('poolModelsHint')}</p><p className="dap-mono">{shared.map((id) => `pool/${id}`).join('  ')}</p></>}
    </section>
  )
}

function ProviderBody({ meta, state, t, actions }: { meta: ProviderMeta; state: PageState; t: Translate; actions: PageActions }) {
  const draft = state.drafts[meta.id]
  const providerReport = state.report?.providers.find((candidate) => candidate.provider === meta.id)
  const pinnedLabel = draft.accounts.find((account) => account.id === providerReport?.pinned)?.label
  const accounts = accountsInOrder(state, meta.id)
  return (
    <>
      <section className="dap-section">
        <div className="dap-sectionHead">
          <h3 className="dap-sectionTitle">{t('accounts')}</h3>
          <div className="dap-actions">
            <button className="dap-btn dap-btnText" type="button" onClick={() => { actions.clearMarks(meta.id) }}>{t('clearMarks')}</button>
            <button className="dap-btn" type="button" onClick={() => { actions.addAccount(meta.id) }}>{draft.accounts.length === 0 ? t('noKeyYet') : t('addAccount')}</button>
          </div>
        </div>
        <p className="dap-hint">{pinnedLabel === undefined ? t('rotationAuto') : t('rotationPinned', { name: pinnedLabel })}</p>
        {accounts.map((account) => (
          <AccountRow key={account.id} provider={meta.id} account={account} state={state} t={t} actions={actions} />
        ))}
      </section>

      <ModelsSection provider={meta.id} draft={draft} state={state} t={t} actions={actions} />
      <RulesSection provider={meta.id} draft={draft} state={state} t={t} actions={actions} />

      <section className="dap-section">
        <h3 className="dap-sectionTitle">{t('apiBase')}</h3>
        <input id="dap-apibase" className="dap-input dap-mono" aria-label={t('apiBase')} value={draft.apiBase} placeholder={meta.defaultApiBase} onChange={(event) => { actions.editApiBase(meta.id, event.target.value) }} />
        <p className="dap-hint">{t('apiBaseHint')}</p>
      </section>
    </>
  )
}

export function AccountPoolPage({ t, usePool, useCard, actions }: PageProps) {
  const state = usePool((value) => value)
  const cardOn = useCard((enabled) => enabled)
  useEffect(() => { actions.refresh() }, [])
  const meta = state.provider === 'order' ? undefined : providerMeta(state.provider)
  const overview = overviewOf(state.report?.providers ?? [])
  const now = Date.now()

  if (state.scope === 'unavailable') return <div className="dap-page"><p className="dap-banner dap-bannerError">{t('scopeUnavailable')}</p></div>

  return (
    <div className="dap-page">
      <div className="dap-head">
        <div>
          <h2 className="dap-title">{t('title')}</h2>
          <p className="dap-sub">{t('intro')}</p>
        </div>
        <div className="dap-actions">
          {state.reportAt !== undefined ? <span className="dap-hint">{t('updatedAt', { time: formatMoment(state.reportAt, now) })}</span> : null}
          <button className="dap-btn" type="button" disabled={state.refreshing} onClick={() => { actions.refresh() }}>{state.refreshing ? t('refreshing') : t('refresh')}</button>
        </div>
      </div>

      {state.scope === 'loading' ? <p className="dap-hint">{t('scopeLoading')}</p> : null}
      {!state.writable && state.scope === 'ready' ? <p className="dap-banner dap-bannerWarn">{t('readOnly')}</p> : null}
      {state.reportError !== undefined ? <p className="dap-banner dap-bannerError">{t('reportError', { message: state.reportError })}</p> : null}
      {overview.allDown ? (
        <p className="dap-banner dap-bannerWarn">
          {t('allDown', { until: overview.earliestReturn === undefined ? '' : t('allDownUntil', { time: formatMoment(overview.earliestReturn, now) }) })}
        </p>
      ) : null}

      <div className="dap-tabs" role="tablist">
        <button className={`dap-tab${state.provider === 'order' ? ' dap-tabActive' : ''}`} type="button" role="tab" aria-selected={state.provider === 'order'} onClick={() => { actions.setProvider('order') }}>{t('tabOrder')}</button>
        {PROVIDERS.map((candidate) => (
          <button
            key={candidate.id}
            className={`dap-tab${candidate.id === state.provider ? ' dap-tabActive' : ''}`}
            type="button"
            role="tab"
            aria-selected={candidate.id === state.provider}
            onClick={() => { actions.setProvider(candidate.id) }}
          >
            {candidate.name}
          </button>
        ))}
      </div>

      {meta === undefined ? <OrderPanel state={state} t={t} actions={actions} /> : <ProviderBody meta={meta} state={state} t={t} actions={actions} />}

      <section className="dap-section">
        <h3 className="dap-sectionTitle">{t('advanced')}</h3>
        <div className="dap-row">
          <label htmlFor="dap-switch">{t('switchAt')}</label>
          <input id="dap-switch" className="dap-input dap-inputNarrow" type="number" min={1} max={100} value={state.rotation.switchAtPercent} onChange={(event) => { actions.editRotation({ switchAtPercent: Number(event.target.value) }) }} />
          <span>{t('switchAtSuffix')}</span>
        </div>
        <div className="dap-row">
          <label htmlFor="dap-cooldown">{t('cooldown')}</label>
          <input id="dap-cooldown" className="dap-input dap-inputNarrow" type="number" min={1000} step={1000} value={state.rotation.cooldownMs} onChange={(event) => { actions.editRotation({ cooldownMs: Number(event.target.value) }) }} />
          <span>{t('cooldownSuffix')}</span>
        </div>
        <label className="dap-row">
          <input className="dap-check" type="checkbox" checked={cardOn} onChange={(event) => { actions.setCard(event.target.checked) }} />
          <span>{t('showCard')}</span>
        </label>
      </section>

      <div className="dap-footer">
        <button className="dap-btn dap-btnPrimary" type="button" disabled={!state.dirty || state.saving || !state.writable} onClick={() => { actions.save() }}>{state.saving ? t('saving') : t('save')}</button>
        <button className="dap-btn" type="button" disabled={!state.dirty || state.saving} onClick={() => { actions.discard() }}>{t('discard')}</button>
        {state.notice !== undefined
          ? <span className={state.notice.kind === 'error' ? 'dap-err' : 'dap-ok'}>{state.notice.text === 'saved' ? t('saved') : state.notice.text}</span>
          : state.dirty ? <span className="dap-hint">{t('unsaved')}</span> : null}
      </div>
    </div>
  )
}
