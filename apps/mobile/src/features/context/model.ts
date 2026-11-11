// The context viewer's words and numbers. Pure: Screen.tsx only draws this. The server cuts long blocks; the full
// text of one is fetched only when the person asks for it.
import type { ContextDetail } from '@ouro/contract'

export const CONTEXT_COPY = {
  loading: 'Loading…',
  empty: 'No model requests yet.',
  exactNote: 'Totals are exact, from the API. Per-item counts are estimates scaled to match them.',
  estimateNote: 'No usage was recorded for this request, so every count here is an estimate.',
  showFull: 'Show full text',
  showLess: 'Show less',
  fullFailed: 'Couldn’t load the full text. Tap to retry.',
  unresolved: 'not stored in the transcript',
} as const

/** 1234 → "1,234"; 12345 → "12.3k". */
export function tokensText(count: number | null): string {
  if (count === null) return '–'
  return count >= 10_000 ? `${(count / 1000).toFixed(1)}k` : count.toLocaleString('en-US')
}

export const percentOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0)

export const CATEGORY_COLORS: Record<string, string> = {
  system: 'yellow', tools: 'teal', 'system reminders': 'orange', 'user text': 'blue', 'assistant text': 'indigo',
  'assistant tool calls': 'red', 'tool results': 'green', thinking: 'gray',
}

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
