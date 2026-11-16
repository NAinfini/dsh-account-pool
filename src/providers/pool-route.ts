/**
 * The cross-provider `pool` route: one model id, every account of every
 * provider that serves it, tried in the global account order.
 *
 * The route owns no accounts. Each attempt is delegated to the owning
 * provider's own pool and inner adapter (the model id translated to that
 * provider's spelling), so quota preflight, cooldowns, invalid-key marks and
 * the usage ledger stay exactly where they are for the per-provider routes.
 *
 * @module dsh-account-pool/providers/pool-route
 */

import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { exhaustedError } from '../pool/account-pool.ts'
import type { UsageLedger } from '../pool/ledger.ts'
import { entryKey, normalizeModelId, POOL_PROVIDER, sharedModelIds, sortByOrder } from '../pooling.ts'
import type { ProviderHandle } from './pool-wiring.ts'
import { rotateStream, type Attempt } from './rotate.ts'

export interface PoolRouteDeps {
  members: readonly ProviderHandle[]
  ledger: UsageLedger
  order(): readonly string[]
  now?(): number
  onRotate?: (info: { slotId: string; reason: string }) => void
}

/** One account that could serve the model, with the model as its provider spells it. */
interface Candidate {
  member: ProviderHandle
  slotId: string
  key: string
  native: string
}

export class PoolRouteAdapter extends LlmAdapter {
  private readonly deps: PoolRouteDeps

  constructor(deps: PoolRouteDeps) {
    super()
    this.deps = deps
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Account pool' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /** The members that hold at least one key, with each one's model catalog. */
  private async catalogs(): Promise<{ member: ProviderHandle; models: readonly LlmModelInfo[] }[]> {
    const out: { member: ProviderHandle; models: readonly LlmModelInfo[] }[] = []
    for (const member of this.deps.members) {
      if ((await member.pool.resolved()).length === 0) continue
      out.push({ member, models: await member.models().catch((): readonly LlmModelInfo[] => []) })
    }
    return out
  }

  /** Models at least two providers serve; the id is the provider-neutral spelling. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalogs = await this.catalogs()
    return sharedModelIds(catalogs.map(({ models }) => models.map((model) => model.id))).map((id) => {
      const first = catalogs.flatMap(({ models }) => models).find((model) => normalizeModelId(model.id) === id)
      return { ...(first as LlmModelInfo), provider, id, name: first?.name ?? id }
    })
  }

  /** The first member (in provider order) that serves `model`, with its native model info. */
  private async anyMember(model: string): Promise<{ member: ProviderHandle; native: LlmModelInfo }> {
    const wanted = normalizeModelId(model)
    for (const { member, models } of await this.catalogs()) {
      const native = models.find((candidate) => normalizeModelId(candidate.id) === wanted)
      if (native !== undefined) return { member, native }
    }
    throw new LlmError(`llm-account-pool: no configured account serves "${model}" through the pool route`, 'MISSING_CREDENTIAL')
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const { member, native } = await this.anyMember(model)
    const resolved = await member.inner.resolveModel(member.provider, native.id, signal)
    return { ...resolved, provider, id: model }
  }

  /** Bind the call to this adapter's `stream`; a member's prepared call would bypass the pool. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const { member, native } = await this.anyMember(model)
    const prepared = await member.inner.prepareCall(member.provider, native.id, signal)
    return { model: { ...prepared.model, provider, id: model }, stream: (options: GenerateOptions) => this.stream(options) }
  }

  /** Every account of every member that serves the model, pinned first, then global order. */
  private async candidates(model: string): Promise<{ all: Candidate[]; ready: Candidate[] }> {
    const wanted = normalizeModelId(model)
    const all: Candidate[] = []
    const ready: Candidate[] = []
    for (const { member, models } of await this.catalogs()) {
      const native = models.find((candidate) => normalizeModelId(candidate.id) === wanted)?.id
      if (native === undefined) continue
      const servable = new Set((await member.pool.servable(native)).map((account) => account.key))
      for (const account of await member.pool.resolved()) {
        const candidate = { member, slotId: account.slot.id, key: account.key, native }
        all.push(candidate)
        if (servable.has(account.key)) ready.push(candidate)
      }
    }
    const arrange = (list: Candidate[]): Candidate[] => {
      const ordered = sortByOrder(list, (candidate) => entryKey(candidate.member.provider, candidate.slotId), this.deps.order())
      const pinned = ordered.filter((candidate) => candidate.member.pinned() === candidate.slotId)
      return [...pinned, ...ordered.filter((candidate) => !pinned.includes(candidate))]
    }
    return { all: arrange(all), ready: arrange(ready) }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const idOf = (candidate: Candidate): string => `${candidate.member.provider}|${candidate.key}`
    return rotateStream({
      next: async (tried): Promise<Attempt | undefined> => {
        const { all, ready } = await this.candidates(options.model)
        if (all.length === 0) {
          throw new LlmError(`llm-account-pool: no configured account serves "${options.model}" through the pool route`, 'MISSING_CREDENTIAL')
        }
        const untried = all.filter((candidate) => !tried.has(idOf(candidate)))
        if (untried.length === 0) return undefined
        const chosen = ready.find((candidate) => !tried.has(idOf(candidate)))
        if (chosen === undefined) {
          const reasons = (await Promise.all(untried.map(async (candidate) => {
            const resolved = (await candidate.member.pool.resolved()).find((account) => account.key === candidate.key)
            return resolved === undefined ? undefined : candidate.member.pool.skipReason(resolved, candidate.native)
          })))
          throw exhaustedError(POOL_PROVIDER, reasons, (this.deps.now ?? Date.now)())
        }
        const { member } = chosen
        return {
          id: idOf(chosen),
          key: chosen.key,
          slotId: chosen.slotId,
          provider: member.provider,
          pool: member.pool,
          inner: member.inner,
          options: { ...options, provider: member.provider, model: chosen.native },
        }
      },
    }, this.deps.ledger, this.deps.onRotate)
  }
}
