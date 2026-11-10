// An agent's journal as readable lines, and the paging over it. Pure: Screen.tsx only draws this.
import type { LogPage, LogRecord } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'

export type LogTone = 'incoming' | 'words' | 'tool' | 'result' | 'notice'
export interface LogLine { key: string; text: string; tone: LogTone }

const TOOL_RESULT_LINES = 6

/** The log follows the agent as it works, and once a minute whatever it is doing. */
export const LOG_FOLLOW_EVERY_MS = 60_000

export const LOG_COPY = { earlier: 'Earlier', loading: 'Loading…', empty: 'Nothing logged yet.' } as const

const clockOf = (at: number) => {
  const time = new Date(at)
  return [time.getHours(), time.getMinutes(), time.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

function resultText(text: string) {
  const lines = text.trimEnd().split('\n')
  const more = lines.length - TOOL_RESULT_LINES
  const shown = lines.slice(0, TOOL_RESULT_LINES).map((line, index) => `${index ? '    ' : '  ⎿ '}${line}`).join('\n')
  return more > 0 ? `${shown}\n    … ${more} more lines` : shown
}

export function logLine(record: LogRecord, key: string): LogLine {
  const time = clockOf(record.at)
  switch (record.kind) {
    case 'incoming': return { key, text: `${time} → from ${record.from}: ${record.text.trim()}`, tone: 'incoming' }
    case 'text': return { key, text: `${time} ${record.text.trim()}`, tone: 'words' }
    case 'tool_use': return { key, text: `${time} ▸ ${record.toolName}: ${record.input}`, tone: 'tool' }
    case 'tool_result': return { key, text: resultText(record.text), tone: 'result' }
    case 'notice': return { key, text: `${time} · ${record.text}`, tone: 'notice' }
  }
}

export type LogPosition = { before: number } | { after: number } | null

export interface LogState {
  /** Null before the first page arrives. */
  lines: LogLine[] | null
  hasEarlier: boolean
  loading: boolean
  failure: string | null
}

/**
 * Pages over one agent's journal: the latest page, earlier pages above it, and what's been written since below.
 * Lines are keyed by their journal position, so a page that overlaps one already shown can't duplicate it.
 */
export class LogReader {
  private readonly read: (position: LogPosition) => Promise<ApiResult<LogPage>>
  private readonly onChange: () => void
  private recordsByKey = new Map<string, LogLine>()
  private order: string[] = []
  private startCursor = 0
  private endCursor = 0
  private current: LogState = { lines: null, hasEarlier: false, loading: false, failure: null }
  private inFlight = false

  constructor(deps: {
    read: (position: LogPosition) => Promise<ApiResult<LogPage>>
    onChange: () => void
  }) {
    this.read = deps.read
    this.onChange = deps.onChange
  }

  get state() { return this.current }

  loadLatest() { return this.load(null, 'replace') }
  loadEarlier() { return this.current.hasEarlier ? this.load({ before: this.startCursor }, 'prepend') : Promise.resolve() }
  /** What it has written since. Before the first page, the first page. */
  follow() { return this.current.lines === null ? this.loadLatest() : this.load({ after: this.endCursor }, 'append') }

  private async load(position: LogPosition, placement: 'replace' | 'prepend' | 'append') {
    if (this.inFlight) return
    this.inFlight = true
    this.update({ loading: true })
    const page = await this.read(position)
    this.inFlight = false
    if (!page.ok) {
      this.update({ loading: false, failure: failureText(page.failure) })
      return
    }
    this.place(page.value, placement)
    this.update({ loading: false, failure: null, lines: this.order.map((key) => this.recordsByKey.get(key)!), hasEarlier: placement === 'append' ? this.current.hasEarlier : page.value.hasEarlier })
  }

  private place(page: LogPage, placement: 'replace' | 'prepend' | 'append') {
    // Records within a page are told apart by their place in it, and pages by where they start in the journal.
    const keys = page.records.map((_, index) => `${page.startCursor}:${index}`)
    if (placement === 'replace') {
      this.recordsByKey.clear()
      this.order = []
    }
    const fresh = keys.filter((key) => !this.recordsByKey.has(key))
    page.records.forEach((record, index) => this.recordsByKey.set(keys[index]!, logLine(record, keys[index]!)))
    this.order = placement === 'prepend' ? [...fresh, ...this.order] : [...this.order, ...fresh]
    if (placement !== 'append') this.startCursor = page.startCursor
    if (placement !== 'prepend') this.endCursor = page.endCursor
  }

  private update(change: Partial<LogState>) {
    this.current = { ...this.current, ...change }
    this.onChange()
  }
}
