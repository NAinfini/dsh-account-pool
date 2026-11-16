/**
 * Builds the pi-ai route profile for an OpenAI-Chat-Completions provider
 * (OpenCode Go, Open Design). The harness ships `PiAiAdapter` but keeps its
 * profile resolver private, so the one route each of these providers needs is
 * materialized here.
 *
 * @module dsh-account-pool/providers/openai-compat/profile
 */

import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createProvider, type Model } from '@earendil-works/pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

import { RETRY_MAX_DELAY_MS } from '../../pool/account-pool.ts'

const API = 'openai-completions'
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** One model this route can serve. */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly string[]
  /** Level → wire spelling; `false` marks a non-reasoning model. */
  reasoningEfforts?: Record<string, string | null> | false
}

export interface RouteSpec {
  provider: string
  displayName: string
  baseUrl: string
  models: readonly ModelEntry[]
  headers?: Record<string, string> | undefined
  timeoutMs?: number | undefined
  streamIdleTimeoutMs?: number | undefined
}

/** pi-ai's own catalog entries for a provider id (empty when it ships none). */
function builtinCatalog(provider: string): Map<string, Model<never>> {
  const out = new Map<string, Model<never>>()
  try {
    for (const model of getBuiltinModels(provider as never) as unknown as readonly Model<never>[]) out.set(model.id, model)
  } catch {
    // The provider has no installed catalog; every model is declared outright.
  }
  return out
}

/** Ids pi-ai ships for a provider, for the empty-configuration fallback. */
export function builtinModelIds(provider: string): string[] {
  return [...builtinCatalog(provider).keys()]
}

function reasoningOf(
  entry: ModelEntry,
  base: Model<never> | undefined,
  sameApi: boolean,
): { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } {
  const efforts = entry.reasoningEfforts
  if (efforts === false) return { reasoning: false }
  if (efforts !== undefined && Object.keys(efforts).length > 0) {
    const map: Record<string, string | null> = {}
    for (const level of THINKING_LEVELS) {
      const wire = efforts[level]
      if (wire === undefined) map[level] = null
      else if (wire !== null) map[level] = wire
    }
    return { reasoning: true, thinkingLevelMap: map }
  }
  if (base === undefined) return { reasoning: false }
  return {
    reasoning: base.reasoning,
    ...(sameApi && base.thinkingLevelMap !== undefined ? { thinkingLevelMap: base.thinkingLevelMap as Record<string, string | null> } : {}),
  }
}

function materialize(entry: ModelEntry, spec: RouteSpec, catalog: Map<string, Model<never>>): Model<'openai-completions'> {
  const base = catalog.get(entry.id)
  const sameApi = base !== undefined && base.api === API
  const reasoning = reasoningOf(entry, base, sameApi)
  const input = entry.input !== undefined && entry.input.length > 0 ? [...entry.input] : [...(base?.input ?? ['text'])]
  const model: Model<'openai-completions'> = {
    id: entry.id,
    name: entry.name ?? base?.name ?? entry.id,
    api: API,
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    reasoning: reasoning.reasoning,
    input: input as ('text' | 'image')[],
    cost: base?.cost ?? NO_COST,
    contextWindow: entry.contextWindow ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? base?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
  if (reasoning.thinkingLevelMap !== undefined) model.thinkingLevelMap = reasoning.thinkingLevelMap
  if (sameApi && base?.compat !== undefined) model.compat = base.compat
  if (sameApi && base?.samplingParams !== undefined) model.samplingParams = base.samplingParams
  if (sameApi && base?.headers !== undefined) model.headers = base.headers
  return model
}

/**
 * The resolved profile for one route. The retry policy keeps the harness's
 * normal mode but raises `maxDelayMs` to the pool's cap, so an all-accounts
 * `RATE_LIMIT` carrying `providerRetryAfterMs` sleeps through the window
 * instead of abandoning the retry.
 */
export function buildProfile(spec: RouteSpec): ResolvedPiAiProviderProfile {
  const catalog = builtinCatalog(spec.provider)
  const models = spec.models.map((entry) => materialize(entry, spec, catalog))
  const provider = createProvider({
    id: spec.provider,
    name: spec.displayName,
    baseUrl: spec.baseUrl,
    auth: {
      apiKey: {
        name: spec.displayName,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: spec.displayName,
        }),
      },
    },
    models,
    api: openAICompletionsApi(),
  })
  const configuredMaxTokens = new Map<string, number>()
  for (const entry of spec.models) {
    if (typeof entry.maxTokens === 'number') configuredMaxTokens.set(entry.id, entry.maxTokens)
  }
  const profile: ResolvedPiAiProviderProfile = {
    provider: spec.provider,
    displayName: spec.displayName,
    streamIdleTimeoutMs: spec.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 5,
      backoff: { initialDelayMs: 500, maxDelayMs: RETRY_MAX_DELAY_MS, jitterRatio: 0.1 },
    }, `llm-account-pool:${spec.provider}`),
    piProvider: provider,
    modelErrors: new Map(),
    configuredMaxTokens,
  }
  if (spec.headers !== undefined && Object.keys(spec.headers).length > 0) profile.headers = spec.headers
  if (spec.timeoutMs !== undefined) profile.timeoutMs = spec.timeoutMs
  return profile
}
