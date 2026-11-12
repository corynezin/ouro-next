// What a Claude Code agent was sent, rebuilt from its transcript: system prompt, tools and every message of each model
// request, with token counts. Pure: adapters/transcript-requests.ts reads the file and feeds its entries in, as they
// are appended, and the hash is passed in.
//
// The transcript stores each request (`api-request`) as the first `keep` messages of the request named by `base`, plus
// a `tail` of message hashes. A hash resolves to an `api-request-blob` record, or to a message rebuilt from the
// transcript's own entries. Claude Code writes one entry per block, but sends a run of consecutive entries of one role as
// one message (an assistant's blocks; a tool result and a message that arrived meanwhile), so each run is a candidate.
//
// Token totals are exact (the API's usage); per-item counts are estimates scaled to add up to that total.
import type {
  ContextBlock, ContextBlockKind, ContextBlockPlace, ContextCategory, ContextDetail, ContextMessage, ContextRequestRow, ContextRole,
} from '@ouro/contract'

/** The transcript's hash of a message: the adapter's sha256 of its JSON with keys sorted. */
export type HashOf = (message: unknown) => string

type Json = Record<string, unknown>

/** Roughly how many characters a token covers in English text and code; only the split between items rests on it. */
const CHARS_PER_TOKEN = 3.5
/**
 * What one image costs. The API bills about width × height / 750 tokens and scales images down to about 1.15
 * megapixels, so ~1,600 at most; the size isn't known without decoding the image, so every image counts as that ceiling.
 * Its base64 length says nothing about it.
 */
export const IMAGE_TOKENS = 1_600
/** What one base64 document (a PDF) is counted as: a few pages' worth. Its true cost depends on its pages, which aren't known here. */
export const DOCUMENT_TOKENS = 3_000
/** One block longer than this is cut for the phone, which fetches the rest on request; its token count covers all of it. */
export const CONTEXT_BLOCK_CHARS = 2_000

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Everything a request was sent, in tokens: uncached + cache read + cache written. */
export function inputTokensOfUsage(usage: Json): number {
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
}

interface StoredRequest {
  id: string | null
  base: string | null
  keep: number
  tail: string[]
  at: number
  model: string
  shapeHash: string | null
  usage: Json | null
  response: Json[]
  /** The id of the reply's message once its first entry arrived; null when that entry had none. */
  replyId: string | null | undefined
}

/** A message as sent: always a list of blocks. */
interface WireMessage { role: ContextRole; content: Json[] }

/** What has been read of one transcript so far. Grows with `feedTranscript`; read with the functions below. */
export interface TranscriptState {
  blobs: Map<string, WireMessage>
  shapes: Map<string, { system: Json[]; tools: Json[] }>
  /** Messages rebuilt from the transcript's own entries, by the hashes they may have been sent under. */
  known: Map<string, WireMessage>
  requests: StoredRequest[]
  requestById: Map<string, number>
  /** The run of consecutive entries of one role being read, sent as one message. */
  run: WireMessage | null
  /** An assistant message's blocks so far, by message id, for a reply whose entries are not consecutive. */
  assistantById: Map<string, Json[]>
}

export const emptyTranscript = (): TranscriptState => ({
  blobs: new Map(), shapes: new Map(), known: new Map(), requests: [], requestById: new Map(), run: null, assistantById: new Map(),
})

const roleOf = (value: unknown): ContextRole | null => (value === 'user' || value === 'assistant' || value === 'system' ? value : null)
const blocksOf = (content: unknown): Json[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRecord) : []

/** The forms a message may have been hashed in: as stored, as text blocks, or without thinking or callers. */
function* variants(role: ContextRole, content: unknown): Generator<{ role: ContextRole; content: unknown }> {
  yield { role, content }
  if (typeof content === 'string') yield { role, content: [{ type: 'text', text: content }] }
  else if (role === 'assistant' && Array.isArray(content)) {
    yield { role, content: content.filter((block) => !isRecord(block) || block.type !== 'thinking') }
    yield { role, content: content.map((block) => { if (!isRecord(block)) return block; const { caller: _caller, ...rest } = block; return rest }) }
  }
}

function remember(state: TranscriptState, role: ContextRole, content: unknown, hashOf: HashOf): void {
  for (const variant of variants(role, content)) {
    const hash = hashOf(variant)
    if (!state.known.has(hash)) state.known.set(hash, { role, content: blocksOf(variant.content) })
  }
}

/** Takes in one parsed transcript entry. Entries must come in file order. */
export function feedTranscript(state: TranscriptState, entry: unknown, hashOf: HashOf): void {
  if (!isRecord(entry)) return
  switch (entry.type) {
    case 'api-request-blob': {
      const role = isRecord(entry.message) ? roleOf(entry.message.role) : null
      if (typeof entry.hash === 'string' && role && isRecord(entry.message)) state.blobs.set(entry.hash, { role, content: blocksOf(entry.message.content) })
      return
    }
    case 'api-request-shape':
      if (typeof entry.shapeHash === 'string' && isRecord(entry.shape)) {
        const { system, tools } = entry.shape
        state.shapes.set(entry.shapeHash, { system: Array.isArray(system) ? system.filter(isRecord) : [], tools: Array.isArray(tools) ? tools.filter(isRecord) : [] })
      }
      return
    case 'api-request': {
      const id = typeof entry.id === 'string' ? entry.id : null
      if (id !== null) state.requestById.set(id, state.requests.length)
      state.requests.push({
        id, base: typeof entry.base === 'string' ? entry.base : null, keep: Math.max(0, Math.floor(count(entry.keep))),
        tail: Array.isArray(entry.tail) ? entry.tail.filter((hash): hash is string => typeof hash === 'string') : [],
        at: Date.parse(text(entry.timestamp)) || 0, model: isRecord(entry.params) ? text(entry.params.model) : '',
        shapeHash: typeof entry.shapeHash === 'string' ? entry.shapeHash : null, usage: null, response: [], replyId: undefined,
      })
      return
    }
    case 'user':
    case 'assistant': {
      if (!isRecord(entry.message)) return
      const role = roleOf(entry.message.role)
      if (role === null || role === 'system') return
      const { content, id, usage } = entry.message
      const blocks = blocksOf(content)
      remember(state, role, content, hashOf)
      if (state.run?.role === role) state.run.content.push(...blocks)
      else state.run = { role, content: [...blocks] }
      if (state.run.content.length > blocks.length) remember(state, role, [...state.run.content], hashOf)
      if (role === 'assistant' && typeof id === 'string') {
        const sofar = [...(state.assistantById.get(id) ?? []), ...blocks]
        state.assistantById.set(id, sofar)
        if (sofar.length > blocks.length) remember(state, role, sofar, hashOf)
      }
      if (role === 'assistant') takeReply(state, typeof id === 'string' ? id : null, blocks, isRecord(usage) ? usage : null)
      return
    }
  }
}

/** A request's reply is the first assistant message after it, stored like the others as one entry per block. */
function takeReply(state: TranscriptState, id: string | null, blocks: Json[], usage: Json | null): void {
  const current = state.requests.at(-1)
  if (!current) return
  if (current.replyId === undefined) {
    current.replyId = id
    current.response = [...blocks]
    current.usage = usage
  } else if (current.replyId !== null && id === current.replyId) {
    current.response.push(...blocks)
    current.usage = usage ?? current.usage
  }
}

type Sent = WireMessage | null

/** The messages sent with request `n`, rebuilt along its chain of bases; null for one the transcript doesn't hold. */
function messagesOf(state: TranscriptState, n: number): Sent[] {
  // Walk back to a request that keeps nothing, then forward, so each request costs only its tail.
  const chain: number[] = []
  let index = n
  for (;;) {
    chain.push(index)
    const request = state.requests[index]!
    if (request.keep === 0) break
    // Older transcripts have no ids: the base was then the request before.
    const base = request.base === null ? (index > 0 ? index - 1 : undefined) : state.requestById.get(request.base)
    if (base === undefined || base >= index) break
    index = base
  }
  const messages: Sent[] = []
  for (const at of chain.reverse()) {
    const request = state.requests[at]!
    messages.length = Math.min(messages.length, request.keep)
    // A base the transcript doesn't have, or one shorter than kept: what it kept can't be known, but its place can.
    while (messages.length < request.keep) messages.push(null)
    for (const hash of request.tail) messages.push(state.blobs.get(hash) ?? state.known.get(hash) ?? null)
  }
  return messages
}

/** Rows for the list, newest first: up to `limit` requests before request `before` (or the newest). */
export function contextRows(state: TranscriptState, before: number | null, limit: number): { requests: ContextRequestRow[]; hasOlder: boolean } {
  const end = Math.min(before ?? state.requests.length, state.requests.length)
  const start = Math.max(0, end - limit)
  const requests = state.requests.slice(start, end).map((request, offset) => ({
    n: start + offset, at: request.at, model: request.model, messageCount: request.keep + request.tail.length,
    inputTokens: request.usage ? inputTokensOfUsage(request.usage) : null, outputTokens: request.usage ? count(request.usage.output_tokens) : null,
  })).reverse()
  return { requests, hasOlder: start > 0 }
}

/** A block's base64 payload, when it carries one (an image or a document). */
const base64Of = (block: Json): string | null =>
  isRecord(block.source) && block.source.type === 'base64' && typeof block.source.data === 'string' ? block.source.data : null
const kilobytesOf = (base64: string) => Math.max(1, Math.round((base64.length * 3) / 4 / 1024))

/** A copy of `value` with every base64 payload replaced by `replace(block, data)`, and what the payloads cost in tokens. */
function withoutBase64(value: unknown, replace: (block: Json, data: string) => string): { value: unknown; tokens: number } {
  let tokens = 0
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk)
    if (!isRecord(item)) return item
    const data = base64Of(item)
    if (data !== null) {
      tokens += item.type === 'document' ? DOCUMENT_TOKENS : IMAGE_TOKENS
      return { ...item, source: { ...(item.source as Json), data: replace(item, data) } }
    }
    return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]))
  }
  return { value: walk(value), tokens }
}

/** Estimated tokens of a block: its text, with images and documents counted by the constants above. */
export function estimateTokens(value: unknown): number {
  const { value: stripped, tokens } = withoutBase64(value, () => '')
  const written = typeof stripped === 'string' ? stripped : JSON.stringify(stripped) ?? ''
  return tokens + (written ? Math.max(1, Math.round(written.length / CHARS_PER_TOKEN)) : 0)
}

const attachmentText = (block: Json): string => {
  const data = base64Of(block)
  const kind = block.type === 'document' ? 'document' : 'image'
  return data === null ? `[${kind}]` : `[${kind}, ${kilobytesOf(data)} KB]`
}

function blockText(block: Json): string {
  switch (block.type) {
    case 'text': return text(block.text)
    case 'thinking': return text(block.thinking) || '(thinking is not stored: only its signature)'
    case 'tool_use': return `${text(block.name)}(${JSON.stringify(block.input ?? null, null, 2)})`
    case 'tool_result': {
      const { content } = block
      if (typeof content === 'string') return content
      const parts = Array.isArray(content) ? content : isRecord(content) ? [content] : []
      return parts.map((part) => !isRecord(part) ? '' : part.type === 'text' ? text(part.text) : part.type === 'image' || part.type === 'document' ? attachmentText(part) : `[${text(part.type)}]`).join('\n')
    }
    case 'image':
    case 'document': return attachmentText(block)
    default: return JSON.stringify(withoutBase64(block, (_block, data) => `[${kilobytesOf(data)} KB]`).value, null, 2)
  }
}

const KNOWN_KINDS: readonly ContextBlockKind[] = ['text', 'thinking', 'tool_use', 'tool_result', 'image', 'document']
const kindOf = (block: Json): ContextBlockKind => KNOWN_KINDS.find((kind) => kind === block.type) ?? 'other'

function categoryOf(role: ContextRole, block: Json): ContextCategory {
  const kind = kindOf(block)
  switch (kind) {
    case 'tool_use': return 'tool_calls'
    case 'tool_result': return 'tool_results'
    case 'thinking': return 'thinking'
    case 'image':
    case 'document': return 'attachments'
    case 'text':
    case 'other':
      switch (role) {
        case 'assistant': return 'assistant_text'
        case 'system': return 'system_reminders'
        case 'user': return 'user_text'
      }
  }
}

function shown(block: Json, tokens: number): ContextBlock {
  const whole = blockText(block)
  const truncated = whole.length > CONTEXT_BLOCK_CHARS
  const kind = kindOf(block)
  return {
    type: kind, label: kind === 'other' ? text(block.type) : text(block.name), tokens: Math.round(tokens), truncated,
    text: truncated ? `${whole.slice(0, CONTEXT_BLOCK_CHARS)}\n… ${whole.length - CONTEXT_BLOCK_CHARS} more characters` : whole,
  }
}

const systemBlock = (block: Json): Json => ({ type: 'text', text: typeof block.text === 'string' ? block.text : JSON.stringify(block) })
const shapeOf = (state: TranscriptState, request: StoredRequest) => (request.shapeHash === null ? undefined : state.shapes.get(request.shapeHash)) ?? { system: [], tools: [] }

/** Everything sent with request `n`, and its reply; null when there is no such request. */
export function contextDetail(state: TranscriptState, n: number): ContextDetail | null {
  const request = state.requests[n]
  if (!request) return null
  const { system, tools } = shapeOf(state, request)
  const messages = messagesOf(state, n)
  const sums = new Map<ContextCategory, number>()
  const add = (name: ContextCategory, tokens: number) => sums.set(name, (sums.get(name) ?? 0) + tokens)
  const systemTokens = system.map((block) => estimateTokens(systemBlock(block).text))
  const toolTokens = tools.map((tool) => estimateTokens(tool))
  const messageTokens = messages.map((message) => message?.content.map((block) => estimateTokens(block)) ?? [])
  systemTokens.forEach((tokens) => add('system', tokens))
  toolTokens.forEach((tokens) => add('tools', tokens))
  messages.forEach((message, index) => message?.content.forEach((block, k) => add(categoryOf(message.role, block), messageTokens[index]![k]!)))

  const estimated = [...sums.values()].reduce((a, b) => a + b, 0) || 1
  const reported = request.usage ? inputTokensOfUsage(request.usage) : 0
  const exact = reported > 0
  const total = exact ? reported : estimated
  const scale = total / estimated
  const usage = request.usage && {
    uncached: count(request.usage.input_tokens), cacheRead: count(request.usage.cache_read_input_tokens),
    cacheWrite: count(request.usage.cache_creation_input_tokens), output: count(request.usage.output_tokens), totalInput: reported,
  }
  return {
    n, at: request.at, model: request.model, usage, exact, totalInput: total,
    categories: [...sums].map(([name, tokens]) => ({ name, tokens: Math.round(tokens * scale) })).sort((a, b) => b.tokens - a.tokens),
    system: system.map((block, index) => shown(systemBlock(block), systemTokens[index]! * scale)),
    tools: tools.map((tool, index) => ({ name: text(tool.name) || '?', description: text(tool.description).slice(0, 300), tokens: Math.round(toolTokens[index]! * scale) })),
    messages: messages.map((message, index): ContextMessage => message === null ? { kind: 'unresolved' }
      : { kind: 'message', role: message.role, blocks: message.content.map((block, k) => shown(block, messageTokens[index]![k]! * scale)) }),
    response: request.response.map((block) => shown(block, estimateTokens(block))),
  }
}

/** One block's whole text, or null when there is no block there. */
export function contextBlockText(state: TranscriptState, n: number, { part, item, block: k }: ContextBlockPlace): string | null {
  const request = state.requests[n]
  if (!request) return null
  let block: Json | undefined
  switch (part) {
    case 'system': {
      const found = shapeOf(state, request).system[item]
      block = found && systemBlock(found)
      break
    }
    case 'response': block = request.response[k]; break
    case 'message': block = messagesOf(state, n)[item]?.content[k]; break
  }
  return block ? blockText(block) : null
}
