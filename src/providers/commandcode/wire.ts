/**
 * Command Code wire protocol (`POST /alpha/generate`, the CLI transport).
 *
 * This one transport serves every plan and every model, including the Claude
 * family, so no per-account protocol selection exists. Facts here were
 * measured against the official CLI (command-code@1.54.0); they are written
 * fresh against the 0.2.0 message model, where a tool result is a first-class
 * `role: 'tool'` message and a request may carry identity-free user input.
 *
 * Pure functions only: no I/O, no harness services.
 *
 * @module dsh-account-pool/providers/commandcode/wire
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmError,
  ToolCallId,
  type ContentBlock,
  type FinishReason,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

export const COMMAND_CODE_CLI_VERSION = '1.54.0'
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
export const DEFAULT_GENERATE_MAX_TOKENS = 64_000

/** The gateway rejects tool call ids longer than this. */
const MAX_WIRE_TOOL_CALL_ID_LENGTH = 64

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SCHEMA_DEPTH = 4

function objectShaped(node: Record<string, unknown>): boolean {
  return isRecord(node.properties) || Array.isArray(node.required) || node.additionalProperties !== undefined
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref)
  if (match === null) return undefined
  const table = root[match[1] as string]
  const target = isRecord(table) ? table[match[2] as string] : undefined
  return isRecord(target) ? target : undefined
}

/**
 * The gateway validates only the ROOT of each function schema and refuses a
 * request whose root is not `type: "object"`. Tools registered outside the
 * harness's own `defineTool` can arrive type-less, empty, with a root `$ref`,
 * or as a combinator. Only the root is touched, every path returns a copy, and
 * the walk is depth-bounded so a self-referential schema cannot spin.
 */
export function toolParametersSchema(parameters: unknown, depth = 0): Record<string, unknown> {
  const free = { type: 'object', properties: {}, additionalProperties: true }
  if (!isRecord(parameters) || depth > SCHEMA_DEPTH) return free
  if (parameters.type === 'object') return { ...parameters }
  if (parameters.type === undefined && objectShaped(parameters)) return { ...parameters, type: 'object' }
  if (typeof parameters.$ref === 'string') {
    const target = resolveLocalRef(parameters, parameters.$ref)
    if (target !== undefined) return toolParametersSchema({ ...target, $defs: parameters.$defs, definitions: parameters.definitions }, depth + 1)
    return { ...parameters, type: 'object' }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = parameters[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    const properties: Record<string, unknown> = {}
    const requiredSets: string[][] = []
    for (const branch of branches) {
      const resolved = toolParametersSchema(branch, depth + 1)
      if (isRecord(resolved.properties)) Object.assign(properties, resolved.properties)
      requiredSets.push(Array.isArray(resolved.required) ? resolved.required.filter((name): name is string => typeof name === 'string') : [])
    }
    // allOf: every branch's requirements hold; any/one: only those every branch demands.
    const required = key === 'allOf'
      ? [...new Set(requiredSets.flat())]
      : (requiredSets[0] ?? []).filter((name) => requiredSets.every((set) => set.includes(name)))
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: true }
  }
  return free
}

function wireTools(tools: readonly ToolSchema[] | undefined): unknown[] {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    input_schema: toolParametersSchema(tool.parameters),
  }))
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function blockText(block: ContentBlock): string {
  return block.type === 'text' ? block.text : ''
}

/** Text of every block, concatenated. */
function joinText(content: readonly ContentBlock[]): string {
  return content.map(blockText).join('')
}

/** Cross-provider histories can carry ids the gateway refuses; remap them stably. */
function wireIdFor(id: string): string {
  if (id.length <= MAX_WIRE_TOOL_CALL_ID_LENGTH) return id
  return `call_${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
}

function recordOrEmpty(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The system prompt: leading system messages plus the one-shot `system` option. */
export function systemTextOf(messages: readonly RequestMessage[], system: string | undefined): string {
  const parts: string[] = []
  if (system !== undefined && system !== '') parts.push(system)
  for (const message of messages) {
    if (message.role === 'system') {
      const text = joinText(message.content)
      if (text !== '') parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Convert harness history to the CLI wire shape.
 *
 * Callers must have already projected the history: files and images reduced to
 * text, developer (tool-update) messages dropped. Two pairing rules keep the
 * gateway from rejecting the request: only tool calls that have a result are
 * replayed, and a result whose call is not replayed is dropped. Historical
 * reasoning IS replayed (as `{ type: 'reasoning' }` parts): a DeepSeek
 * thinking-mode tool loop is rejected when its assistant tool calls arrive
 * without their reasoning.
 */
export function messagesToWire(messages: readonly RequestMessage[]): unknown[] {
  const callNames = new Map<string, string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') resultIds.add(message.toolCallId)
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') callNames.set(block.id, block.name)
    }
  }
  const paired = new Set([...callNames.keys()].filter((id) => resultIds.has(id)))

  const out: unknown[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = joinText(message.content)
      if (text !== '') out.push({ role: 'user', content: [{ type: 'text', text }] })
      continue
    }
    if (message.role === 'assistant') {
      const parts: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') parts.push({ type: 'reasoning', text: block.text })
        else if (block.type === 'tool-call' && paired.has(block.id)) {
          parts.push({ type: 'tool-call', toolCallId: wireIdFor(block.id), toolName: block.name, input: recordOrEmpty(block.arguments) })
        }
      }
      if (parts.length > 0) out.push({ role: 'assistant', content: parts })
      continue
    }
    if (message.role === 'tool') {
      if (!paired.has(message.toolCallId)) continue
      const value = joinText(message.content)
      out.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: wireIdFor(message.toolCallId),
          toolName: callNames.get(message.toolCallId) || 'unknown',
          output: message.isError === true ? { type: 'error-text', value } : { type: 'text', value },
        }],
      })
    }
  }
  return out
}

export interface BodyInput {
  model: string
  messages: readonly RequestMessage[]
  system: string
  tools: readonly ToolSchema[] | undefined
  maxTokens: number
  temperature: number | undefined
  reasoningEffort: string | undefined
  workingDir: string
}

/** The CLI transport request body. */
export function buildBody(input: BodyInput): Record<string, unknown> {
  return {
    config: {
      workingDir: input.workingDir,
      date: new Date().toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: input.model,
      messages: messagesToWire(input.messages),
      tools: wireTools(input.tools),
      system: input.system,
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0.3,
      stream: true,
      ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
    },
    threadId: randomUUID(),
  }
}

/** `x-project-slug`: the working directory flattened to a slug. */
export function projectSlugFromPath(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    // Linear trim: the unanchored `-+$` form backtracks quadratically on long dash runs.
    .replace(/^-+|(?<!-)-+$/g, '')
  return slug || 'project'
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/** One JSONL / SSE-ish line to its event, or undefined for comments and noise. */
export function parseEventLine(line: string): unknown {
  let trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim()
  if (trimmed === '' || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Block-assembly state for one stream: at most one text and one reasoning block open at a time. */
export interface Assembler {
  nextIndex: number
  textIndex: number
  textContent: string
  reasoningIndex: number
  reasoningContent: string
}

export function createAssembler(): Assembler {
  return { nextIndex: 0, textIndex: -1, textContent: '', reasoningIndex: -1, reasoningContent: '' }
}

function closeText(asm: Assembler): StreamChunk[] {
  if (asm.textIndex < 0) return []
  const index = asm.textIndex
  const text = asm.textContent
  asm.textIndex = -1
  asm.textContent = ''
  return [{ type: 'block-end', index, block: { type: 'text', text } }]
}

function closeReasoning(asm: Assembler): StreamChunk[] {
  if (asm.reasoningIndex < 0) return []
  const index = asm.reasoningIndex
  const text = asm.reasoningContent
  asm.reasoningIndex = -1
  asm.reasoningContent = ''
  return [{ type: 'block-end', index, block: { type: 'reasoning', text } }]
}

export function mapFinishReason(reason: unknown): FinishReason {
  if (reason === 'tool-calls' || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens' || reason === 'max_output_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Fold one stream event into harness chunks; throws an `LlmError` for an in-band `error` event. */
export function handleEvent(asm: Assembler, event: unknown): StreamChunk[] {
  if (!isRecord(event)) return []
  const chunks: StreamChunk[] = []
  switch (event.type) {
    case 'text-delta': {
      chunks.push(...closeReasoning(asm))
      if (asm.textIndex < 0) {
        asm.textIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.textIndex, blockType: 'text' })
      }
      const delta = str(event.text) ?? ''
      asm.textContent += delta
      chunks.push({ type: 'text-delta', index: asm.textIndex, text: delta })
      break
    }
    case 'reasoning-delta': {
      chunks.push(...closeText(asm))
      if (asm.reasoningIndex < 0) {
        asm.reasoningIndex = asm.nextIndex++
        chunks.push({ type: 'block-start', index: asm.reasoningIndex, blockType: 'reasoning' })
      }
      const delta = str(event.text) ?? ''
      asm.reasoningContent += delta
      chunks.push({ type: 'reasoning-delta', index: asm.reasoningIndex, text: delta })
      break
    }
    case 'reasoning-start':
      chunks.push(...closeText(asm))
      break
    case 'reasoning-end':
      chunks.push(...closeReasoning(asm))
      break
    case 'tool-call': {
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const id = ToolCallId(str(event.toolCallId) ?? randomUUID())
      const name = str(event.toolName) ?? ''
      const args = JSON.stringify(isRecord(event.input) ? event.input : isRecord(event.args) ? event.args : isRecord(event.arguments) ? event.arguments : {})
      const index = asm.nextIndex++
      chunks.push(
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
        { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
      )
      break
    }
    case 'finish': {
      chunks.push(...closeText(asm), ...closeReasoning(asm))
      const usage = isRecord(event.totalUsage) ? event.totalUsage : undefined
      if (usage !== undefined) {
        const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const totalInput = num(usage.inputTokens) ?? 0
        const cacheRead = num(details?.cacheReadTokens) ?? 0
        const cacheWrite = num(details?.cacheWriteTokens) ?? 0
        // Harness token counts are disjoint: `inputTokens` is uncached input only.
        const tokenUsage: TokenUsage = {
          inputTokens: num(details?.noCacheTokens) ?? Math.max(0, totalInput - cacheRead - cacheWrite),
          outputTokens: num(usage.outputTokens) ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        }
        chunks.push({ type: 'usage', usage: tokenUsage })
      }
      chunks.push({ type: 'finish', reason: mapFinishReason(event.finishReason) })
      break
    }
    case 'error':
      throw streamErrorToLlmError(event.error, str(event.message))
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Wording the official CLI answers by compacting and retrying instead of resending. */
const CONTEXT_OVERFLOW = /prompt is too long|context.*(length|window)|max_tokens|maximum.*tokens/i
const TERMINAL_MARKERS = ['premium_credits_exhausted', 'model_not_in_plan', 'insufficient credits']

function isContextOverflow(detail: string): boolean {
  return isContextWindowExceededError(detail) || CONTEXT_OVERFLOW.test(detail)
}

/**
 * Classify an in-band stream `error`. A context overflow becomes the
 * harness's own compaction code; a terminal marker (quota/plan/credits) or an
 * explicit non-retryable status is a hard failure; anything else is a transient
 * drop for the retry policy.
 */
export function streamErrorToLlmError(value: unknown, fallbackMessage?: string): LlmError {
  const record = isRecord(value) ? value : undefined
  const message = record !== undefined ? (str(record.message) ?? JSON.stringify(record)) : (str(value) ?? fallbackMessage ?? 'Stream error')
  const status = record === undefined ? undefined : (num(record.statusCode) ?? num(record.status))
  const retryableFlag = record === undefined ? undefined : (typeof record.isRetryable === 'boolean' ? record.isRetryable : undefined)
  const detail = [str(record?.code), str(record?.type), message].filter((part): part is string => part !== undefined && part !== '').join(' ')
  const options = status === undefined ? undefined : { status }

  if (isContextOverflow(detail)) {
    return new LlmError(
      `Command Code stream error: ${message}；Command Code API 拒绝了这次请求：内容超出模型上下文窗口。正在压缩上下文后重试`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
      options,
    )
  }
  const terminal = TERMINAL_MARKERS.some((marker) => detail.toLowerCase().includes(marker))
  const retryableStatus = status !== undefined && (status === 429 || status >= 500)
  const retryable = retryableFlag === true || (status !== undefined ? retryableStatus : (retryableFlag !== false && !terminal))
  return new LlmError(`Command Code stream error: ${message}`, retryable ? 'SERVER' : 'PROVIDER_STREAM_ERROR', options)
}

/** Parse `Retry-After` (seconds or an HTTP date) into ms. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** The failure code the route retry policy keys on, from a pre-stream HTTP status. */
function httpErrorCode(status: number): string {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_HTTP_ERROR'
}

/** Map a pre-stream HTTP rejection to an `LlmError` (bilingual: the harness shows the message verbatim). */
export function httpError(status: number, body: string, retryAfterMs: number | undefined): LlmError {
  let providerCode: string | undefined
  let providerDetail = ''
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      providerCode = str(parsed.error.code)
      providerDetail = [str(parsed.error.code), str(parsed.error.type), str(parsed.error.message)]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' ')
    }
  } catch {
    // Plain-text body: the status mapping below is enough.
  }
  const detail = providerCode ?? `HTTP ${status}`
  const overflowText = providerDetail !== '' ? providerDetail : body.slice(0, 500)
  // Only client-side rejections are inspected, so an HTML 5xx page cannot mention its way into a compaction.
  if (status < 500 && isContextOverflow(overflowText)) {
    return new LlmError(
      `Command Code API error ${status}: the request exceeds the model's context window — this session is being compacted and the request retried`
        + `；Command Code API 返回 ${status}：请求内容超出模型上下文窗口——正在压缩上下文后重试`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
      { status },
    )
  }
  if (status === 401) {
    return new LlmError(
      `Command Code API error 401 (${detail}): the API key is missing or invalid；Command Code API 返回 401：API 密钥缺失或无效`,
      'INVALID_CREDENTIAL',
      { status: 401 },
    )
  }
  if (status === 413) {
    return new LlmError(
      'Command Code API error 413: the request body exceeds the provider size limit (undocumented, about 50 MB) — start a new session'
        + '；Command Code API 返回 413：请求体超过服务端体积上限（约 50 MB）——请新建会话',
      'PROVIDER_HTTP_ERROR',
      { status: 413 },
    )
  }
  return new LlmError(
    `Command Code API error ${status}${detail === `HTTP ${status}` ? '' : ` (${detail})`}: ${body.slice(0, 500)}`,
    httpErrorCode(status),
    {
      status,
      ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { providerRetryAfterMs: retryAfterMs } : {}),
    },
  )
}

// ---------------------------------------------------------------------------
// Catalog and quota
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** `GET /provider/v1/models` → models; throws on a payload that is not a model list. */
export function parseCatalog(value: unknown): CatalogModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new LlmError('Unexpected Command Code models response shape', 'PROVIDER_PROTOCOL_ERROR')
  }
  const models: CatalogModel[] = []
  for (const entry of value.data) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    const name = str(entry.name)
    const contextLength = num(entry.context_length)
    if (id === undefined || id === '' || name === undefined || name === '' || contextLength === undefined || contextLength <= 0) continue
    models.push({ id, name, contextWindow: contextLength, maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS) })
  }
  if (models.length === 0) throw new LlmError('Command Code returned an empty model catalog', 'PROVIDER_PROTOCOL_ERROR')
  return models
}
