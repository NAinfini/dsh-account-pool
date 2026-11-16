/**
 * OpenCode Go: quota from `GET {apiBase}/usage`.
 *
 * The gateway reports three windows — `rolling` (5 hours), `weekly`, `monthly`
 * — each as `{ status, percent, resetsAt }`. It reports percentages only; the
 * plan publishes its allowance as a monthly dollar amount with the 5-hour
 * window at 20 % and the weekly window at 50 % of it, so dollar figures are
 * derived from `monthlyUsd` and always marked as estimated.
 *
 * @module dsh-account-pool/providers/opencode/driver
 */

import type { QuotaSnapshot, QuotaWindow, WindowKind } from '../../pool/types.ts'
import type { ProviderDriver, QuotaRequest } from '../driver.ts'

export const OPENCODE_API_BASE = 'https://opencode.ai/zen/go/v1'

/** Fraction of the monthly allowance each window holds. */
const WINDOW_SHARE: Record<WindowKind, number> = { '5h': 0.2, '7d': 0.5, '30d': 1 }

const SOURCE_FIELDS: readonly [WindowKind, string][] = [['5h', 'rolling'], ['7d', 'weekly'], ['30d', 'monthly']]

function readWindow(kind: WindowKind, source: unknown, monthlyUsd: number | undefined): QuotaWindow | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const status = typeof record.status === 'string' ? record.status : ''
  const percent = typeof record.percent === 'number' && Number.isFinite(record.percent)
    ? Math.max(0, Math.min(100, record.percent))
    : undefined
  const resetAt = typeof record.resetsAt === 'string' ? Date.parse(record.resetsAt) : NaN
  const window: QuotaWindow = {
    kind,
    estimated: true,
    source: 'provider',
    status: status === '' ? 'unknown' : status === 'ok' ? 'ok' : 'limited',
  }
  if (percent !== undefined) window.percent = percent
  if (Number.isFinite(resetAt)) window.resetAt = resetAt
  if (percent !== undefined && monthlyUsd !== undefined && monthlyUsd > 0) {
    const cap = monthlyUsd * WINDOW_SHARE[kind]
    window.cap = cap
    window.used = (percent / 100) * cap
  }
  return window
}

/** Parse one `/usage` answer; throws on a payload that is not a usage document. */
export function parseOpenCodeUsage(payload: unknown, monthlyUsd: number | undefined, fetchedAt: number): QuotaSnapshot {
  const usage = typeof payload === 'object' && payload !== null ? (payload as { usage?: unknown }).usage : undefined
  if (typeof usage !== 'object' || usage === null) throw new Error('usage response carries no usage block')
  const record = usage as Record<string, unknown>
  const windows: QuotaWindow[] = []
  for (const [kind, field] of SOURCE_FIELDS) {
    const window = readWindow(kind, record[field], monthlyUsd)
    if (window !== undefined) windows.push(window)
  }
  return { windows, fetchedAt }
}

export const opencodeDriver: ProviderDriver = {
  id: 'opencode',
  displayName: 'OpenCode Go',
  async fetchQuota(request: QuotaRequest): Promise<QuotaSnapshot> {
    const root = request.apiBase.replace(/\/+$/, '')
    const response = await (request.fetchImpl ?? fetch)(`${root}/usage`, {
      headers: { authorization: `Bearer ${request.key}` },
      signal: request.signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET ${root}/usage failed with HTTP ${response.status}`)
    return parseOpenCodeUsage(await response.json(), request.monthlyUsd, Date.now())
  },
}
