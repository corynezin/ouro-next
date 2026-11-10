// A runner's journal: what it did, appended as it happens, one JSON object per line. The runner is the only writer and
// `ourod` the only interpreter. Because `ourod` reads it by byte cursor, whatever happened while `ourod` was down is read
// exactly once afterwards, and the cursor commits in the same transaction as what it caused.
import type { ProviderFailure } from './agent.ts'
import type { ContextReading } from './compaction.ts'
import type { PlanWindowReading } from './usage.ts'

export type JournalBody =
  | { kind: 'runner_started'; pid: number; release: string }
  | { kind: 'runner_ready' }
  | { kind: 'session_identified'; providerSessionId: string }
  | { kind: 'session_unresumable'; providerSessionId: string; detail: string }
  | { kind: 'incoming'; attemptId: string; from: string; text: string }
  | { kind: 'taken_in'; attemptIds: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolName: string; input: string }
  | { kind: 'tool_result'; text: string; isError: boolean }
  | { kind: 'thinking' }
  | { kind: 'turn_result'; acknowledgedAttemptIds: string[]; costUsd: number; context: ContextReading | null }
  | { kind: 'turn_failed'; failure: ProviderFailure; detail: string; retryAfterMs: number | null }
  | { kind: 'compaction_finished'; contextTokens: number | null }
  | { kind: 'plan_usage_observed'; windows: PlanWindowReading[] }
  | { kind: 'notice'; text: string }
  | { kind: 'runner_exiting'; reason: string }

export type JournalRecord = JournalBody & { at: number; generation: number }

export function encodeJournalRecord(record: JournalRecord): string {
  return `${JSON.stringify(record)}\n`
}
