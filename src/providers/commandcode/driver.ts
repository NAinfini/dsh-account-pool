/**
 * Command Code quota: `GET {apiBase}/alpha/billing/credits`.
 *
 * The answer carries `windowLimits.fiveHour` and `windowLimits.weekly`, each
 * `{ used, cap, exceeded, resetAt }` in USD with `resetAt` in epoch ms. A window
 * the endpoint omits is simply absent here (an unlimited plan has no such
 * window), and `cap: 0` means uncapped spend: it keeps its amounts but has no
 * percentage, so it can never be drawn as "0 % used".
 *
 * @module dsh-account-pool/providers/commandcode/driver
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

import type { QuotaSnapshot, QuotaWindow, WindowKind } from '../../pool/types.ts'
import type { ProviderDriver, QuotaRequest } from '../driver.ts'
import { COMMAND_CODE_CLI_VERSION, DEFAULT_API_BASE } from './wire.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Epoch seconds and epoch milliseconds are both seen in the wild; normalize to ms. */
function toEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined
  return value < 1e11 ? value * 1000 : value
}

function readWindow(kind: WindowKind, source: unknown): QuotaWindow | undefined {
  if (!isRecord(source)) return undefined
  const used = num(source.used)
  const cap = num(source.cap)
  const resetAt = toEpochMs(num(source.resetAt))
  const window: QuotaWindow = {
    kind,
    estimated: false,
    source: 'provider',
    status: source.exceeded === true ? 'limited' : 'ok',
  }
  if (used !== undefined) window.used = used
  if (cap !== undefined) window.cap = cap
  if (used !== undefined && cap !== undefined && cap > 0) window.percent = Math.max(0, Math.min(100, (used / cap) * 100))
  if (source.exceeded === true && window.percent === undefined) window.percent = 100
  if (resetAt !== undefined) window.resetAt = resetAt
  return window
}

/** Parse one credits payload; throws when it carries neither limits nor credits. */
export function parseCredits(payload: unknown, fetchedAt: number): QuotaSnapshot {
  if (!isRecord(payload)) throw new Error('credits response is not an object')
  const limits = isRecord(payload.windowLimits) ? payload.windowLimits : undefined
  if (limits === undefined && !isRecord(payload.credits)) throw new Error('credits response carries no limits')
  const windows: QuotaWindow[] = []
  const five = readWindow('5h', limits?.fiveHour)
  const weekly = readWindow('7d', limits?.weekly)
  if (five !== undefined) windows.push(five)
  if (weekly !== undefined) windows.push(weekly)
  return { windows, fetchedAt }
}

/** Headers every authenticated account endpoint shares. */
export function accountHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'x-command-code-version': COMMAND_CODE_CLI_VERSION,
    'x-cli-environment': 'production',
    ...attributionHeaders(),
  }
}

export const commandcodeDriver: ProviderDriver = {
  id: 'commandcode',
  displayName: 'Command Code',
  async fetchQuota(request: QuotaRequest): Promise<QuotaSnapshot> {
    const root = (request.apiBase === '' ? DEFAULT_API_BASE : request.apiBase).replace(/\/+$/, '')
    const response = await (request.fetchImpl ?? fetch)(`${root}/alpha/billing/credits`, {
      headers: accountHeaders(request.key),
      signal: request.signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GET ${root}/alpha/billing/credits failed with HTTP ${response.status}`)
    return parseCredits(await response.json(), Date.now())
  },
}
