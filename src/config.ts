/**
 * Plugin configuration. One document, one section per provider, plus the
 * rotation policy they share. Every field is optional: defaults resolve at
 * read time, and the settings page writes keys through the credentials seam
 * (never into this document).
 *
 * @module dsh-account-pool/config
 */

import z from '@deepseek-ai/schemastery'

/** One extra account: a credential reference (stored key) or a composition-only literal. */
export interface AccountConfig {
  label?: string
  apiKeyEnv?: string
  apiKey?: string
}

/** Fields every provider section shares. */
export interface ProviderConfig {
  /** Endpoint root; defaults per provider. */
  apiBase?: string
  /**
   * Accounts in rotation order. The list IS the account list; when it is empty
   * the provider's default credential reference stands in as a single account.
   */
  accounts?: AccountConfig[]
  /** Pinned account slot id; empty means automatic rotation. */
  activeAccount?: string
  /** Visible-model allowlist; empty shows the whole catalog. */
  visibleModels?: string[]
  /** Model → account routing (first match wins; ignored while an account is pinned). */
  modelAccountRules?: { models?: string[]; account?: string }[]
  headers?: Record<string, string>
  requestTimeoutMs?: number
  streamIdleTimeoutMs?: number
}

export interface OpenCodeConfig extends ProviderConfig {
  /** The Go plan's monthly allowance in USD (turns the gateway's percentages into dollars). */
  monthlyUsd?: number
}

export interface CommandCodeConfig extends ProviderConfig {
  /** Working directory reported to the gateway; defaults to the process directory. */
  workingDir?: string
}

export interface Config {
  /** Global account order as `provider:slotId`; accounts not listed follow in configured order. */
  order?: string[]
  rotation?: {
    /** Skip an account once any window reaches this percentage; 100 = only when exhausted. */
    switchAtPercent?: number
    /** Pause for a 429 nobody explained, in ms. */
    cooldownMs?: number
  }
  opencode?: OpenCodeConfig
  opendesign?: ProviderConfig
  commandcode?: CommandCodeConfig
}

const account = z.object({
  label: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  apiKey: z.string().role('secret'),
})

const rule = z.object({ models: z.array(z.string()), account: z.string() })

// Only `volatile` fields are exposed to the settings page, and a change to one
// is applied live instead of reloading the plugin. They arrive as references:
// read them through `plainConfig`.
const provider = {
  apiBase: z.string().volatile(),
  accounts: z.array(account).volatile(),
  activeAccount: z.string().volatile(),
  visibleModels: z.array(z.string()).volatile(),
  modelAccountRules: z.array(rule).volatile(),
  headers: z.dict(z.string()),
  requestTimeoutMs: z.number(),
  streamIdleTimeoutMs: z.number(),
}

export const Config = z.object({
  order: z.array(z.string()).volatile(),
  rotation: z.object({
    switchAtPercent: z.number().min(1).max(100).default(100).volatile(),
    cooldownMs: z.number().min(1000).default(300_000).volatile(),
  }),
  opencode: z.object({ ...provider, monthlyUsd: z.number().min(1).default(60) }),
  opendesign: z.object(provider),
  commandcode: z.object({ ...provider, workingDir: z.string() }),
})

const isReference = (value: unknown): value is { get(): unknown } =>
  typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'

/** The live config as plain data: every volatile reference replaced by its current snapshot. */
export function plainConfig(raw: unknown): Config {
  const read = (value: unknown): unknown => {
    if (isReference(value)) return read(value.get())
    if (Array.isArray(value)) return value.map(read)
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, read(child)]))
    return value
  }
  return read(raw) as Config
}
