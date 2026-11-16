/**
 * Display arithmetic shared by every surface. Pure, so it can be tested
 * without a DOM.
 *
 * @module dsh-account-pool/client/format
 */

import type { AccountReport, ProviderReport } from '../remote/wire.ts'

export type Tone = 'ok' | 'warn' | 'limit' | 'none'

/** Bars turn amber from 80 % and red at 100 %; no ratio, no colour. */
export function toneOf(percent: number | undefined): Tone {
  if (percent === undefined) return 'none'
  if (percent >= 100) return 'limit'
  if (percent >= 80) return 'warn'
  return 'ok'
}

/** Bar fill width in whole percent, clamped; an absent ratio draws nothing. */
export function fillOf(percent: number | undefined): number {
  if (percent === undefined || !Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

export function formatPercent(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) return '—'
  return `${Number(Math.min(percent, 999).toFixed(percent < 10 ? 1 : 0))}%`
}

/** `2h13m` / `4d6h` / `45m` / `<1m`; empty for a moment already past. */
export function formatRemaining(until: number | undefined, now: number): string {
  if (until === undefined || until <= now) return ''
  const minutes = Math.ceil((until - now) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/** Clock time for today, short date otherwise. */
export function formatMoment(at: number, now: number, locale?: string): string {
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
}

/** Compact token count: 1.9M / 384K. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(1))}B`
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}K`
  return String(Math.round(value))
}

export function formatCount(value: number): string {
  return Number.isFinite(value) && value > 0 ? Math.round(value).toLocaleString('en-US') : '0'
}

export interface Overview {
  ok: number
  parked: number
  disabled: number
  unconfigured: number
  /** Earliest moment a parked account returns, when any is parked and one is known. */
  earliestReturn: number | undefined
  /** No account anywhere can serve right now. */
  allDown: boolean
}

/** Account counts across providers (an unconfigured slot is not an account that can fail). */
export function overviewOf(providers: readonly ProviderReport[]): Overview {
  const out: Overview = { ok: 0, parked: 0, disabled: 0, unconfigured: 0, earliestReturn: undefined, allDown: false }
  for (const provider of providers) {
    for (const account of provider.accounts) {
      if (account.status === 'ok') out.ok += 1
      else if (account.status === 'disabled') out.disabled += 1
      else if (account.status === 'unconfigured') out.unconfigured += 1
      else {
        out.parked += 1
        if (account.until !== undefined && (out.earliestReturn === undefined || account.until < out.earliestReturn)) out.earliestReturn = account.until
      }
    }
  }
  out.allDown = out.ok === 0 && out.parked + out.disabled > 0
  return out
}

/** The account that serves next within one provider, if any. */
export function servingOf(provider: ProviderReport): AccountReport | undefined {
  return provider.accounts.find((account) => account.serving)
}

/** Last four characters shown to tell keys apart; never the key. */
export function keyHint(configured: boolean): string {
  return configured ? '••••' : ''
}
