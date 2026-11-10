// A host that pauses when idle, such as a Sprite, is held awake while this machine has work, and let go once it has none.
// Holds expire by themselves, so one is renewed while work goes on; letting go waits a little after the last work, so
// work just accepted has time to show.
import type { AgentState } from '@ouro/contract'

export const HOLD_RENEW_MS = 60_000
export const HOLD_RELEASE_GRACE_MS = 90_000
/** A request for another machine keeps this one awake for its first few tries only: a machine that stays away for good
 * mustn't keep this one billing. */
export const OUTBOX_TRIES_KEEPING_AWAKE = 3

/** A machine that sleeps is visited, while someone uses this one, this often; otherwise it is left asleep. */
export const SLEEPING_PEER_VISIT_MS = 60_000
/** A hello from a machine this recent says it is up now. Two of its hellos, and a little. */
export const PEER_AWAKE_WITHIN_MS = 5_000

/** Whether an agent in this state has work that must not pause: a turn, its start or end, a message that wakes it and that
 * it will take by itself, or a relaunch after a crash due by itself. */
export function agentKeepsHostAwake(state: AgentState, hasQueuedWakingDelivery: boolean): boolean {
  switch (state.state) {
    case 'starting':
    case 'in_turn':
    case 'interrupting':
    case 'compacting':
    case 'stopping':
    case 'moving':
      return true
    case 'idle':
    case 'done':
      return hasQueuedWakingDelivery
    // Stopped, its waiting messages go along only with the next message that starts it, unless a crash's backoff brings it
    // back by itself: a gave-up crash loop must not keep the host billing for days.
    case 'stopped':
      return state.stopped.reason === 'crash' && state.stopped.relaunch.kind === 'at'
    // Held agents wait on a clock or a person, for minutes or longer: the hold would only keep the host billing.
    case 'held':
    case 'moved':
    case 'archived':
      return false
  }
}

export type HostHoldState =
  | { held: false }
  | { held: true; heldAt: number }

export type HostHoldStep = 'hold' | 'release' | 'none'

/** What to do about the hold now, given whether there is work and when there last was. */
export function hostHoldStep(hold: HostHoldState, hasWork: boolean, lastWorkAt: number, now: number): HostHoldStep {
  if (hasWork) return !hold.held || now - hold.heldAt >= HOLD_RENEW_MS ? 'hold' : 'none'
  return hold.held && now - lastWorkAt >= HOLD_RELEASE_GRACE_MS ? 'release' : 'none'
}

/** Whether to say hello to a machine that sleeps. Only while it holds itself awake anyway, or, rarely, while someone uses
 * this one: two machines that both sleep would otherwise each wait for the other, or wake each other for good. */
export function helloToSleeperDue(
  sleeper: { lastHelloFromAt: number | null; heldAwake: boolean; lastVisitAt: number | null },
  thisMachineInUse: boolean,
  now: number,
): 'hello' | 'visit' | 'none' {
  if (sleeper.heldAwake && sleeper.lastHelloFromAt !== null && now - sleeper.lastHelloFromAt < PEER_AWAKE_WITHIN_MS) return 'hello'
  if (thisMachineInUse && (sleeper.lastVisitAt === null || now - sleeper.lastVisitAt >= SLEEPING_PEER_VISIT_MS)) return 'visit'
  return 'none'
}
