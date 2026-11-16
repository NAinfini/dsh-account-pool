/**
 * A rotating wrapper around one provider's inner adapter.
 *
 * The inner adapter owns the wire protocol, streaming, tool calls, reasoning
 * and images. This class adds, per request, the choice of account from the
 * provider's pool; the rotation loop itself lives in `../rotate.ts`.
 *
 * @module dsh-account-pool/providers/openai-compat/rotating-adapter
 */

import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { AccountPool } from '../../pool/account-pool.ts'
import type { UsageLedger } from '../../pool/ledger.ts'
import type { ProviderId } from '../../pool/types.ts'
import { rotateStream } from '../rotate.ts'

export interface RotatingAdapterDeps {
  provider: ProviderId
  /** The adapter that owns the wire protocol; it reads its key from the bound call context. */
  inner: LlmAdapter
  pool: AccountPool
  ledger: UsageLedger
  /** Allowlist of model ids shown in pickers; empty/undefined shows all. */
  visibleModels?: () => readonly string[] | undefined
  onRotate?: (info: { slotId: string; reason: string }) => void
}

export class RotatingAdapter extends LlmAdapter {
  private readonly deps: RotatingAdapterDeps

  constructor(deps: RotatingAdapterDeps) {
    super()
    this.deps = deps
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.deps.inner.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.deps.inner.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.deps.inner.listModels(provider)
    const visible = this.deps.visibleModels?.()
    if (visible === undefined || visible.length === 0) return models
    const allowed = new Set(visible)
    return models.filter((model) => allowed.has(model.id))
  }

  /** Every model the route serves, ignoring the visibility allowlist (for the settings picker). */
  allModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.deps.inner.listModels(provider)
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.deps.inner.resolveModel(provider, model, signal)
  }

  /** Bind the call to this adapter's `stream`; the inner prepared call would bypass rotation. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.deps.inner.prepareCall(provider, model, signal)
    return { model: prepared.model, stream: (options: GenerateOptions) => this.stream(options) }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { pool, inner, provider } = this.deps
    return rotateStream({
      next: async (tried) => {
        // `tried` holds keys: this source offers one provider's accounts.
        const selection = await pool.acquire({ model: options.model, exclude: tried })
        if (selection === undefined) return undefined
        const { account } = selection
        return { id: account.key, key: account.key, slotId: account.slot.id, provider, pool, inner, options }
      },
    }, this.deps.ledger, this.deps.onRotate)
  }
}
