// Making agents' summaries. The decision to start one is taken inside the core's transaction, the model is asked after it
// commits, and the answer is committed in a transaction of its own. Nothing here touches an agent's lifecycle or
// deliveries, so a summary never wakes anyone. Its cost is added to the agent's.
import type { SummaryRecord } from '@ouro/contract'
import { readJournalBackward, readJournalForward } from '../adapters/journal-file.ts'
import { SummarizeFailed } from '../adapters/summarizer.ts'
import type { Summarize } from '../adapters/summarizer.ts'
import type { JournalRecord } from '../domain/journal.ts'
import {
  buildLiveDigest, buildSummaryDigest, liveInstructions, liveLineDue, NO_LIVE_ACTIVITY, NO_SUMMARY_PROGRESS, noteLiveActivity, noteSummarizableActivity,
  parseLiveAnswer, parseSummaryAnswer, startSummary, summaryDue, summaryFailed, summaryInstructions, summarySucceeded,
} from '../domain/summary.ts'
import type { LiveActivity, LiveAttempts, LivePolicy, SummaryPolicy, SummaryProgress, SummaryTrigger } from '../domain/summary.ts'
import type { AgentRow, Store } from '../store/store.ts'

/** The most of an agent's journal one summary reads: its newest part, when there's more. */
const SUMMARY_WINDOW_BYTES = 4 * 1024 * 1024
/** A live line needs only the newest activity. */
const LIVE_WINDOW_BYTES = 256 * 1024

export interface SummaryAttempt {
  agentId: string
  /** The progress as it was before the attempt started, so a failure can put its pending activity back. */
  before: SummaryProgress
}

export interface AgentSummariesConfig {
  store: Store
  policy: SummaryPolicy
  livePolicy: LivePolicy
  now: () => number
  journalPath: (agentId: string) => string
  /** The summarizer and model for this agent. */
  summarizerFor: (agent: AgentRow) => { summarize: Summarize; model: string }
  /** Runs `body` as one of the core's transactions. */
  commit: (body: () => void) => void
}

export class AgentSummaries {
  private readonly config: AgentSummariesConfig
  /** One attempt per agent at a time. Not persisted: after a restart the uncovered activity is summarized next time. */
  private readonly inFlight = new Set<string>()
  /** Agent, then device, then when that device's lease ends. Leases are short and renewed, so they live in memory. */
  private readonly watches = new Map<string, Map<string, number>>()
  private readonly liveActivity = new Map<string, LiveActivity>()
  private readonly liveAttempts = new Map<string, LiveAttempts>()
  private readonly liveInFlight = new Set<string>()

  constructor(config: AgentSummariesConfig) {
    this.config = config
  }

  private progressOf(agentId: string): SummaryProgress {
    return this.config.store.summaryProgressOf(agentId) ?? NO_SUMMARY_PROGRESS
  }

  /** Inside a transaction, for each journal record ingested. */
  noteRecord(agentId: string, record: JournalRecord): void {
    this.liveActivity.set(agentId, noteLiveActivity(this.liveActivity.get(agentId) ?? NO_LIVE_ACTIVITY, record))
    if (record.kind !== 'tool_use' && record.kind !== 'text') return
    const progress = this.progressOf(agentId)
    const next = noteSummarizableActivity(progress, record, this.config.policy)
    if (next !== progress) this.config.store.saveSummaryProgress(agentId, next)
  }

  /** Inside a transaction: whether to start a summary now. The caller runs the attempt after the commit. */
  consider(agentId: string, trigger: SummaryTrigger): SummaryAttempt | null {
    if (this.inFlight.has(agentId)) return null
    const before = this.progressOf(agentId)
    const now = this.config.now()
    if (!summaryDue(before, trigger, now, this.config.policy)) return null
    this.config.store.saveSummaryProgress(agentId, startSummary(before, now))
    this.inFlight.add(agentId)
    return { agentId, before }
  }

  /** Agents with activity waiting for a summary, for the scheduler's periodic look. */
  agentsWithPendingActivity(agentIds: readonly string[]): string[] {
    return agentIds.filter((agentId) => !this.inFlight.has(agentId) && this.progressOf(agentId).pendingSince !== null)
  }

  async run(attempt: SummaryAttempt): Promise<void> {
    try {
      await this.attempt(attempt)
    } finally {
      this.inFlight.delete(attempt.agentId)
    }
  }

  private async attempt({ agentId, before }: SummaryAttempt): Promise<void> {
    const { store } = this.config
    const agent = store.agentById(agentId)
    if (!agent) return
    const coveredThrough = agent.journalCursor
    const records = this.readUncovered(agentId, before.coveredThroughCursor, coveredThrough)
    const previous = store.summariesOf(agentId, null, 1).summaries[0] ?? null
    const digest = buildSummaryDigest({ agentName: agent.name, task: agent.task, previousLine: previous?.line ?? null, records })
    const { summarize, model } = this.config.summarizerFor(agent)

    let outcome: { summary: Omit<SummaryRecord, 'number'>; costUsd: number } | { failure: string; costUsd: number }
    try {
      const answer = await summarize({ model, instructions: summaryInstructions(this.config.policy), digest })
      try {
        const parsed = parseSummaryAnswer(answer.text, this.config.policy)
        const coversThroughAt = records.at(-1)?.at ?? this.config.now()
        outcome = { summary: { at: this.config.now(), line: parsed.line, details: parsed.details, coversThroughAt }, costUsd: answer.costUsd }
      } catch (error) {
        outcome = { failure: (error as Error).message, costUsd: answer.costUsd }
      }
    } catch (error) {
      outcome = { failure: (error as Error).message, costUsd: error instanceof SummarizeFailed ? error.costUsd : 0 }
    }

    this.config.commit(() => {
      if (!store.agentById(agentId)) return
      this.addCostInTransaction(agentId, outcome.costUsd)
      const progress = this.progressOf(agentId)
      if ('summary' in outcome) {
        store.addSummary(agentId, { ...outcome.summary, model, costUsd: outcome.costUsd })
        store.saveSummaryProgress(agentId, summarySucceeded(progress, coveredThrough))
      } else {
        store.saveSummaryProgress(agentId, summaryFailed(progress, before, this.config.now(), outcome.failure))
      }
    })
  }

  // Live lines

  watch(agentId: string, deviceId: string, leaseMs: number): void {
    const now = this.config.now()
    if (!this.isWatched(agentId, now)) this.liveActivity.set(agentId, { ...(this.liveActivity.get(agentId) ?? NO_LIVE_ACTIVITY), watchStarted: true })
    const leases = this.watches.get(agentId) ?? new Map<string, number>()
    leases.set(deviceId, now + leaseMs)
    this.watches.set(agentId, leases)
  }

  private isWatched(agentId: string, now: number): boolean {
    const leases = this.watches.get(agentId)
    if (!leases) return false
    for (const [deviceId, endsAt] of leases) if (endsAt <= now) leases.delete(deviceId)
    if (leases.size === 0) this.watches.delete(agentId)
    return leases.size > 0
  }

  watchedAgents(): string[] {
    const now = this.config.now()
    return [...this.watches.keys()].filter((agentId) => this.isWatched(agentId, now))
  }

  /** Outside a transaction: starts a live line if someone is looking and there's something new to say. */
  considerLiveLine(agentId: string): void {
    const now = this.config.now()
    if (this.liveInFlight.has(agentId) || !this.isWatched(agentId, now)) return
    const attempts = this.liveAttempts.get(agentId) ?? { lastStartedAt: null, consecutiveFailures: 0, lastFailureAt: null }
    if (!liveLineDue(this.liveActivity.get(agentId) ?? NO_LIVE_ACTIVITY, attempts, now, this.config.livePolicy)) return
    this.liveActivity.set(agentId, NO_LIVE_ACTIVITY)
    const agent = this.config.store.agentById(agentId)
    if (!agent) return
    const coveredThrough = agent.journalCursor
    const records = this.readNewest(agentId, this.liveCoveredThrough(agentId), coveredThrough)
    // Nothing it did since the last live line or summary: nothing to say, and nothing that should delay the next line.
    if (!records.some((record) => record.kind === 'tool_use' || (record.kind === 'text' && record.text.trim() !== ''))) return
    this.liveAttempts.set(agentId, { ...attempts, lastStartedAt: now })
    this.liveInFlight.add(agentId)
    void this.makeLiveLine(agent, records, coveredThrough).finally(() => this.liveInFlight.delete(agentId))
  }

  private async makeLiveLine(agent: AgentRow, records: JournalRecord[], coveredThrough: number): Promise<void> {
    const { store } = this.config
    const agentId = agent.id
    const previous = store.liveLineOf(agentId)
    const summaryLine = store.summariesOf(agentId, null, 1).summaries[0]?.line ?? null
    const digest = buildLiveDigest({ agentName: agent.name, task: agent.task, summaryLine, previousLiveLine: previous?.line ?? null, records }, this.config.livePolicy)
    const { summarize, model } = this.config.summarizerFor(agent)

    let line: string
    let costUsd = 0
    try {
      const answer = await summarize({ model, instructions: liveInstructions(this.config.policy), digest })
      costUsd = answer.costUsd
      line = parseLiveAnswer(answer.text, this.config.policy)
    } catch (error) {
      if (error instanceof SummarizeFailed) costUsd = error.costUsd
      const attempts = this.liveAttempts.get(agentId)!
      this.liveAttempts.set(agentId, { ...attempts, consecutiveFailures: attempts.consecutiveFailures + 1, lastFailureAt: this.config.now() })
      this.addCost(agentId, costUsd)
      return
    }
    this.liveAttempts.set(agentId, { ...this.liveAttempts.get(agentId)!, consecutiveFailures: 0, lastFailureAt: null })
    this.config.commit(() => {
      if (!store.agentById(agentId)) return
      this.addCostInTransaction(agentId, costUsd)
      store.saveLiveLine(agentId, { at: this.config.now(), line, coversThroughAt: records.at(-1)!.at, coveredThroughCursor: coveredThrough, model })
    })
  }

  /** A live line says what happened since the last live line or the latest summary, whichever is newer. */
  private liveCoveredThrough(agentId: string): number {
    return Math.max(this.config.store.liveLineOf(agentId)?.coveredThroughCursor ?? 0, this.progressOf(agentId).coveredThroughCursor)
  }

  private addCost(agentId: string, costUsd: number): void {
    if (costUsd > 0) this.config.commit(() => this.addCostInTransaction(agentId, costUsd))
  }

  private addCostInTransaction(agentId: string, costUsd: number): void {
    const agent = this.config.store.agentById(agentId)
    if (agent && costUsd > 0) this.config.store.updateAgentFields(agentId, { costUsd: agent.costUsd + costUsd })
  }

  private readNewest(agentId: string, from: number, to: number): JournalRecord[] {
    const path = this.config.journalPath(agentId)
    if (to <= from) return []
    if (to - from <= LIVE_WINDOW_BYTES) return readJournalForward(path, from, to - from).records
    return readJournalBackward(path, to, LIVE_WINDOW_BYTES).records
  }

  private readUncovered(agentId: string, from: number, to: number): JournalRecord[] {
    const path = this.config.journalPath(agentId)
    if (to <= from) return []
    if (to - from <= SUMMARY_WINDOW_BYTES) return readJournalForward(path, from, to - from).records
    return readJournalBackward(path, to, SUMMARY_WINDOW_BYTES).records
  }
}
