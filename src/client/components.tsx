/**
 * Pieces shared by the settings page, the sidebar card and the usage panel.
 *
 * @module dsh-account-pool/client/components
 */

import type { AccountReport } from '../remote/wire.ts'
import { fillOf, formatPercent, formatRemaining, toneOf } from './format.ts'
import type { CopyKey, Translate } from './locales.ts'
import type { ProviderMeta } from './providers.ts'

const STATE_COPY: Record<AccountReport['status'], CopyKey> = {
  ok: 'stateOk',
  cooldown: 'stateCooldown',
  exhausted: 'stateExhausted',
  disabled: 'stateDisabled',
  unconfigured: 'stateUnconfigured',
}

const STATE_CLASS: Record<AccountReport['status'], string> = {
  ok: 'dap-badge dap-badgeOk',
  cooldown: 'dap-badge dap-badgeWarn',
  exhausted: 'dap-badge dap-badgeWarn',
  disabled: 'dap-badge dap-badgeBad',
  unconfigured: 'dap-badge',
}

/** Status chip: a dot and a word, never colour alone. */
export function StatusBadge({ account, t }: { account: AccountReport; t: Translate }) {
  return (
    <span className={STATE_CLASS[account.status]}>
      <span className="dap-dot" aria-hidden="true" />
      {t(STATE_COPY[account.status])}
    </span>
  )
}

const WINDOW_COPY = { '5h': 'window5h', '7d': 'window7d', '30d': 'window30d' } as const

/** One bar per window the provider meters; a window it did not report reads "n/a". */
export function QuotaRows({ account, meta, t, now }: { account: AccountReport; meta: ProviderMeta; t: Translate; now: number }) {
  if (account.status === 'unconfigured') return null
  const { quota } = account
  return (
    <div className="dap-quotas">
      {meta.windows.map((kind) => {
        const window = quota?.windows.find((candidate) => candidate.kind === kind)
        const percent = window?.percent
        const tone = toneOf(percent)
        const label = t(WINDOW_COPY[kind])
        const reset = window?.resetAt === undefined ? '' : t('resetsIn', { time: formatRemaining(window.resetAt, now) })
        return (
          <div className="dap-quota" key={kind}>
            <span className="dap-quotaLabel">{label}</span>
            <div className="dap-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === undefined ? undefined : fillOf(percent)}>
              <span
                className={`dap-barFill${tone === 'warn' ? ' dap-barWarn' : tone === 'limit' ? ' dap-barLimit' : tone === 'none' ? ' dap-barNone' : ''}`}
                style={{ width: `${fillOf(percent)}%` }}
              />
            </div>
            <span>{percent === undefined ? t('noWindow') : `${formatPercent(percent)}${window?.estimated === true ? '*' : ''}`}</span>
            <span className="dap-quotaReset">{reset}</span>
          </div>
        )
      })}
      {quota?.error !== undefined ? <p className="dap-hint dap-err">{t('quotaError', { message: quota.error })}</p> : null}
    </div>
  )
}
