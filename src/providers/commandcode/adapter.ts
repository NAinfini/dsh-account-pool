/**
 * The Command Code adapter: one request, one key, one `/alpha/generate`
 * stream. Key choice, rotation and usage attribution belong to the rotating
 * wrapper; this class reads the key bound to its own call
 * ({@link boundKey}) and speaks the wire protocol.
 *
 * Failures that happen before the first chunk are thrown as `LlmError`s so the
 * wrapper can classify them; a stream that dies mid-way also throws, and the
 * wrapper then surfaces it instead of replaying it on another account.
 *
 * Image input is not offered on this route yet: the catalog is advertised as
 * text-only, and any image already in the history is replaced with the
 * harness's deterministic placeholder text before it reaches the wire.
 *
 * @module dsh-account-pool/providers/commandcode/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  projectFilesToText,
  projectImagesForTextModel,
  projectToolUpdates,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { RETRY_MAX_DELAY_MS } from '../../pool/account-pool.ts'
import { boundKey } from '../../pool/call-key.ts'
import { KNOWN_EFFORTS } from './efforts.ts'
import {
  buildBody,
  COMMAND_CODE_CLI_VERSION,
  createAssembler,
  DEFAULT_GENERATE_MAX_TOKENS,
  handleEvent,
  httpError,
  parseEventLine,
  parseRetryAfterMs,
  projectSlugFromPath,
  systemTextOf,
  type CatalogModel,
} from './wire.ts'

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export interface CommandCodeAdapterDeps {
  provider: string
  displayName: string
  apiBase(): string
  workingDir(): string
  requestTimeoutMs(): number | undefined
  streamIdleTimeoutMs(): number | undefined
  /** The current catalog; empty until discovery answers. */
  models(): readonly CatalogModel[]
  fetchImpl?: typeof fetch
}

const EFFORT_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

export class CommandCodeAdapter extends LlmAdapter {
  private readonly deps: CommandCodeAdapterDeps
  private readonly policy: ResolvedRetryPolicy

  constructor(deps: CommandCodeAdapterDeps) {
    super()
    this.deps = deps
    // Normal mode with the pool's wait cap, so an all-accounts RATE_LIMIT that
    // names a reset sleeps through it instead of abandoning the retry.
    this.policy = resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 5,
      backoff: { initialDelayMs: 500, maxDelayMs: RETRY_MAX_DELAY_MS, jitterRatio: 0.1 },
    }, `llm-account-pool:${deps.provider}`)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.deps.displayName }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.deps.models().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.deps.models().find((candidate) => candidate.id === model)
    const efforts = KNOWN_EFFORTS[model]
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'],
      ...(entry === undefined ? {} : { context: { contextWindow: entry.contextWindow }, defaultMaxTokens: Math.min(entry.maxTokens, DEFAULT_GENERATE_MAX_TOKENS) }),
      ...(efforts === undefined || efforts.length === 0
        ? {}
        : { reasoning: { efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: EFFORT_NAMES[effort] ?? effort })) } }),
    })
  }

  /** The request history as the wire sees it: tool updates resolved, files and images reduced to text. */
  private projected(options: GenerateOptions): { messages: readonly RequestMessage[]; tools: GenerateOptions['tools'] } {
    const updates = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
    const files = projectFilesToText(updates.messages, () => undefined)
    return { messages: projectImagesForTextModel(files), tools: updates.tools === undefined ? undefined : [...updates.tools] }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const key = boundKey()
    if (key === undefined) {
      throw new LlmError('llm-account-pool:commandcode: no account key is bound to this request', 'MISSING_CREDENTIAL')
    }
    const { deps } = this
    const apiBase = deps.apiBase().replace(/\/+$/, '')
    const entry = deps.models().find((candidate) => candidate.id === options.model)
    const { messages, tools } = this.projected(options)
    const efforts = KNOWN_EFFORTS[options.model]
    const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    const body = buildBody({
      model: options.model,
      messages,
      system: systemTextOf(messages, options.system),
      tools,
      maxTokens: Math.min(options.maxTokens ?? DEFAULT_GENERATE_MAX_TOKENS, entry?.maxTokens ?? Number.POSITIVE_INFINITY),
      temperature: options.temperature,
      reasoningEffort: effort !== undefined && efforts?.includes(effort) === true ? effort : undefined,
      workingDir: deps.workingDir(),
    })

    const endpoint = `${apiBase}/alpha/generate`
    const requestTimeoutMs = deps.requestTimeoutMs() ?? DEFAULT_REQUEST_TIMEOUT_MS
    const idleTimeoutMs = deps.streamIdleTimeoutMs() ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const abort = new AbortController()
    const onCallerAbort = (): void => { abort.abort(options.signal?.reason) }
    if (options.signal?.aborted === true) onCallerAbort()
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      abort.abort(new DOMException(`request to ${endpoint} did not respond within ${requestTimeoutMs}ms`, 'TimeoutError'))
    }, requestTimeoutMs)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let idleFired = false
    const cleanup = (): void => {
      clearTimeout(connectTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }

    try {
      let response: Response
      try {
        response = await (deps.fetchImpl ?? fetch)(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'x-command-code-version': COMMAND_CODE_CLI_VERSION,
            'x-cli-environment': 'production',
            'x-project-slug': projectSlugFromPath(deps.workingDir()),
            'x-taste-learning': 'true',
            'x-co-flag': 'false',
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        })
      } catch (error: unknown) {
        if (options.signal?.aborted === true) throw error
        const cause = error instanceof Error ? error.message : String(error)
        if (connectTimedOut) {
          throw new LlmError(`Command Code API request to ${endpoint} did not respond within ${requestTimeoutMs}ms；Command Code API 请求在 ${requestTimeoutMs} 毫秒内未收到响应`, 'TIMEOUT', { cause: error })
        }
        throw new LlmError(`Command Code API request to ${endpoint} failed: ${cause}；Command Code API 请求连接失败，请检查网络或代理`, 'TRANSPORT', { cause: error })
      }
      clearTimeout(connectTimer)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw httpError(response.status, text, parseRetryAfterMs(response.headers.get('retry-after')))
      }
      if (response.body === null) throw new LlmError('Command Code API returned no response body', 'PROVIDER_PROTOCOL_ERROR')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const armIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleFired = true
          void reader.cancel().catch(() => undefined)
        }, idleTimeoutMs)
      }
      const assembler = createAssembler()
      let buffer = ''
      let finished = false
      armIdle()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            for (const chunk of handleEvent(assembler, parseEventLine(line))) {
              if (chunk.type === 'finish') finished = true
              yield chunk
            }
          }
        }
        buffer += decoder.decode()
        for (const chunk of handleEvent(assembler, parseEventLine(buffer))) {
          if (chunk.type === 'finish') finished = true
          yield chunk
        }
      } catch (error: unknown) {
        if (idleFired) {
          throw new LlmError(`Command Code stream produced no data for ${idleTimeoutMs}ms；Command Code 响应流在 ${idleTimeoutMs} 毫秒内无数据`, 'TIMEOUT', { cause: error })
        }
        throw error
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      if (!finished) {
        throw new LlmError('Command Code stream ended without a finish event；Command Code 响应流未正常结束', 'TRANSPORT')
      }
    } finally {
      cleanup()
    }
  }
}
