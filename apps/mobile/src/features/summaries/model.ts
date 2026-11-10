// One agent's summaries as dated cards, newest first, and every agent's latest in list order. Pure: the screens only draw
// this. The latest comes with sync; the earlier ones are a paged read.
import type { SummaryEntity, SummaryPage, SummaryRecord } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { ago, dateTimeOf } from '../../design/format.ts'
import { isBeforeLatestTurn, listOrder, stateDotOf } from '../shared/agentFacts.ts'
import type { StateDotKind, StoreView } from '../shared/agentFacts.ts'

/** The agent's summaries screen; on the all-agents one, an agent with none yet. */
export const summariesTitle = (agentName: string) => `${agentName}: summaries`
export const NO_SUMMARY_YET_IN_LIST = 'no summary yet'

export interface SummaryCard { key: string; dateText: string; line: string; details: readonly string[] }

export interface SummariesModel {
  cards: SummaryCard[]
  /** Before the first page has answered. */
  loading: boolean
  emptyText: string | null
  lastAttemptFailedText: string | null
  loadFailureText: string | null
}

/** The entity's latest, then the earlier ones loaded so far, without repeating the latest when a page has it too. */
export function summariesModel(entity: SummaryEntity | undefined, read: SummariesReadState): SummariesModel {
  const latest = entity?.latest ?? null
  const earlier = (read.records ?? []).filter((summary) => summary.number !== latest?.number)
  const all = [...(latest ? [latest] : []), ...earlier]
  const loading = read.records === null && read.failure === null
  return {
    cards: all.map((summary) => ({ key: String(summary.number), dateText: dateTimeOf(summary.at).toUpperCase(), line: summary.line, details: summary.details })),
    loading,
    emptyText: !loading && all.length === 0 && read.failure === null ? 'No summary yet' : null,
    lastAttemptFailedText: entity?.lastFailure ? `Last attempt failed: ${entity.lastFailure.message}` : null,
    loadFailureText: read.failure,
  }
}

export interface SummariesReadState {
  /** Newest first; null until the first page answers. */
  records: readonly SummaryRecord[] | null
  hasOlder: boolean
  loading: boolean
  failure: string | null
}

export type SummariesPosition = { beforeNumber: number | null }

const PAGE_SIZE = 20

/** Pages back through one agent's summaries. Refreshing starts again from the newest. */
export class SummariesReader {
  private readonly read: (position: SummariesPosition, limit: number) => Promise<ApiResult<SummaryPage>>
  private readonly onChange: () => void
  private current: SummariesReadState = { records: null, hasOlder: false, loading: false, failure: null }
  private inFlight = false

  constructor(deps: { read: (position: SummariesPosition, limit: number) => Promise<ApiResult<SummaryPage>>; onChange: () => void }) {
    this.read = deps.read
    this.onChange = deps.onChange
  }

  get state() { return this.current }

  loadNewest() { return this.load({ beforeNumber: null }, 'replace') }
  loadOlder() {
    const oldest = this.current.records?.at(-1)
    return this.current.hasOlder && oldest ? this.load({ beforeNumber: oldest.number }, 'append') : Promise.resolve()
  }

  private async load(position: SummariesPosition, placement: 'replace' | 'append') {
    if (this.inFlight) return
    this.inFlight = true
    this.update({ loading: true })
    const page = await this.read(position, PAGE_SIZE)
    this.inFlight = false
    if (!page.ok) return this.update({ loading: false, failure: failureText(page.failure) })
    const kept = placement === 'append' ? this.current.records ?? [] : []
    const seen = new Set(kept.map((summary) => summary.number))
    const records = [...kept, ...page.value.summaries.filter((summary) => !seen.has(summary.number))]
    this.update({ records, hasOlder: page.value.hasOlder, loading: false, failure: null })
  }

  private update(change: Partial<SummariesReadState>) {
    this.current = { ...this.current, ...change }
    this.onChange()
  }
}

/** One agent in the all-agents list: its latest summary, or a note that it has none yet. */
export interface AgentSummaryCard {
  agentId: string
  name: string
  dot: StateDotKind
  /** The latest summary's age; null without one. */
  ageText: string | null
  latest: { line: string; details: readonly string[]; beforeLatestTurn: boolean } | null
}

export function allSummariesModel(store: StoreView, now: number): AgentSummaryCard[] {
  return listOrder(store, { kind: 'never' }, now).awake.map((agent) => {
    const latest = store.summaries.get(agent.id)?.latest ?? null
    return {
      agentId: agent.id,
      name: agent.name,
      dot: stateDotOf(agent),
      ageText: latest ? ago(latest.at, now) : null,
      latest: latest && { line: latest.line, details: latest.details, beforeLatestTurn: isBeforeLatestTurn(agent, latest.coversThroughAt) },
    }
  })
}
