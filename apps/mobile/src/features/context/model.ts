// The context viewer's words, numbers and loading. Pure: Screen.tsx only draws this. The server cuts long blocks; the
// full text of one is fetched only when the person asks for it.
import type { ContextCategory, ContextDetail, ContextList, ContextRequestRow, ContextUnavailable } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiFailure, ApiResult } from '../../core/session/serverApi.ts'

/** The list follows the agent as it works, at most this often: each look reads what the transcript gained since. */
export const CONTEXT_FOLLOW_EVERY_MS = 15_000

/** How long to wait before following the agent's activity, when the list last looked at `lastAt`: at once if it's been a while. */
export const followDelayMs = (lastAt: number, now: number) => Math.max(0, lastAt + CONTEXT_FOLLOW_EVERY_MS - now)

export const CONTEXT_COPY = {
  loading: 'Loading…',
  empty: 'No model requests yet.',
  older: 'Earlier requests',
  exactNote: 'Totals are exact, from the API. Per-item counts are estimates scaled to match them.',
  estimateNote: 'No usage was recorded for this request, so every count here is an estimate.',
  showFull: 'Show full text',
  showLess: 'Show less',
  fullFailed: 'Couldn’t load the full text. Tap to retry.',
  unresolved: 'not stored in the transcript',
  unresolvedTitle: (index: number) => `#${index} ?`,
  messageTitle: (index: number, role: string) => `#${index} ${role}`,
  systemPrompt: 'System prompt',
  tools: (count: number) => `Tools (${count})`,
  reply: 'Reply',
  requestScreenTitle: (n: number) => `Request #${n}`,
  screenTitle: (agentName: string) => `${agentName} · context`,
  tokens: (count: number) => `${tokensText(count)} tok`,
  totalTokens: (count: number) => `${tokensText(count)} tokens`,
  /** An older server has no Context routes: say so in plain words, not as an endpoint. */
  serverTooOld: 'This computer’s Ouro doesn’t show context yet. Update it, then look again.',
  unavailable: {
    not_claude_code: 'Only Claude Code agents keep a transcript to show.',
    no_conversation: 'This agent has no conversation yet.',
    transcript_missing: 'This conversation’s transcript is not on this computer.',
  } satisfies Record<ContextUnavailable, string>,
  categories: {
    system: 'system', tools: 'tools', system_reminders: 'system reminders', user_text: 'user text', attachments: 'images and documents',
    assistant_text: 'assistant text', tool_calls: 'assistant tool calls', tool_results: 'tool results', thinking: 'thinking',
  } satisfies Record<ContextCategory, string>,
} as const

export const CATEGORY_COLORS: Record<ContextCategory, string> = {
  system: 'yellow', tools: 'teal', system_reminders: 'orange', user_text: 'blue', attachments: 'mint', assistant_text: 'indigo',
  tool_calls: 'red', tool_results: 'green', thinking: 'gray',
}

/** 1234 → "1,234"; 12345 → "12.3k". */
export function tokensText(count: number | null): string {
  if (count === null) return '–'
  return count >= 10_000 ? `${(count / 1000).toFixed(1)}k` : count.toLocaleString('en-US')
}

export const percentOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0)

/** The one line under the heading: how much was sent, and how it split between cache and fresh input. */
export function usageSummary(detail: ContextDetail): string {
  const usage = detail.usage
  if (!usage || !detail.exact) return `~${tokensText(detail.totalInput)} in (estimate)`
  return `${tokensText(usage.totalInput)} in · ${tokensText(usage.cacheRead)} cached · ${tokensText(usage.cacheWrite)} cache write · ${tokensText(usage.output)} out`
}

export const requestTitle = (n: number, at: number) => `#${n} · ${new Date(at).toLocaleTimeString()}`

/** A request's row under its title: how many messages, how much came back, and the model. */
export const requestSubtitle = (row: { messageCount: number; outputTokens: number | null; model: string }) =>
  `${row.messageCount} ${row.messageCount === 1 ? 'message' : 'messages'} · ${tokensText(row.outputTokens)} out${row.model ? ` · ${row.model}` : ''}`

/** A failed read in words; a server too old for these routes answers "no such endpoint", which means nothing to the person. */
export function contextFailureText(failure: ApiFailure): string {
  if (failure.kind === 'refused' && failure.error.code === 'not_found' && failure.error.message.startsWith('no such endpoint')) return CONTEXT_COPY.serverTooOld
  return failureText(failure)
}

/** One thing read from the server: what was last read stays shown when a later read fails. */
export interface Loaded<T> { value: T | null; loading: boolean; failure: string | null }

/**
 * Reads one thing (a request's detail, a block's whole text). An answer that arrives after `close`, or after a newer
 * read was started, is dropped, so a slow answer can't replace a newer one or reach a screen that's gone.
 */
export class Loader<T> {
  private readonly read: () => Promise<ApiResult<T>>
  private readonly onChange: () => void
  private current: Loaded<T> = { value: null, loading: false, failure: null }
  private ticket = 0

  constructor(deps: { read: () => Promise<ApiResult<T>>; onChange: () => void }) {
    this.read = deps.read
    this.onChange = deps.onChange
  }

  get state() { return this.current }

  async load() {
    const ticket = ++this.ticket
    this.update({ loading: true })
    const result = await this.read()
    if (ticket !== this.ticket) return
    this.update(result.ok ? { value: result.value, loading: false, failure: null } : { loading: false, failure: contextFailureText(result.failure) })
  }

  /** Back to nothing read, as a block shown cut again. */
  clear() {
    this.ticket += 1
    this.update({ value: null, loading: false, failure: null })
  }

  close() { this.ticket += 1 }

  private update(change: Partial<Loaded<T>>) {
    this.current = { ...this.current, ...change }
    this.onChange()
  }
}

export interface ContextListState {
  /** Newest first; null before the first page arrives. */
  rows: ContextRequestRow[] | null
  hasOlder: boolean
  unavailable: ContextUnavailable | null
  loading: boolean
  failure: string | null
}

/**
 * Pages over an agent's model requests, newest first: `follow` reads the newest page again (new requests, and replies
 * that have arrived since), `loadOlder` the page below the oldest shown. Rows are keyed by their request number, so a
 * page that overlaps what's shown replaces it rather than repeating it.
 */
export class ContextReader {
  private readonly read: (before: number | null) => Promise<ApiResult<ContextList>>
  private readonly onChange: () => void
  private byN = new Map<number, ContextRequestRow>()
  private current: ContextListState = { rows: null, hasOlder: false, unavailable: null, loading: false, failure: null }
  private inFlight = false
  private closed = false

  constructor(deps: { read: (before: number | null) => Promise<ApiResult<ContextList>>; onChange: () => void }) {
    this.read = deps.read
    this.onChange = deps.onChange
  }

  get state() { return this.current }

  follow() { return this.load(null) }
  loadOlder() {
    const oldest = this.current.rows?.at(-1)
    return this.current.hasOlder && oldest ? this.load(oldest.n) : Promise.resolve()
  }

  /** The screen is gone: answers still on their way are dropped. */
  close() { this.closed = true }

  private async load(before: number | null) {
    if (this.inFlight || this.closed) return
    this.inFlight = true
    this.update({ loading: true })
    const page = await this.read(before)
    this.inFlight = false
    if (this.closed) return
    if (!page.ok) {
      this.update({ loading: false, failure: contextFailureText(page.failure) })
      return
    }
    const { requests, hasOlder, unavailable } = page.value
    const newestShown = Math.max(-1, ...this.byN.keys())
    // The newest page no longer reaches what's shown (more than a page of requests since): start again from it.
    const gap = before === null && hasOlder && requests.length > 0 && Math.min(...requests.map((row) => row.n)) > newestShown + 1
    // A transcript read again from the start (a new conversation) numbers its requests anew.
    const restarted = before === null && (requests[0]?.n ?? -1) < newestShown
    if (gap || restarted || unavailable !== null) this.byN.clear()
    for (const row of requests) this.byN.set(row.n, row)
    const rows = [...this.byN.values()].sort((a, b) => b.n - a.n)
    this.update({
      rows, unavailable, loading: false, failure: null,
      // Following keeps what was known below; a page further down, or a fresh start, says it itself.
      hasOlder: before === null && !gap && !restarted && this.current.rows !== null ? this.current.hasOlder : hasOlder,
    })
  }

  private update(change: Partial<ContextListState>) {
    this.current = { ...this.current, ...change }
    this.onChange()
  }
}
