/**
 * The two surfaces outside settings: the sidebar footer card and the usage
 * panel it opens in the main area.
 *
 * @module dsh-account-pool/client/surfaces
 */

import { useEffect } from 'react'

import type { PageState } from './controller.ts'
import { QuotaRows, StatusBadge } from './components.tsx'
import { formatCount, formatMoment, formatTokens, overviewOf, servingOf } from './format.ts'
import type { Translate } from './locales.ts'
import { providerMeta } from './providers.ts'

export const PANEL_ID = 'dsh-account-pool'
const AUTO_REFRESH_MS = 120_000

export interface CardProps {
  t: Translate
  wide?: boolean
  usePool<T>(selector: (state: PageState) => T): T
  openPanel(): void
}

/** Footer card: how many accounts can still serve. Collapses to a dot in the narrow rail. */
export function PoolCard({ t, wide = true, usePool, openPanel }: CardProps) {
  const report = usePool((state) => state.report)
  if (report === undefined) return null
  const overview = overviewOf(report.providers)
  if (overview.ok + overview.parked + overview.disabled === 0) return null
  const tone = overview.ok === 0 ? 'dap-badgeBad' : overview.parked + overview.disabled > 0 ? 'dap-badgeWarn' : 'dap-badgeOk'
  const spare = Math.max(0, overview.ok - 1)
  const summary = overview.ok === 0 ? t('cardNone') : t('cardBackups', { ok: spare, parked: overview.parked + overview.disabled })
  return (
    <button className="dap-card" type="button" aria-label={t('cardOpen')} title={summary} onClick={openPanel}>
      <span className={`dap-cardHead ${tone}`}>
        <span className="dap-dot" aria-hidden="true" />
        {wide ? <span>{t('nav')}</span> : null}
      </span>
      {wide ? <span className="dap-cardSub">{summary}</span> : null}
    </button>
  )
}

export interface PanelProps {
  t: Translate
  usePool<T>(selector: (state: PageState) => T): T
  refresh(): void
  close(): void
}

/** Read-only overview of every account, refreshed while open. */
export function UsagePanel({ t, usePool, refresh, close }: PanelProps) {
  const state = usePool((value) => value)
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, AUTO_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [])
  const now = Date.now()
  const providers = state.report?.providers ?? []
  const overview = overviewOf(providers)
  const totals = providers.flatMap((provider) => provider.accounts).reduce(
    (sum, account) => ({ requests: sum.requests + account.usage.last24h.requests, tokens: sum.tokens + account.usage.last24h.totalTokens }),
    { requests: 0, tokens: 0 },
  )
  return (
    <div className="dap-panel">
      <div className="dap-head">
        <div>
          <h2 className="dap-title">{t('panelTitle')}</h2>
          <p className="dap-hint">
            {t('summaryOk', { n: overview.ok })} · {t('summaryParked', { n: overview.parked })} · {t('summaryDisabled', { n: overview.disabled })}
            {' · '}{t('panelTotals', { requests: formatCount(totals.requests), tokens: formatTokens(totals.tokens) })}
          </p>
          <p className="dap-hint">{t('panelAuto')}{state.reportAt === undefined ? '' : ` · ${t('updatedAt', { time: formatMoment(state.reportAt, now) })}`}</p>
        </div>
        <div className="dap-actions">
          <button className="dap-btn" type="button" disabled={state.refreshing} onClick={refresh}>{state.refreshing ? t('refreshing') : t('refresh')}</button>
          <button className="dap-btn" type="button" onClick={close}>{t('panelClose')}</button>
        </div>
      </div>
      {state.reportError !== undefined ? <p className="dap-banner dap-bannerError">{t('reportError', { message: state.reportError })}</p> : null}
      {providers.filter((provider) => provider.accounts.length > 0).map((provider) => {
        const meta = providerMeta(provider.provider)
        const serving = servingOf(provider)
        return (
          <section className="dap-provider" key={provider.provider}>
            <h3 className="dap-sectionTitle">{provider.displayName}</h3>
            {provider.accounts.map((account) => (
              <div className={`dap-account${account === serving ? ' dap-accountServing' : ''}`} key={account.id}>
                <div className="dap-accountHead">
                  <span className="dap-accountName">{account.label}</span>
                  {account === serving ? <span className="dap-badge dap-badgeBrand">{account.pinned ? t('pinned') : t('current')}</span> : null}
                  <StatusBadge account={account} t={t} />
                  {account.until !== undefined && account.status !== 'ok' ? <span className="dap-hint">{t('returnsAt', { time: formatMoment(account.until, now) })}</span> : null}
                </div>
                {meta === undefined ? null : <QuotaRows account={account} meta={meta} t={t} now={now} />}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
