// Auto-archive, off by default: an agent that finished and has stayed quiet is archived, so the list keeps to work still
// going. Never one something still depends on.
import type { AgentState } from '@ouro/contract'

export interface ArchiveFacts {
  state: AgentState
  lastActivityAt: number
  /** Its goal is active or paused: finishing it is still to come. */
  goalStillGoing: boolean
  runningHelpers: number
  queuedDeliveries: number
  openAsks: number
  /** What its creator hasn't read yet in their chat with it, such as its report. */
  unreadByCreator: number
}

const HOUR_MS = 3_600_000

export function autoArchiveDue(facts: ArchiveFacts, now: number, afterHours: number | null): boolean {
  if (afterHours === null || facts.state.state !== 'done') return false
  if (facts.goalStillGoing || facts.runningHelpers > 0 || facts.queuedDeliveries > 0 || facts.openAsks > 0 || facts.unreadByCreator > 0) return false
  return now - Math.max(facts.lastActivityAt, facts.state.since) >= afterHours * HOUR_MS
}
