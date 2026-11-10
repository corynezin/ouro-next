// An agent's goal: what it records, when its next cycle is due, and what each command does to it. Pure.
import type { AgentState, Address, GoalKind, GoalStatus, GoalWait } from '@ouro/contract'
import { DEFAULT_GOAL_INTERVAL_SECONDS, MAX_GOAL_INTERVAL_SECONDS, MIN_GOAL_INTERVAL_SECONDS } from '@ouro/contract'

export type GoalProgress =
  | { status: 'active' }
  | { status: 'paused'; by: Address; reason: string | null; at: number }
  | { status: 'complete'; at: number; summary: string }

export interface GoalRecord {
  agentId: string
  text: string
  kind: GoalKind
  progress: GoalProgress
  cycleCount: number
  /** Null means the default interval. */
  chosenIntervalSeconds: number | null
  costUsd: number
  setBy: Address
  setAt: number
  consecutiveFailedCycles: number
  /** The message that started the cycle now running. */
  runningCycleMessageId: string | null
  lastCycleEndedAt: number | null
  /** An interrupt pauses cycles until the next real message. */
  waitingForMessageAfterInterrupt: boolean
}

export const MAX_GOAL_BACKOFF_MS = 30 * 60_000

export class GoalRefusal extends Error {}

export function intervalSecondsOf(goal: Pick<GoalRecord, 'chosenIntervalSeconds'>): number {
  return goal.chosenIntervalSeconds ?? DEFAULT_GOAL_INTERVAL_SECONDS
}

export function validateInterval(seconds: number | null): number | null {
  if (seconds === null) return null
  if (!Number.isInteger(seconds) || seconds < MIN_GOAL_INTERVAL_SECONDS || seconds > MAX_GOAL_INTERVAL_SECONDS) {
    throw new GoalRefusal(`an interval is ${MIN_GOAL_INTERVAL_SECONDS} seconds to 7 days`)
  }
  return seconds
}

/** A new goal replaces the old one: counters restart. Notes live outside the record, so they stay. */
export function newGoal(input: { agentId: string; text: string; kind: GoalKind; intervalSeconds: number | null; setBy: Address; now: number }): GoalRecord {
  return {
    agentId: input.agentId,
    text: input.text,
    kind: input.kind,
    progress: { status: 'active' },
    cycleCount: 0,
    chosenIntervalSeconds: validateInterval(input.intervalSeconds),
    costUsd: 0,
    setBy: input.setBy,
    setAt: input.now,
    consecutiveFailedCycles: 0,
    runningCycleMessageId: null,
    lastCycleEndedAt: null,
    waitingForMessageAfterInterrupt: false,
  }
}

export function pauseGoal(goal: GoalRecord, by: Address, reason: string | null, now: number): GoalRecord {
  if (goal.progress.status !== 'active') throw new GoalRefusal(`the goal is ${goal.progress.status}, not active`)
  return { ...goal, progress: { status: 'paused', by, reason, at: now } }
}

export function resumeGoal(goal: GoalRecord): GoalRecord {
  if (goal.progress.status !== 'paused') throw new GoalRefusal(`the goal is ${goal.progress.status}, not paused`)
  return { ...goal, progress: { status: 'active' }, consecutiveFailedCycles: 0, waitingForMessageAfterInterrupt: false }
}

export function reopenGoal(goal: GoalRecord): GoalRecord {
  if (goal.progress.status !== 'complete') throw new GoalRefusal(`the goal is ${goal.progress.status}, not complete`)
  return { ...goal, progress: { status: 'active' }, consecutiveFailedCycles: 0, waitingForMessageAfterInterrupt: false }
}

export type GoalCheckOutcome = { kind: 'not_needed' } | { kind: 'passed' } | { kind: 'failed'; output: string }

/** Whether "done" may complete this goal, given the outcome of its check. */
export function completeGoal(goal: GoalRecord, summary: string, check: GoalCheckOutcome, now: number): GoalRecord {
  if (goal.progress.status === 'complete') throw new GoalRefusal('the goal is already complete')
  if (goal.kind.kind === 'open_ended') throw new GoalRefusal('this goal is open-ended, so it never completes. Pause or clear it instead')
  if (goal.kind.kind === 'checked') {
    if (check.kind === 'not_needed') throw new Error('a checked goal was completed without running its check')
    if (check.kind === 'failed') throw new GoalRefusal(`the goal's check \`${goal.kind.checkCommand}\` failed:\n${check.output.slice(-1500)}`)
  }
  return { ...goal, progress: { status: 'complete', at: now, summary }, runningCycleMessageId: null }
}

export function setGoalInterval(goal: GoalRecord, seconds: number | null): GoalRecord {
  return { ...goal, chosenIntervalSeconds: validateInterval(seconds) }
}

export function startCycle(goal: GoalRecord, messageId: string): GoalRecord {
  return { ...goal, cycleCount: goal.cycleCount + 1, runningCycleMessageId: messageId }
}

/** A cycle that needed more than one attempt failed at least once, and the next one waits longer. */
export function endCycle(goal: GoalRecord, outcome: { interrupted: boolean; attempts: number }, now: number): GoalRecord {
  const failed = !outcome.interrupted && outcome.attempts > 1
  return {
    ...goal,
    runningCycleMessageId: null,
    lastCycleEndedAt: now,
    consecutiveFailedCycles: failed ? goal.consecutiveFailedCycles + 1 : 0,
    waitingForMessageAfterInterrupt: goal.waitingForMessageAfterInterrupt || outcome.interrupted,
  }
}

export function noteRealMessage(goal: GoalRecord): GoalRecord {
  return goal.waitingForMessageAfterInterrupt ? { ...goal, waitingForMessageAfterInterrupt: false } : goal
}

export function noteInterrupt(goal: GoalRecord): GoalRecord {
  return { ...goal, waitingForMessageAfterInterrupt: true }
}

export function addCycleCost(goal: GoalRecord, usd: number): GoalRecord {
  return { ...goal, costUsd: goal.costUsd + usd }
}

/** Whether a goal cycle may start this agent: the deliberately stopped, held and archived stay as they are. */
export function agentCanTakeCycle(state: AgentState): boolean {
  switch (state.state) {
    case 'idle': return true
    case 'stopped':
      switch (state.stopped.reason) {
        case 'idle':
        case 'unarchived':
          return true
        case 'crash':
          return state.stopped.relaunch.kind === 'on_message'
        case 'deliberate':
          return false
      }
      return false
    case 'done': return true
    case 'starting':
    case 'in_turn':
    case 'interrupting':
    case 'compacting':
    case 'stopping':
    case 'held':
    case 'moving':
    case 'moved':
    case 'archived':
      return false
  }
}

export interface CycleFacts {
  agentState: AgentState
  /** When the agent last became idle, or stopped. */
  agentQuietSince: number
  hasQueuedDeliveries: boolean
  /** The plan the agent runs on is used past what cycles may take, until its window resets. */
  planHold: Extract<GoalWait, { kind: 'plan_usage' }> | null
}

/** When the next cycle may start, and why not sooner. Null `at` means not until something else changes. */
export function nextCycle(goal: GoalRecord, facts: CycleFacts): { at: number | null; waitingFor: GoalWait | null } {
  if (goal.progress.status !== 'active' || goal.runningCycleMessageId !== null) return { at: null, waitingFor: null }
  if (goal.waitingForMessageAfterInterrupt) return { at: null, waitingFor: { kind: 'next_message_after_interrupt' } }
  if (!agentCanTakeCycle(facts.agentState)) {
    const busy = ['starting', 'in_turn', 'interrupting', 'compacting', 'stopping'].includes(facts.agentState.state)
    return { at: null, waitingFor: busy ? null : { kind: 'agent_unavailable' } }
  }
  // People's messages always come first.
  if (facts.hasQueuedDeliveries) return { at: null, waitingFor: null }
  const paced = pacedCycle(goal, facts)
  if (facts.planHold === null) return paced
  return { at: Math.max(paced.at, facts.planHold.resetsAt), waitingFor: facts.planHold }
}

/** When the interval, or the backoff after failed cycles, lets the next cycle start. */
function pacedCycle(goal: GoalRecord, facts: CycleFacts): { at: number; waitingFor: GoalWait | null } {
  const intervalMs = intervalSecondsOf(goal) * 1000
  const quietSince = Math.max(facts.agentQuietSince, goal.lastCycleEndedAt ?? 0)
  if (goal.consecutiveFailedCycles === 0) return { at: quietSince + intervalMs, waitingFor: null }
  const backoffMs = Math.min(intervalMs * 2 ** goal.consecutiveFailedCycles, MAX_GOAL_BACKOFF_MS)
  const until = (goal.lastCycleEndedAt ?? quietSince) + backoffMs
  return { at: until, waitingFor: { kind: 'backoff', until, consecutiveFailures: goal.consecutiveFailedCycles } }
}

export function goalStatusOf(goal: GoalRecord, facts: CycleFacts): GoalStatus {
  switch (goal.progress.status) {
    case 'paused': return { status: 'paused', by: goal.progress.by, reason: goal.progress.reason, at: goal.progress.at }
    case 'complete': return { status: 'complete', at: goal.progress.at, summary: goal.progress.summary }
    case 'active': {
      const next = nextCycle(goal, facts)
      return { status: 'active', waitingFor: next.waitingFor, nextCycleAt: next.at, cycleRunning: goal.runningCycleMessageId !== null }
    }
  }
}

/** Whether the goal keeps the agent from exiting idle: an active goal is work in progress. */
export function goalKeepsAgentUp(goal: GoalRecord | null): boolean {
  return goal !== null && goal.progress.status === 'active' && !goal.waitingForMessageAfterInterrupt
}

export function cyclePrompt(goal: GoalRecord, notesPath: string): string {
  const finish = goal.kind.kind === 'open_ended'
    ? 'This goal is open-ended: it is never finished. Keep improving toward it, cycle after cycle. If you are blocked on something only a person can give you, park it with `ouro goal pause "question for the person"`.'
    : `When the goal is fully met, and you have verified it, finish it with \`ouro goal done "summary"\`${goal.kind.kind === 'checked' ? ` (the check \`${goal.kind.checkCommand}\` must pass first)` : ''}; the cycles then stop. If you are blocked on something only a person can give you, park it with \`ouro goal pause "question for the person"\`.`
  return `Goal work cycle ${goal.cycleCount}. You are working unattended toward your goal; nobody can answer questions right away, so decide for yourself.

GOAL (re-read every cycle; it may have been edited since the last one):
${goal.text}

How to work each cycle:
1. Read your notes, ${notesPath} (your memory across cycles and compactions). Create it if missing.
2. Pick the most valuable next step toward the goal, do it, and verify it.
3. Before ending this turn, rewrite the notes: done, verified, broken, next steps, open questions. Keep them under about 150 lines.
Cycles come ${intervalSecondsOf(goal)} seconds after you go idle. To change that: \`ouro goal every <seconds>\` (\`default\` to undo).
${finish}
End your turn when this step is done. The next cycle arrives by itself; messages from people come first.`
}
