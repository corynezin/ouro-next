// The agent lifecycle: one pure reducer. Every state change an agent can go through is a case here. The app layer loads
// the lifecycle, calls `decideAgent`, commits the result with a transition record, then performs the effects.
//
// Exactly one live instance: `instanceGeneration` rises only when a launch is decided, a launch is decided only from a
// state with no runner (or from `stopping` once its runner is confirmed gone), and reports from any other generation are
// refused.
import { compactionDue } from './compaction.ts'
import type { PromptCacheRecord } from './compaction.ts'
import type { AgentState, Address, HoldReason, StoppedReason, StoppingOutcome, TurnActivity, TurnFailure } from '@ouro/contract'

export interface AgentLifecycle {
  state: AgentState
  instanceGeneration: number
  /** Crashes since the last turn that finished. A finished turn resets it. */
  consecutiveCrashes: number
  /** Turns refused for lack of credit since the last turn that finished. Spaces out the retries. */
  consecutiveCreditFailures: number
  /** Rises with each move between computers, so each handoff has its own identity and a stale one can't be confused
   * with the current one. */
  ownershipEpoch: number
  /** Stalls since the last turn that finished: work taken in, then no output before the stall deadline, again and again. */
  consecutiveStalls: number
}

export interface AgentPolicy {
  launchDeadlineMs: number
  interruptDeadlineMs: number
  compactDeadlineMs: number
  stopGraceMs: number
  /** Between kill attempts once a runner has outlived its grace. It stays `stopping` until confirmed gone. */
  killRetryMs: number
  crashBackoffMs: readonly number[]
  crashLoopLimit: number
  creditRetryBackoffMs: readonly number[]
  stallMs: number
  stallWhileToolMs: number
  /** A turn busy this long is reported to the agent's parent, once per turn. It is not stopped. */
  longTurnAlertMs: number
  /** After this many stalls in a row, the person is told: the agent keeps retrying, but its work isn't moving. */
  stallsBeforeTelling: number
  idleExitMs: number | null
}

export const defaultAgentPolicy: AgentPolicy = {
  launchDeadlineMs: 60_000,
  interruptDeadlineMs: 20_000,
  compactDeadlineMs: 10 * 60_000,
  stopGraceMs: 5_000,
  killRetryMs: 5_000,
  crashBackoffMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  crashLoopLimit: 8,
  creditRetryBackoffMs: [5, 10, 20, 40, 60].map((minutes) => minutes * 60_000),
  stallMs: 10 * 60_000,
  stallWhileToolMs: 30 * 60_000,
  longTurnAlertMs: 30 * 60_000,
  stallsBeforeTelling: 3,
  idleExitMs: 30 * 60_000,
}

/** The app's answer to "may this agent run now?": slots, budget and provider holds, evaluated in the same transaction. */
export type WakeAdmission =
  | { kind: 'granted' }
  | { kind: 'refused'; hold: HoldReason; retryAt: number | null }

/**
 * - `model_refused`: the model declined this input, such as a safeguards flag. Retrying the same input can't succeed,
 *   so the input fails and the agent is otherwise fine.
 */
export type ProviderFailure = 'logged_out' | 'credits' | 'usage_limit' | 'transient' | 'fatal' | 'model_refused'

export type AgentEvent =
  /** A launch was decided by the app (creation, a message, a due retry), with the outcome of admission. */
  | { type: 'wake_requested'; admission: WakeAdmission; reason: WakeReason }
  | { type: 'runner_ready'; generation: number }
  /** The runner of this generation is confirmed dead: its exit is journaled, or its process is verifiably gone. */
  | { type: 'runner_gone'; generation: number; hadWork: boolean }
  | { type: 'launch_deadline_passed' }
  /** Deliveries were handed to the runner for `turnId`. Idle starts a turn; in a turn, they join it. */
  | { type: 'deliveries_dispatched'; generation: number; turnId: string }
  | { type: 'turn_activity'; generation: number; turnId: string; activity: TurnActivity }
  | { type: 'turn_finished'; generation: number; turnId: string; continuation: TurnContinuation }
  | { type: 'turn_failed'; generation: number; turnId: string; failure: ProviderFailure; detail: string; retryAt: number | null }
  | { type: 'stall_detected' }
  | { type: 'interrupt_requested'; by: Address }
  | { type: 'interrupt_deadline_passed' }
  | { type: 'compaction_requested' }
  | { type: 'compaction_finished'; generation: number }
  | { type: 'compaction_deadline_passed' }
  | { type: 'stop_requested'; by: Address }
  | { type: 'stop_deadline_passed' }
  | { type: 'idle_timeout_reached' }
  | { type: 'finish_requested'; summary: string }
  | { type: 'archive_requested' }
  | { type: 'unarchive_requested' }
  | { type: 'new_release_available' }
  /** Hand it to another computer once nothing runs: at the end of its turn if it is in one. */
  | { type: 'move_requested'; toMachine: string }
  /** The other computer refused it, or certainly never got it: it stays here, as it was. */
  | { type: 'move_called_off'; why: string }
  /** A handoff got no answer, and may have arrived: it is tried again, never called off. */
  | { type: 'move_unconfirmed'; why: string }
  /** The other computer has it, at `to`. */
  | { type: 'move_confirmed'; to: Address }
  /** The cause of a hold cleared, and there's nothing waiting: nothing to run. */
  | { type: 'hold_cleared_without_work' }
  /** Between turns, a hold that began while it was working, such as the budget being spent: it stops and waits. */
  | { type: 'hold_between_turns'; hold: HoldReason }

export type WakeReason = 'created' | 'new_message' | 'queued_work' | 'crash_backoff_elapsed' | 'hold_retry_due' | 'hold_cleared' | 'server_restart'

/** Whether a finished turn left deliveries the provider hasn't acknowledged: those form the next turn. */
export type TurnContinuation =
  | { kind: 'no_unacknowledged_deliveries' }
  | { kind: 'unacknowledged_deliveries_remain'; nextTurnId: string }

/** Effects that change durable state, committed in the same transaction as the transition. */
export type TransactionEffect =
  /** A turn ended without finishing: its deliveries go back to the queue, marked as possibly seen. */
  | { effect: 'requeue_in_turn_deliveries' }
  /** Interrupt: what the turn took in counts as finished. Interrupted work isn't redone. */
  | { effect: 'complete_in_turn_deliveries_as_interrupted'; turnId: string }
  | { effect: 'retag_in_turn_deliveries'; toTurnId: string }
  | { effect: 'record_interrupted_by'; by: Address | null }
  /** The turn's deliveries end as failed, and the agent records why, until a later turn finishes. */
  | { effect: 'fail_in_turn_deliveries'; turnId: string; failure: TurnFailure }
  /** The provider's session can't be continued, so the next launch starts a new one, seeded from the stored history. */
  | { effect: 'discard_provider_session' }
  /** A stalled turn is being restarted: the agent is told, so it checks where it was before carrying on. */
  | { effect: 'tell_agent_it_stalled'; silentForMs: number }

/** Effects performed after the commit. If the server dies first, reconciliation on restart re-derives them. */
export type ExternalEffect =
  | { effect: 'launch_runner'; generation: number; resumeConversation: boolean }
  | { effect: 'signal_runner_stop'; generation: number }
  | { effect: 'kill_runner'; generation: number }
  | { effect: 'send_interrupt'; generation: number; turnId: string }
  | { effect: 'send_compact'; generation: number }

export type AgentDecision =
  | { outcome: 'transition'; next: AgentLifecycle; cause: string; recordTransition: boolean; transactionEffects: TransactionEffect[]; externalEffects: ExternalEffect[] }
  /** The event doesn't apply. Nothing changes, and `why` is what the caller reports. */
  | { outcome: 'refused'; why: RefusalReason }

export type RefusalReason =
  | 'stale_generation'
  | 'stale_turn'
  | 'not_applicable_in_state'
  | 'archived'
  | 'held'

const refuse = (why: RefusalReason): AgentDecision => ({ outcome: 'refused', why })

/** The generation of the runner this state believes in. Null means no runner may exist. */
export function liveGeneration(state: AgentState): number | null {
  switch (state.state) {
    case 'starting':
    case 'idle':
    case 'in_turn':
    case 'interrupting':
    case 'compacting':
    case 'stopping':
      return state.generation
    case 'stopped':
    case 'held':
    case 'moving':
    case 'moved':
    case 'done':
    case 'archived':
      return null
  }
}

export function decideAgent(lifecycle: AgentLifecycle, event: AgentEvent, now: number, policy: AgentPolicy): AgentDecision {
  const context: DecisionContext = { lifecycle, now, policy }
  const { state } = lifecycle

  if ('generation' in event && event.generation !== liveGeneration(state)) return refuse('stale_generation')

  switch (event.type) {
    case 'wake_requested': return decideWake(context, event.admission, event.reason)
    case 'runner_ready': return state.state === 'starting' ? transition(context, { state: 'idle', since: now, generation: state.generation }, 'runner is ready') : refuse('not_applicable_in_state')
    case 'runner_gone': return decideRunnerGone(context, event.hadWork)
    case 'launch_deadline_passed':
      if (state.state !== 'starting') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, crashOutcome(context, true, 'launch never answered'), 'launch deadline passed', [{ effect: 'kill_runner', generation: state.generation }])
    case 'deliveries_dispatched': return decideDispatch(context, event.turnId)
    case 'turn_activity':
      if (state.state !== 'in_turn') return refuse('not_applicable_in_state')
      if (state.turnId !== event.turnId) return refuse('stale_turn')
      return transition(context, { ...state, activity: event.activity, lastOutputAt: now }, 'turn activity', { recordTransition: false })
    case 'turn_finished': return decideTurnFinished(context, event.turnId, event.continuation)
    case 'turn_failed': return decideTurnFailed(context, event.turnId, event.failure, event.detail, event.retryAt)
    case 'stall_detected':
      if (state.state !== 'in_turn') return refuse('not_applicable_in_state')
      return withStallCounted(beginStopping(context, state.generation, { outcome: 'relaunch', why: 'stalled' }, 'no output before the stall deadline', [{ effect: 'kill_runner', generation: state.generation }], [
        { effect: 'requeue_in_turn_deliveries' },
        { effect: 'tell_agent_it_stalled', silentForMs: now - state.lastOutputAt },
      ]))
    case 'interrupt_requested':
      if (state.state !== 'in_turn') return refuse('not_applicable_in_state')
      return transition(context,
        { state: 'interrupting', since: now, generation: state.generation, turnId: state.turnId, by: event.by, deadlineAt: now + policy.interruptDeadlineMs },
        `interrupted by ${event.by}`,
        { externalEffects: [{ effect: 'send_interrupt', generation: state.generation, turnId: state.turnId }] })
    case 'interrupt_deadline_passed':
      if (state.state !== 'interrupting') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, { outcome: 'relaunch', why: 'interrupt_forced' }, 'interrupt deadline passed', [{ effect: 'kill_runner', generation: state.generation }], [
        { effect: 'complete_in_turn_deliveries_as_interrupted', turnId: state.turnId },
        { effect: 'record_interrupted_by', by: state.by },
      ])
    case 'compaction_requested':
      if (state.state !== 'idle') return refuse('not_applicable_in_state')
      return transition(context, { state: 'compacting', since: now, generation: state.generation, deadlineAt: now + policy.compactDeadlineMs }, 'compaction started', { externalEffects: [{ effect: 'send_compact', generation: state.generation }] })
    case 'compaction_finished':
      if (state.state !== 'compacting') return refuse('not_applicable_in_state')
      return transition(context, { state: 'idle', since: now, generation: state.generation }, 'compaction finished')
    case 'compaction_deadline_passed':
      if (state.state !== 'compacting') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, { outcome: 'relaunch', why: 'compaction_forced' }, 'compaction deadline passed', [{ effect: 'kill_runner', generation: state.generation }])
    case 'stop_requested': return withStallsForgiven(decideRequestedStop(context, { outcome: 'stopped', stopped: { reason: 'deliberate', by: event.by } }, `stopped by ${event.by}`))
    case 'stop_deadline_passed':
      if (state.state !== 'stopping') return refuse('not_applicable_in_state')
      return transition(context, { ...state, deadlineAt: now + policy.killRetryMs }, 'runner outlived its stop deadline', { externalEffects: [{ effect: 'kill_runner', generation: state.generation }] })
    case 'idle_timeout_reached':
      if (state.state !== 'idle') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, { outcome: 'stopped', stopped: { reason: 'idle' } }, 'idle exit', [{ effect: 'signal_runner_stop', generation: state.generation }])
    case 'finish_requested': return withStallsForgiven(decideRequestedStop(context, { outcome: 'done', summary: event.summary }, 'finished'))
    case 'archive_requested': return withStallsForgiven(decideArchive(context))
    case 'unarchive_requested':
      if (state.state !== 'archived') return refuse('not_applicable_in_state')
      return transition(context, { state: 'stopped', since: now, stopped: { reason: 'unarchived' } }, 'unarchived')
    case 'new_release_available':
      return decideRequestedStop(context, { outcome: 'relaunch', why: 'new_release' }, 'moving to a new release', { onlyIfRunning: true })
    case 'move_requested': return decideRequestedStop(context, { outcome: 'moving', toMachine: event.toMachine }, `moving to ${event.toMachine}`)
    case 'move_called_off':
      if (state.state !== 'moving') return refuse('not_applicable_in_state')
      return transition(context, { state: 'stopped', since: now, stopped: { reason: 'idle' } }, `move to ${state.toMachine} called off: ${event.why}`)
    case 'move_unconfirmed':
      if (state.state !== 'moving') return refuse('not_applicable_in_state')
      return transition(context, { ...state, handoff: { kind: 'unconfirmed', since: state.handoff.kind === 'unconfirmed' ? state.handoff.since : now, why: event.why } }, `move to ${state.toMachine} unconfirmed: ${event.why}`)
    case 'move_confirmed':
      if (state.state !== 'moving') return refuse('not_applicable_in_state')
      return transition(context, { state: 'moved', since: now, to: event.to }, `moved to ${event.to}`)
    case 'hold_between_turns':
      if (state.state !== 'idle') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, { outcome: 'held', hold: event.hold, retryAt: null }, `held: ${event.hold}`, [{ effect: 'signal_runner_stop', generation: state.generation }])
    case 'hold_cleared_without_work':
      if (state.state !== 'held') return refuse('not_applicable_in_state')
      return transition(context, { state: 'stopped', since: now, stopped: { reason: 'idle' } }, 'hold cleared with nothing waiting')
  }
}

interface DecisionContext {
  lifecycle: AgentLifecycle
  now: number
  policy: AgentPolicy
}

interface TransitionOptions {
  transactionEffects?: TransactionEffect[]
  externalEffects?: ExternalEffect[]
  consecutiveCrashes?: number
  consecutiveCreditFailures?: number
  consecutiveStalls?: number
  instanceGeneration?: number
  recordTransition?: boolean
}

function transition(context: DecisionContext, nextState: AgentState, cause: string, options: TransitionOptions = {}): AgentDecision {
  return {
    outcome: 'transition',
    next: {
      state: nextState,
      instanceGeneration: options.instanceGeneration ?? context.lifecycle.instanceGeneration,
      consecutiveCrashes: options.consecutiveCrashes ?? context.lifecycle.consecutiveCrashes,
      consecutiveCreditFailures: options.consecutiveCreditFailures ?? context.lifecycle.consecutiveCreditFailures,
      ownershipEpoch: context.lifecycle.ownershipEpoch,
      consecutiveStalls: options.consecutiveStalls ?? context.lifecycle.consecutiveStalls,
    },
    cause,
    recordTransition: options.recordTransition ?? true,
    transactionEffects: options.transactionEffects ?? [],
    externalEffects: options.externalEffects ?? [],
  }
}

function launch(context: DecisionContext, cause: string, options: TransitionOptions = {}): AgentDecision {
  const generation = context.lifecycle.instanceGeneration + 1
  const resumeConversation = context.lifecycle.instanceGeneration > 0
  return transition(context,
    { state: 'starting', since: context.now, generation, deadlineAt: context.now + context.policy.launchDeadlineMs },
    cause,
    { ...options, instanceGeneration: generation, externalEffects: [{ effect: 'launch_runner', generation, resumeConversation }] })
}

function beginStopping(context: DecisionContext, generation: number, then: StoppingOutcome, cause: string, externalEffects: ExternalEffect[], transactionEffects: TransactionEffect[] = []): AgentDecision {
  return transition(context,
    { state: 'stopping', since: context.now, generation, deadlineAt: context.now + context.policy.stopGraceMs, then, wakeWhenGone: false },
    cause,
    { externalEffects, transactionEffects })
}

function decideWake(context: DecisionContext, admission: WakeAdmission, reason: WakeReason): AgentDecision {
  const { state } = context.lifecycle
  switch (state.state) {
    case 'stopped':
    case 'done':
      break
    case 'held':
      // A message doesn't lift a provider or budget hold: it waits with the rest. Only the retry, or the cause clearing,
      // tries again. A missing slot is different: admission is asked afresh each time.
      if (state.hold !== 'no_slot' && reason !== 'hold_retry_due' && reason !== 'hold_cleared') return refuse('held')
      break
    case 'archived':
      return refuse('archived')
    case 'stopping':
      // A message arrived on its way down. It keeps going down, because the runner must be gone before any launch.
      if (reason !== 'new_message' || state.wakeWhenGone) return refuse('not_applicable_in_state')
      return transition(context, { ...state, wakeWhenGone: true }, 'a message arrived while stopping')
    case 'starting':
    case 'idle':
    case 'in_turn':
    case 'interrupting':
    case 'compacting':
    case 'moving':
    case 'moved':
      // Already up, or on its way somewhere; whoever asked has its message queued and the scheduler will deliver it.
      return refuse('not_applicable_in_state')
  }
  if (admission.kind === 'refused') {
    return transition(context, { state: 'held', since: state.state === 'held' ? state.since : context.now, hold: admission.hold, retryAt: admission.retryAt }, `wake refused: ${admission.hold}`)
  }
  return launch(context, `waking: ${reason}`)
}

/** The new state for an unexpected death of the model session. Backoff keeps a failing agent from spinning. */
function crashOutcome(context: DecisionContext, hadWork: boolean, why: string): StoppingOutcome {
  return { outcome: 'stopped', stopped: crashStopReason(context, hadWork, why) }
}

function crashStopReason(context: DecisionContext, hadWork: boolean, why: string): StoppedReason {
  const consecutiveCrashes = context.lifecycle.consecutiveCrashes + 1
  const { crashBackoffMs, crashLoopLimit } = context.policy
  if (consecutiveCrashes >= crashLoopLimit) {
    return { reason: 'crash', consecutiveCrashes, relaunch: { kind: 'gave_up', why: `crashed ${consecutiveCrashes} times in a row; last: ${why}` } }
  }
  if (!hadWork) return { reason: 'crash', consecutiveCrashes, relaunch: { kind: 'on_message' } }
  const backoffMs = crashBackoffMs[Math.min(consecutiveCrashes - 1, crashBackoffMs.length - 1)]!
  return { reason: 'crash', consecutiveCrashes, relaunch: { kind: 'at', at: context.now + backoffMs } }
}

function decideRunnerGone(context: DecisionContext, hadWork: boolean): AgentDecision {
  const { state } = context.lifecycle
  const { now } = context
  switch (state.state) {
    case 'stopping':
      return applyStoppingOutcome(context, state.then, state.wakeWhenGone)
    case 'interrupting':
      // It died on its way to stopping: the interrupt is effectively done, so its messages aren't redone.
      return transition(context, { state: 'stopped', since: now, stopped: crashStopReason(context, hadWork, 'died while interrupting') }, 'runner died while interrupting', {
        consecutiveCrashes: context.lifecycle.consecutiveCrashes + 1,
        transactionEffects: [
          { effect: 'complete_in_turn_deliveries_as_interrupted', turnId: state.turnId },
          { effect: 'record_interrupted_by', by: state.by },
        ],
      })
    case 'in_turn': {
      const stopped = crashStopReason(context, true, 'died mid-turn')
      return transition(context, { state: 'stopped', since: now, stopped }, 'runner died mid-turn', {
        consecutiveCrashes: context.lifecycle.consecutiveCrashes + 1,
        transactionEffects: requeueUnlessGivenUp(stopped, state.turnId),
      })
    }
    case 'starting':
    case 'idle':
    case 'compacting':
      return transition(context, { state: 'stopped', since: now, stopped: crashStopReason(context, hadWork, `died while ${state.state}`) }, `runner died while ${state.state}`, {
        consecutiveCrashes: context.lifecycle.consecutiveCrashes + 1,
      })
    case 'stopped':
    case 'held':
    case 'moving':
    case 'moved':
    case 'done':
    case 'archived':
      return refuse('not_applicable_in_state')
  }
}

function applyStoppingOutcome(context: DecisionContext, then: StoppingOutcome, wakeWhenGone: boolean): AgentDecision {
  const { now } = context
  const cause = 'runner confirmed gone'
  if (wakeWhenGone && (then.outcome === 'stopped' || then.outcome === 'done')) return launch(context, `${cause}, waking for a message that arrived meanwhile`)
  switch (then.outcome) {
    case 'stopped': {
      const crashes = then.stopped.reason === 'crash' ? { consecutiveCrashes: then.stopped.consecutiveCrashes } : {}
      return transition(context, { state: 'stopped', since: now, stopped: then.stopped }, cause, crashes)
    }
    case 'held': return transition(context, { state: 'held', since: now, hold: then.hold, retryAt: then.retryAt }, cause)
    case 'done': return transition(context, { state: 'done', since: now, summary: then.summary }, cause)
    case 'archived': return transition(context, { state: 'archived', since: now }, cause)
    // A message that arrived meanwhile stays queued and goes along.
    case 'moving': return toMoving(context, then.toMachine, cause)
    case 'relaunch': return launch(context, `${cause}, relaunching: ${then.why}`)
  }
}

function decideDispatch(context: DecisionContext, turnId: string): AgentDecision {
  const { state } = context.lifecycle
  const { now } = context
  if (state.state === 'idle') {
    return transition(context, { state: 'in_turn', since: now, generation: state.generation, turnId, activity: { kind: 'waiting' }, lastOutputAt: now, afterTurn: null }, 'deliveries dispatched', {
      transactionEffects: [{ effect: 'record_interrupted_by', by: null }],
    })
  }
  if (state.state === 'in_turn' && state.turnId === turnId) {
    return transition(context, state, 'deliveries joined the turn', { recordTransition: false })
  }
  return refuse('not_applicable_in_state')
}

function decideTurnFinished(context: DecisionContext, turnId: string, continuation: TurnContinuation): AgentDecision {
  const { state } = context.lifecycle
  const { now } = context
  if (state.state !== 'in_turn' && state.state !== 'interrupting') return refuse('not_applicable_in_state')
  if (state.turnId !== turnId) return refuse('stale_turn')

  if (state.state === 'interrupting') {
    return transition(context, { state: 'idle', since: now, generation: state.generation }, `turn interrupted by ${state.by}`, {
      consecutiveCrashes: 0,
      consecutiveStalls: 0,
      transactionEffects: [
        { effect: 'complete_in_turn_deliveries_as_interrupted', turnId },
        { effect: 'record_interrupted_by', by: state.by },
      ],
    })
  }

  if (continuation.kind === 'unacknowledged_deliveries_remain') {
    return transition(context, { ...state, since: now, turnId: continuation.nextTurnId, activity: { kind: 'waiting' }, lastOutputAt: now }, 'next turn continues with deliveries that joined late', {
      consecutiveCrashes: 0,
      consecutiveStalls: 0,
      transactionEffects: [{ effect: 'retag_in_turn_deliveries', toTurnId: continuation.nextTurnId }],
    })
  }

  if (state.afterTurn) return beginStoppingAfterTurn(context, state.generation, state.afterTurn)
  return transition(context, { state: 'idle', since: now, generation: state.generation }, 'turn finished', { consecutiveCrashes: 0, consecutiveCreditFailures: 0, consecutiveStalls: 0 })
}

function withStallCounted(decision: AgentDecision): AgentDecision {
  if (decision.outcome === 'transition') decision.next.consecutiveStalls += 1
  return decision
}

/** Someone decided what happens to the agent, so stalls before it no longer need telling. */
function withStallsForgiven(decision: AgentDecision): AgentDecision {
  if (decision.outcome === 'transition') decision.next.consecutiveStalls = 0
  return decision
}

function beginStoppingAfterTurn(context: DecisionContext, generation: number, then: StoppingOutcome): AgentDecision {
  const decision = beginStopping(context, generation, then, 'turn finished, applying what was waiting for it', [{ effect: 'signal_runner_stop', generation }])
  if (decision.outcome === 'transition') {
    decision.next.consecutiveCrashes = 0
    decision.next.consecutiveCreditFailures = 0
    decision.next.consecutiveStalls = 0
  }
  return decision
}

function decideTurnFailed(context: DecisionContext, turnId: string, failure: ProviderFailure, detail: string, retryAt: number | null): AgentDecision {
  const { state } = context.lifecycle
  if (state.state !== 'in_turn' && state.state !== 'interrupting') return refuse('not_applicable_in_state')
  if (state.turnId !== turnId) return refuse('stale_turn')

  const requeue: TransactionEffect[] = [{ effect: 'requeue_in_turn_deliveries' }]
  const signal: ExternalEffect[] = [{ effect: 'signal_runner_stop', generation: state.generation }]
  const cause = `turn failed: ${failure}: ${detail}`
  switch (failure) {
    case 'credits': {
      // Retries are spaced out whatever the provider says, so a long outage can't become a storm.
      const failures = context.lifecycle.consecutiveCreditFailures + 1
      const { creditRetryBackoffMs } = context.policy
      const backoffAt = context.now + creditRetryBackoffMs[Math.min(failures - 1, creditRetryBackoffMs.length - 1)]!
      const decision = beginStopping(context, state.generation, { outcome: 'held', hold: 'credits', retryAt: Math.max(retryAt ?? 0, backoffAt) }, cause, signal, requeue)
      if (decision.outcome === 'transition') decision.next.consecutiveCreditFailures = failures
      return decision
    }
    case 'logged_out':
    case 'usage_limit':
      return beginStopping(context, state.generation, { outcome: 'held', hold: failure, retryAt }, cause, signal, requeue)
    case 'transient': {
      const stopped = crashStopReason(context, true, detail)
      return beginStopping(context, state.generation, { outcome: 'stopped', stopped }, cause, signal, requeueUnlessGivenUp(stopped, turnId))
    }
    case 'fatal': {
      const stopped: StoppedReason = { reason: 'crash', consecutiveCrashes: context.lifecycle.consecutiveCrashes + 1, relaunch: { kind: 'gave_up', why: detail } }
      return beginStopping(context, state.generation, { outcome: 'stopped', stopped }, cause, signal, requeueUnlessGivenUp(stopped, turnId))
    }
    case 'model_refused':
      // Not a crash: only this input can't go through. But the provider keeps the refused input in its session and
      // sends it again on every resume, so that session is given up: the next message starts a fresh one.
      return beginStopping(context, state.generation, { outcome: 'stopped', stopped: { reason: 'idle' } }, cause, signal, [
        { effect: 'fail_in_turn_deliveries', turnId, failure: { kind: 'model_refused', providerMessage: detail } },
        { effect: 'discard_provider_session' },
      ])
  }
}

/**
 * When automatic retries stop, the work that kept coming back fails instead of going back to the queue, so the next
 * message doesn't feed it in again.
 */
function requeueUnlessGivenUp(stopped: StoppedReason, turnId: string): TransactionEffect[] {
  if (stopped.reason === 'crash' && stopped.relaunch.kind === 'gave_up') {
    return [{ effect: 'fail_in_turn_deliveries', turnId, failure: { kind: 'gave_up', why: stopped.relaunch.why } }]
  }
  return [{ effect: 'requeue_in_turn_deliveries' }]
}

/** A stop, finish or release move: right now if nothing is in progress, otherwise as the turn dictates. */
function decideRequestedStop(context: DecisionContext, then: StoppingOutcome, cause: string, options: { onlyIfRunning?: boolean } = {}): AgentDecision {
  const { state } = context.lifecycle
  const { now } = context
  switch (state.state) {
    case 'in_turn':
      if (then.outcome === 'stopped') {
        return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }], [{ effect: 'requeue_in_turn_deliveries' }])
      }
      // A release move is automatic, so it never replaces a plan already made, such as finishing; a move to another
      // computer replaces only a release move.
      if (then.outcome === 'relaunch' && state.afterTurn !== null) return refuse('not_applicable_in_state')
      if (then.outcome === 'moving' && state.afterTurn !== null && state.afterTurn.outcome !== 'relaunch') return refuse('not_applicable_in_state')
      // Finishing and new releases wait for the turn: the agent is usually inside it, reporting.
      return transition(context, { ...state, afterTurn: then }, `${cause}, after this turn`)
    case 'interrupting':
      if (then.outcome !== 'stopped') return refuse('not_applicable_in_state')
      return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }], [
        { effect: 'complete_in_turn_deliveries_as_interrupted', turnId: state.turnId },
        { effect: 'record_interrupted_by', by: state.by },
      ])
    case 'starting':
    case 'idle':
    case 'compacting':
      return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }])
    case 'stopping':
      // A deliberate stop or finish overrides an automatic relaunch or crash plan; the runner is already going. A move
      // overrides only those.
      if (then.outcome === 'relaunch') return refuse('not_applicable_in_state')
      if (then.outcome === 'moving' && state.then.outcome !== 'relaunch' && state.then.outcome !== 'stopped') return refuse('not_applicable_in_state')
      return transition(context, { ...state, then }, cause)
    case 'stopped':
    case 'held':
    case 'done':
      if (options.onlyIfRunning) return refuse('not_applicable_in_state')
      if (then.outcome === 'stopped') return transition(context, { state: 'stopped', since: now, stopped: then.stopped }, cause)
      if (then.outcome === 'done') return transition(context, { state: 'done', since: now, summary: then.summary }, cause)
      if (then.outcome === 'moving') return toMoving(context, then.toMachine, cause)
      return refuse('not_applicable_in_state')
    case 'moving':
    case 'moved':
    case 'archived':
      return refuse('not_applicable_in_state')
  }
}

function decideArchive(context: DecisionContext): AgentDecision {
  const { state } = context.lifecycle
  const { now } = context
  const then: StoppingOutcome = { outcome: 'archived' }
  const cause = 'archived'
  switch (state.state) {
    case 'stopped':
    case 'held':
    case 'done':
      return transition(context, { state: 'archived', since: now }, cause)
    case 'in_turn':
      return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }], [{ effect: 'requeue_in_turn_deliveries' }])
    case 'interrupting':
      return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }], [
        { effect: 'complete_in_turn_deliveries_as_interrupted', turnId: state.turnId },
        { effect: 'record_interrupted_by', by: state.by },
      ])
    case 'starting':
    case 'idle':
    case 'compacting':
      return beginStopping(context, state.generation, then, cause, [{ effect: 'signal_runner_stop', generation: state.generation }])
    case 'stopping':
      return transition(context, { ...state, then }, cause)
    case 'moving':
    case 'moved':
    case 'archived':
      return refuse('not_applicable_in_state')
  }
}

/** The handoff's epoch is the one the other computer will hold it under. */
function toMoving(context: DecisionContext, toMachine: string, cause: string): AgentDecision {
  return transition(context, { state: 'moving', since: context.now, toMachine, ownershipEpoch: context.lifecycle.ownershipEpoch + 1, handoff: { kind: 'not_sent' } }, cause)
}

export interface DueFacts {
  hasQueuedWork: boolean
  activeGoal: boolean
  /** When its goal's next cycle starts, if one is scheduled. */
  nextGoalCycleAt: number | null
  promptCache: PromptCacheRecord | null
}

/** The first deadline this state is waiting on, and the event it becomes. The scheduler applies these when due. */
export function dueEvent(lifecycle: AgentLifecycle, now: number, policy: AgentPolicy, facts: DueFacts): AgentEvent | null {
  const { state } = lifecycle
  switch (state.state) {
    case 'starting': return now >= state.deadlineAt ? { type: 'launch_deadline_passed' } : null
    case 'interrupting': return now >= state.deadlineAt ? { type: 'interrupt_deadline_passed' } : null
    case 'compacting': return now >= state.deadlineAt ? { type: 'compaction_deadline_passed' } : null
    case 'stopping': return now >= state.deadlineAt ? { type: 'stop_deadline_passed' } : null
    case 'in_turn': {
      const allowedSilenceMs = state.activity.kind === 'tool' ? policy.stallWhileToolMs : policy.stallMs
      return now >= state.lastOutputAt + allowedSilenceMs ? { type: 'stall_detected' } : null
    }
    case 'idle': {
      if (facts.hasQueuedWork) return null
      if (policy.idleExitMs === null || facts.activeGoal) {
        const beforeExpiry = { kind: 'before_cache_expiry', nextTurnAt: facts.nextGoalCycleAt } as const
        return compactionDue(facts.promptCache, now, beforeExpiry) ? { type: 'compaction_requested' } : null
      }
      if (now < state.since + policy.idleExitMs) return null
      // Compacted, it is idle again from now, and exits once the next idle period passes.
      return compactionDue(facts.promptCache, now, { kind: 'before_idle_exit' }) ? { type: 'compaction_requested' } : { type: 'idle_timeout_reached' }
    }
    case 'stopped':
    case 'held':
    case 'moving':
    case 'moved':
    case 'done':
    case 'archived':
      return null
  }
}

/** The turn to report as long-running, if this one has run past the alert threshold and isn't the one already reported. */
export function longTurnToReport(state: AgentState, now: number, policy: AgentPolicy, reportedTurnId: string | null): { turnId: string; busyForMs: number } | null {
  if (state.state !== 'in_turn' || state.turnId === reportedTurnId) return null
  const busyForMs = now - state.since
  return busyForMs >= policy.longTurnAlertMs ? { turnId: state.turnId, busyForMs } : null
}

/** Whether queued work may start this agent without a new message arriving. A deliberate stop stays stopped. */
export function wakeReasonForQueuedWork(state: AgentState, now: number): WakeReason | null {
  switch (state.state) {
    case 'stopped':
      switch (state.stopped.reason) {
        case 'idle': return 'queued_work'
        case 'crash':
          if (state.stopped.relaunch.kind !== 'at') return null
          return now >= state.stopped.relaunch.at ? 'crash_backoff_elapsed' : null
        case 'deliberate':
        case 'unarchived':
          return null
      }
      break
    case 'held':
      return state.retryAt !== null && now >= state.retryAt ? 'hold_retry_due' : null
    case 'done':
      return 'queued_work'
    case 'starting':
    case 'idle':
    case 'in_turn':
    case 'interrupting':
    case 'compacting':
    case 'stopping':
    case 'moving':
    case 'moved':
    case 'archived':
      return null
  }
}
