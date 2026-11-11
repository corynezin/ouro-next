// What a Claude Code agent was sent, rebuilt from its transcript: system prompt, tools and every message of each model
// request, with token counts. The transcript stores each request as the first `keep` messages of the one before plus a
// `tail` of message hashes, resolved from `api-request-blob` records or from the transcript's own messages.
// Token totals are exact (the API's usage); per-item counts are estimates scaled to add up to that total.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ContextBlock, ContextBlockPlace, ContextDetail, ContextRequestRow } from '@ouro/contract'

const CHARS_PER_TOKEN = 3.5
/** One block longer than this is cut for the phone, which fetches the rest on request; its token count covers all of it. */
export const CONTEXT_BLOCK_CHARS = 2_000

type Json = Record<string, any>
interface WireMessage { role: string; content: any; source: 'blob' | 'transcript' | 'unresolved' }
interface Usage { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }
export interface Rebuilt {
  at: number; model: string; system: Json[]; tools: Json[]; messages: WireMessage[]
  usage: Usage | null; response: Json[]
}

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Json)[key])]))
  : value
const hashOf = (message: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(message))).digest('hex')
const estimate = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text ? Math.max(1, Math.round(text.length / CHARS_PER_TOKEN)) : 0
}

/** The forms a stored message may have been hashed in: as stored, as text blocks, or without thinking or callers. */
function* variants(message: Json): Generator<Json> {
  const { role, content } = message
  yield { role, content }
  if (typeof content === 'string') yield { role, content: [{ type: 'text', text: content }] }
  else if (role === 'assistant' && Array.isArray(content)) {
    yield { role, content: content.filter((block: Json) => block.type !== 'thinking') }
    yield { role, content: content.map(({ caller: _caller, ...rest }: Json) => rest) }
  }
}

function parseLines(text: string): Json[] {
  const out: Json[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a line still being written */ }
  }
  return out
}

export function rebuildRequests(transcript: string): Rebuilt[] {
  const entries = parseLines(transcript)
  const blobs = new Map<string, Json>()
  const shapes = new Map<string, Json>()
  for (const entry of entries) {
    if (entry.type === 'api-request-blob') blobs.set(entry.hash, entry.message)
    if (entry.type === 'api-request-shape') shapes.set(entry.shapeHash, entry.shape)
  }
  // One API message is stored as several entries (a block each): merge by message id.
  const known = new Map<string, WireMessage>()
  const merged: Json[] = []
  const byId = new Map<string, Json>()
  for (const entry of entries) {
    if ((entry.type !== 'user' && entry.type !== 'assistant') || typeof entry.message !== 'object' || entry.message === null) continue
    const { role, content, id } = entry.message
    const mid = role === 'assistant' && typeof id === 'string' ? id : undefined
    const existing = mid ? byId.get(mid) : undefined
    if (existing && Array.isArray(existing.content) && Array.isArray(content)) existing.content = [...existing.content, ...content]
    else {
      const message = { role, content: Array.isArray(content) ? [...content] : content }
      merged.push(message)
      if (mid) byId.set(mid, message)
    }
  }
  for (const message of merged) for (const variant of variants(message)) {
    const hash = hashOf(variant)
    if (!known.has(hash)) known.set(hash, { role: variant.role, content: variant.content, source: 'transcript' })
  }

  // A request's reply is the first assistant message after it, stored like the others as one entry per block.
  const rebuilt: Rebuilt[] = []
  let previous: WireMessage[] = []
  let shape: Json = { system: [], tools: [] }
  let current: Rebuilt | null = null
  let replyId: string | null | undefined
  for (const entry of entries) {
    if (entry.type === 'api-request') {
      const messages = previous.slice(0, entry.keep ?? 0)
      for (const hash of entry.tail ?? []) {
        const blob = blobs.get(hash)
        const seen = known.get(hash)
        if (blob) messages.push({ role: blob.role, content: blob.content, source: 'blob' })
        else if (seen) messages.push(seen)
        else messages.push({ role: '?', content: [{ type: 'text', text: `[message ${String(hash).slice(0, 12)} is not stored in the transcript]` }], source: 'unresolved' })
      }
      previous = messages
      shape = shapes.get(entry.shapeHash) ?? shape
      current = {
        at: Date.parse(entry.timestamp) || 0, model: entry.params?.model ?? '', system: shape.system ?? [], tools: shape.tools ?? [], messages,
        usage: null, response: [],
      }
      replyId = undefined
      rebuilt.push(current)
      continue
    }
    if (entry.type !== 'assistant' || current === null || typeof entry.message !== 'object' || entry.message === null) continue
    const { id, content, usage } = entry.message
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
    if (replyId === undefined) {
      replyId = typeof id === 'string' ? id : null
      current.response = [...blocks]
      current.usage = usage ?? null
    } else if (replyId !== null && id === replyId) {
      current.response.push(...blocks)
      current.usage = usage ?? current.usage
    }
  }
  return rebuilt
}

const totalInput = (usage: Usage) => (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)

export function contextRows(rebuilt: Rebuilt[]): ContextRequestRow[] {
  return rebuilt.map((request, n) => ({
    n, at: request.at, model: request.model, messageCount: request.messages.length,
    inputTokens: request.usage ? totalInput(request.usage) : null, outputTokens: request.usage ? request.usage.output_tokens ?? 0 : null,
  }))
}

const blockText = (block: Json): string => {
  switch (block.type) {
    case 'text': return block.text ?? ''
    case 'thinking': return block.thinking || '(thinking is not stored: only its signature)'
    case 'tool_use': return `${block.name}(${JSON.stringify(block.input, null, 2)})`
    case 'tool_result': return typeof block.content === 'string' ? block.content : (block.content ?? []).map((part: Json) => part.type === 'text' ? part.text : `[${part.type}]`).join('\n')
    default: return JSON.stringify(block, null, 2)
  }
}

const categoryOf = (role: string, block: Json) => {
  if (block.type === 'tool_use') return 'assistant tool calls'
  if (block.type === 'tool_result') return 'tool results'
  if (block.type === 'thinking') return 'thinking'
  return role === 'assistant' ? 'assistant text' : role === 'system' ? 'system reminders' : 'user text'
}

function shown(block: Json, scale: number): ContextBlock {
  const text = blockText(block)
  const truncated = text.length > CONTEXT_BLOCK_CHARS
  return {
    type: String(block.type), label: String(block.name ?? ''), tokens: Math.round(estimate(block) * scale), truncated,
    text: truncated ? `${text.slice(0, CONTEXT_BLOCK_CHARS)}\n… ${text.length - CONTEXT_BLOCK_CHARS} more characters` : text,
  }
}

export function contextDetail(request: Rebuilt, n: number): ContextDetail {
  const sums = new Map<string, number>()
  const add = (name: string, tokens: number) => sums.set(name, (sums.get(name) ?? 0) + tokens)
  request.system.forEach((block) => add('system', estimate(block.text ?? block)))
  request.tools.forEach((tool) => add('tools', estimate(tool)))
  const messageBlocks = request.messages.map((message) => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content) as Json[])
  request.messages.forEach((message, index) => messageBlocks[index]!.forEach((block) => add(categoryOf(message.role, block), estimate(block))))
  const estimated = [...sums.values()].reduce((a, b) => a + b, 0) || 1
  const exact = request.usage !== null && totalInput(request.usage) > 0
  const total = exact ? totalInput(request.usage!) : estimated
  const scale = total / estimated
  const usage = request.usage && {
    uncached: request.usage.input_tokens ?? 0, cacheRead: request.usage.cache_read_input_tokens ?? 0,
    cacheWrite: request.usage.cache_creation_input_tokens ?? 0, output: request.usage.output_tokens ?? 0, totalInput: totalInput(request.usage),
  }
  return {
    n, at: request.at, model: request.model, usage, exact, totalInput: total,
    categories: [...sums].map(([name, tokens]) => ({ name, tokens: Math.round(tokens * scale) })).sort((a, b) => b.tokens - a.tokens),
    system: request.system.map((block) => shown({ type: 'text', text: block.text ?? JSON.stringify(block) }, scale)),
    tools: request.tools.map((tool) => ({ name: String(tool.name ?? '?'), description: String(tool.description ?? '').slice(0, 300), tokens: Math.round(estimate(tool) * scale) })),
    messages: request.messages.map((message, index) => ({ role: message.role, unresolved: message.source === 'unresolved', blocks: messageBlocks[index]!.map((block) => shown(block, scale)) })),
    response: request.response.map((block) => shown(block, 1)),
  }
}

/** One block's whole text, or null when there is no block there. */
export function contextBlockText(request: Rebuilt, { part, item, block: k }: ContextBlockPlace): string | null {
  let block: Json | undefined
  if (part === 'system') block = request.system[item] && { type: 'text', text: request.system[item].text ?? JSON.stringify(request.system[item]) }
  else if (part === 'response') block = request.response[k]
  else {
    const content = request.messages[item]?.content
    block = typeof content === 'string' ? (k === 0 ? { type: 'text', text: content } : undefined) : Array.isArray(content) ? content[k] : undefined
  }
  return block ? blockText(block) : null
}

// Rebuilding reads the whole transcript, and the phone asks for the list, a request and its blocks in quick succession:
// keep the last few, until their file changes.
const CACHED_TRANSCRIPTS = 4
const cache = new Map<string, { mtimeMs: number; size: number; requests: Rebuilt[] }>()

/** The requests of the transcript at `path`, or null when there is no such file. */
export function requestsOfTranscript(path: string): Rebuilt[] | null {
  let stat
  try { stat = statSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    cache.delete(path)
    cache.set(path, hit)
    return hit.requests
  }
  const requests = rebuildRequests(readFileSync(path, 'utf8'))
  cache.delete(path)
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, requests })
  while (cache.size > CACHED_TRANSCRIPTS) cache.delete(cache.keys().next().value!)
  return requests
}
