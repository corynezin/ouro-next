import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_TASKS_CAP_MS, decideAgent, defaultAgentPolicy, dueEvent, idleExitAt, liveGeneration, longTurnToReport, wakeReasonForQueuedWork } from './agent.ts'
import type { AgentDecision, AgentEvent, AgentLifecycle, ExternalEffect } from './agent.ts'

const policy = defaultAgentPolicy
const granted = { kind: 'granted' } as const

const fresh = (): AgentLifecycle => ({
  state: { state: 'stopped', since: 0, stopped: { reason: 'unarchived' } },
  instanceGeneration: 0,
  consecutiveCrashes: 0,
  consecutiveCreditFailures: 0,
  ownershipEpoch: 0,
  consecutiveStalls: 0,
})

function apply(lifecycle: AgentLifecycle, event: AgentEvent, now = 1000): Extract<AgentDecision, { outcome: 'transition' }> {
  const decision = decideAgent(lifecycle, event, now, policy)
  assert.equal(decision.outcome, 'transition', `expected ${event.type} to apply in ${lifecycle.state.state}`)
  return decision as Extract<AgentDecision, { outcome: 'transition' }>
}

function run(events: AgentEvent[], from = fresh()): AgentLifecycle {
  return events.reduce((lifecycle, event) => apply(lifecycle, event).next, from)
}

const toIdle = (): AgentEvent[] => [
  { type: 'wake_requested', admission: granted, reason: 'created' },
  { type: 'runner_ready', generation: 1 },
]
const toInTurn = (turnId = 't1'): AgentEvent[] => [...toIdle(), { type: 'deliveries_dispatched', generation: 1, turnId }]

test('a wake increments the generation and launches', () => {
  const decision = apply(fresh(), { type: 'wake_requested', admission: granted, reason: 'created' })
  assert.equal(decision.next.instanceGeneration, 1)
  assert.deepEqual(decision.externalEffects, [{ effect: 'launch_runner', generation: 1, resumeConversation: false }])
})

test('a refused wake holds the agent and launches nothing', () => {
  const decision = apply(fresh(), { type: 'wake_requested', admission: { kind: 'refused', hold: 'no_slot', retryAt: 5000 }, reason: 'new_message' })
  assert.deepEqual(decision.next.state, { state: 'held', since: 1000, hold: 'no_slot', retryAt: 5000 })
  assert.deepEqual(decision.externalEffects, [])
  assert.equal(decision.next.instanceGeneration, 0)
})

test('a copy waiting to be started is neither woken nor held', () => {
  assert.deepEqual(decideAgent(fresh(), { type: 'wake_requested', admission: { kind: 'awaiting_start' }, reason: 'new_message' }, 1000, policy), { outcome: 'refused', why: 'awaiting_start' })
})

test('a second wake while starting launches nothing', () => {
  const starting = run([{ type: 'wake_requested', admission: granted, reason: 'created' }])
  assert.deepEqual(decideAgent(starting, { type: 'wake_requested', admission: granted, reason: 'new_message' }, 1000, policy), { outcome: 'refused', why: 'not_applicable_in_state' })
})

test('reports from an older generation are refused', () => {
  const idle = run(toIdle())
  const decision = decideAgent(idle, { type: 'deliveries_dispatched', generation: 0, turnId: 't' }, 1000, policy)
  assert.deepEqual(decision, { outcome: 'refused', why: 'stale_generation' })
})

test('an unanswered launch is killed and confirmed gone before any relaunch', () => {
  const starting = run([{ type: 'wake_requested', admission: granted, reason: 'created' }])
  const stopping = apply(starting, { type: 'launch_deadline_passed' })
  assert.equal(stopping.next.state.state, 'stopping')
  assert.deepEqual(stopping.externalEffects, [{ effect: 'kill_runner', generation: 1 }])
  const gone = apply(stopping.next, { type: 'runner_gone', generation: 1, hadWork: true })
  assert.equal(gone.next.state.state, 'stopped')
  assert.deepEqual(gone.externalEffects, [])
  const late = decideAgent(gone.next, { type: 'runner_ready', generation: 1 }, 1000, policy)
  assert.equal(late.outcome, 'refused')
})

test('a runner that outlives its deadline stays stopping and is killed again', () => {
  const stopping = run([...toIdle(), { type: 'stop_requested', by: 'human' }])
  const again = apply(stopping, { type: 'stop_deadline_passed' }, 99_000)
  assert.equal(again.next.state.state, 'stopping')
  assert.deepEqual(again.externalEffects, [{ effect: 'kill_runner', generation: 1 }])
})

test('a crash mid-turn requeues its deliveries and relaunches on a backoff', () => {
  const inTurn = run(toInTurn())
  const crash = apply(inTurn, { type: 'runner_gone', generation: 1, hadWork: true })
  assert.deepEqual(crash.transactionEffects, [{ effect: 'requeue_in_turn_deliveries' }])
  assert.deepEqual(crash.next.state, { state: 'stopped', since: 1000, stopped: { reason: 'crash', consecutiveCrashes: 1, relaunch: { kind: 'at', at: 6000 } } })
  assert.equal(wakeReasonForQueuedWork(crash.next.state, 5999), null)
  assert.equal(wakeReasonForQueuedWork(crash.next.state, 6000), 'crash_backoff_elapsed')
})

test('a crash with no work stays down until a message', () => {
  const crash = apply(run(toIdle()), { type: 'runner_gone', generation: 1, hadWork: false })
  assert.equal(wakeReasonForQueuedWork(crash.next.state, 1e12), null)
  assert.deepEqual(crash.next.state, { state: 'stopped', since: 1000, stopped: { reason: 'crash', consecutiveCrashes: 1, relaunch: { kind: 'on_message' } } })
})

test('a crash loop gives up after the limit, and only a message restarts it', () => {
  let lifecycle = run(toInTurn())
  for (let crash = 1; crash < policy.crashLoopLimit; crash++) {
    lifecycle = apply(lifecycle, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true }).next
    lifecycle = apply(lifecycle, { type: 'wake_requested', admission: granted, reason: 'crash_backoff_elapsed' }).next
    lifecycle = apply(lifecycle, { type: 'runner_ready', generation: lifecycle.instanceGeneration }).next
    lifecycle = apply(lifecycle, { type: 'deliveries_dispatched', generation: lifecycle.instanceGeneration, turnId: `t${crash}` }).next
  }
  const final = apply(lifecycle, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true })
  assert.ok(final.next.state.state === 'stopped' && final.next.state.stopped.reason === 'crash' && final.next.state.stopped.relaunch.kind === 'gave_up')
  // The work that kept crashing it fails rather than going back to the queue for the next message to feed in again.
  assert.deepEqual(final.transactionEffects.map((effect) => effect.effect), ['fail_in_turn_deliveries'])
  assert.equal(wakeReasonForQueuedWork(final.next.state, 1e12), null)
  assert.equal(apply(final.next, { type: 'wake_requested', admission: granted, reason: 'new_message' }).next.state.state, 'starting')
})

test('a refused input fails, and the agent stops cleanly: no crash count, no requeue, the next message starts it', () => {
  const inTurn = run(toInTurn())
  const failed = apply(inTurn, { type: 'turn_failed', generation: 1, turnId: 't1', failure: 'model_refused', detail: 'safeguards flagged this message', retryAt: null })
  assert.deepEqual(failed.transactionEffects, [
    { effect: 'fail_in_turn_deliveries', turnId: 't1', failure: { kind: 'model_refused', providerMessage: 'safeguards flagged this message' } },
    { effect: 'discard_provider_session' },
  ])
  assert.deepEqual(failed.externalEffects, [{ effect: 'signal_runner_stop', generation: 1 }])
  const gone = apply(failed.next, { type: 'runner_gone', generation: 1, hadWork: true })
  assert.deepEqual(gone.next.state, { state: 'stopped', since: 1000, stopped: { reason: 'idle' } })
  assert.equal(gone.next.consecutiveCrashes, 0)
  // The refused input is no longer queued; other messages that were waiting still start it.
  assert.equal(wakeReasonForQueuedWork(gone.next.state, 1e12), 'queued_work')
  assert.equal(apply(gone.next, { type: 'wake_requested', admission: granted, reason: 'new_message' }).next.state.state, 'starting')
})

test('a transient failure that keeps recurring also gives up at the limit, failing its work', () => {
  let lifecycle = run(toInTurn())
  for (let failure = 1; failure < policy.crashLoopLimit; failure++) {
    const turnId = lifecycle.state.state === 'in_turn' ? lifecycle.state.turnId : ''
    const failed = apply(lifecycle, { type: 'turn_failed', generation: lifecycle.instanceGeneration, turnId, failure: 'transient', detail: 'API Error', retryAt: null })
    assert.deepEqual(failed.transactionEffects, [{ effect: 'requeue_in_turn_deliveries' }])
    lifecycle = apply(failed.next, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true }).next
    assert.ok(lifecycle.state.state === 'stopped' && lifecycle.state.stopped.reason === 'crash' && lifecycle.state.stopped.relaunch.kind === 'at')
    lifecycle = apply(lifecycle, { type: 'wake_requested', admission: granted, reason: 'crash_backoff_elapsed' }).next
    lifecycle = apply(lifecycle, { type: 'runner_ready', generation: lifecycle.instanceGeneration }).next
    lifecycle = apply(lifecycle, { type: 'deliveries_dispatched', generation: lifecycle.instanceGeneration, turnId: `t${failure}` }).next
  }
  const last = apply(lifecycle, { type: 'turn_failed', generation: lifecycle.instanceGeneration, turnId: `t${policy.crashLoopLimit - 1}`, failure: 'transient', detail: 'API Error', retryAt: null })
  assert.equal(last.transactionEffects[0]?.effect, 'fail_in_turn_deliveries')
  const stopped = apply(last.next, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true }).next
  assert.ok(stopped.state.state === 'stopped' && stopped.state.stopped.reason === 'crash' && stopped.state.stopped.relaunch.kind === 'gave_up')
})

test('a finished turn resets the crash count', () => {
  const lifecycle = { ...run(toInTurn()), consecutiveCrashes: 3 }
  const finished = apply(lifecycle, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.equal(finished.next.consecutiveCrashes, 0)
  assert.equal(finished.next.state.state, 'idle')
})

test('stalls in a row are counted through each relaunch, and a finished turn, a stop or an archive clears them', () => {
  let lifecycle = run(toInTurn())
  for (let stall = 1; stall <= 3; stall++) {
    lifecycle = apply(lifecycle, { type: 'stall_detected' }).next
    assert.equal(lifecycle.consecutiveStalls, stall)
    lifecycle = apply(lifecycle, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true }).next
    assert.equal(lifecycle.state.state, 'starting', 'a stall relaunches at once')
    lifecycle = apply(lifecycle, { type: 'runner_ready', generation: lifecycle.instanceGeneration }).next
    lifecycle = apply(lifecycle, { type: 'deliveries_dispatched', generation: lifecycle.instanceGeneration, turnId: `t${stall}` }).next
  }
  assert.equal(lifecycle.consecutiveStalls, 3)
  assert.equal(lifecycle.consecutiveCrashes, 0, 'a stall is not a crash')
  const finished = apply(lifecycle, { type: 'turn_finished', generation: lifecycle.instanceGeneration, turnId: 't3', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.equal(finished.next.consecutiveStalls, 0)
  assert.equal(apply(lifecycle, { type: 'stop_requested', by: 'human' }).next.consecutiveStalls, 0)
  assert.equal(apply(lifecycle, { type: 'archive_requested' }).next.consecutiveStalls, 0)
})

test('deliveries that joined late continue as the next turn', () => {
  const finished = apply(run(toInTurn()), { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'unacknowledged_deliveries_remain', nextTurnId: 't2' } })
  assert.ok(finished.next.state.state === 'in_turn')
  assert.equal(finished.next.state.turnId, 't2')
  assert.deepEqual(finished.transactionEffects, [{ effect: 'retag_in_turn_deliveries', toTurnId: 't2' }])
})

test('interrupt leaves the agent up, and what the turn took in is not redone', () => {
  const interrupting = apply(run(toInTurn()), { type: 'interrupt_requested', by: 'human' })
  assert.deepEqual(interrupting.externalEffects, [{ effect: 'send_interrupt', generation: 1, turnId: 't1' }])
  const finished = apply(interrupting.next, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.equal(finished.next.state.state, 'idle')
  assert.deepEqual(finished.transactionEffects, [
    { effect: 'complete_in_turn_deliveries_as_interrupted', turnId: 't1' },
    { effect: 'record_interrupted_by', by: 'human' },
  ])
})

test('a forced interrupt relaunches and still does not redo the turn', () => {
  const interrupting = apply(run(toInTurn()), { type: 'interrupt_requested', by: 'human' }).next
  const forced = apply(interrupting, { type: 'interrupt_deadline_passed' })
  assert.ok(forced.transactionEffects.some((effect) => effect.effect === 'complete_in_turn_deliveries_as_interrupted'))
  const relaunched = apply(forced.next, { type: 'runner_gone', generation: 1, hadWork: false })
  assert.equal(relaunched.next.state.state, 'starting')
  assert.equal(relaunched.next.instanceGeneration, 2)
})

test('a deliberate stop is sticky against queued work, but a new message wakes it', () => {
  const stopping = apply(run(toInTurn()), { type: 'stop_requested', by: 'human' })
  assert.deepEqual(stopping.transactionEffects, [{ effect: 'requeue_in_turn_deliveries' }])
  const stopped = apply(stopping.next, { type: 'runner_gone', generation: 1, hadWork: true }).next
  assert.deepEqual(stopped.state, { state: 'stopped', since: 1000, stopped: { reason: 'deliberate', by: 'human' } })
  assert.equal(wakeReasonForQueuedWork(stopped.state, 1e12), null)
  assert.equal(apply(stopped, { type: 'wake_requested', admission: granted, reason: 'new_message' }).next.state.state, 'starting')
})

test('a message during a deliberate stop waits for the runner to go, then wakes it', () => {
  const stopping = run([...toIdle(), { type: 'stop_requested', by: 'human' }])
  const noted = apply(stopping, { type: 'wake_requested', admission: granted, reason: 'new_message' })
  assert.deepEqual(noted.externalEffects, [])
  const gone = apply(noted.next, { type: 'runner_gone', generation: 1, hadWork: true })
  assert.deepEqual(gone.externalEffects, [{ effect: 'launch_runner', generation: 2, resumeConversation: true }])
})

test('finishing inside a turn waits for the turn, then stops and reopens on a message', () => {
  const finishing = apply(run(toInTurn()), { type: 'finish_requested', summary: 'all set' })
  assert.ok(finishing.next.state.state === 'in_turn' && finishing.next.state.afterTurn?.outcome === 'done')
  const stopping = apply(finishing.next, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.deepEqual(stopping.externalEffects, [{ effect: 'signal_runner_stop', generation: 1 }])
  const done = apply(stopping.next, { type: 'runner_gone', generation: 1, hadWork: false }).next
  assert.deepEqual(done.state, { state: 'done', since: 1000, summary: 'all set' })
  const reopened = apply(done, { type: 'wake_requested', admission: granted, reason: 'new_message' })
  assert.deepEqual(reopened.externalEffects, [{ effect: 'launch_runner', generation: 2, resumeConversation: true }])
})

test('a turn the model begins on its own, idle, is a turn: a finish inside it waits for its end', () => {
  const began = apply(run(toIdle()), { type: 'unprompted_turn_began', generation: 1, turnId: 'u1' }, 5000)
  assert.deepEqual(began.next.state, { state: 'in_turn', since: 5000, generation: 1, turnId: 'u1', activity: { kind: 'waiting' }, lastOutputAt: 5000, afterTurn: null })
  assert.deepEqual(began.externalEffects, [])
  const finishing = apply(began.next, { type: 'finish_requested', summary: 'reported' })
  assert.deepEqual(finishing.externalEffects, [])
  const stopping = apply(finishing.next, { type: 'turn_finished', generation: 1, turnId: 'u1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.deepEqual(stopping.externalEffects, [{ effect: 'signal_runner_stop', generation: 1 }])
  // Already in a turn, or not up, it changes nothing.
  assert.deepEqual(decideAgent(run(toInTurn()), { type: 'unprompted_turn_began', generation: 1, turnId: 'u2' }, 1000, policy), { outcome: 'refused', why: 'not_applicable_in_state' })
  assert.deepEqual(decideAgent(run(toIdle()), { type: 'unprompted_turn_began', generation: 0, turnId: 'u2' }, 1000, policy), { outcome: 'refused', why: 'stale_generation' })
})

test('the idle exit waits for background tasks, up to a cap, and counts the idle period from their last change', () => {
  const idleMs = 30 * 60_000
  assert.equal(idleExitAt(1000, 1, idleMs, null), 1000 + idleMs)
  // Running: held off until the cap after the tasks last changed, never sooner than the plain idle exit.
  assert.equal(idleExitAt(1000, 1, idleMs, { generation: 1, running: 1, changedAt: 2000 }), 2000 + BACKGROUND_TASKS_CAP_MS)
  // All finished: the idle period starts again from when they did.
  assert.equal(idleExitAt(1000, 1, idleMs, { generation: 1, running: 0, changedAt: 9000 }), 9000 + idleMs)
  assert.equal(idleExitAt(9000, 1, idleMs, { generation: 1, running: 0, changedAt: 1000 }), 9000 + idleMs)
  // Reported by an earlier runner: those tasks died with it.
  assert.equal(idleExitAt(1000, 2, idleMs, { generation: 1, running: 1, changedAt: 2000 }), 1000 + idleMs)

  const idle = run(toIdle())
  const facts = { hasQueuedWork: false, activeGoal: false, nextGoalCycleAt: null, promptCache: null }
  const running = { ...facts, backgroundTasks: { generation: 1, running: 1, changedAt: 1000 } }
  assert.equal(dueEvent(idle, 1000 + idleMs, policy, running), null)
  assert.deepEqual(dueEvent(idle, 1000 + BACKGROUND_TASKS_CAP_MS, policy, running), { type: 'idle_timeout_reached' })
})

test('a provider hold keeps the work and resumes on the same conversation', () => {
  const failed = apply(run(toInTurn()), { type: 'turn_failed', generation: 1, turnId: 't1', failure: 'usage_limit', detail: 'limit', retryAt: 300_000 })
  assert.deepEqual(failed.transactionEffects, [{ effect: 'requeue_in_turn_deliveries' }])
  const held = apply(failed.next, { type: 'runner_gone', generation: 1, hadWork: true }).next
  assert.deepEqual(held.state, { state: 'held', since: 1000, hold: 'usage_limit', retryAt: 300_000 })
  assert.equal(wakeReasonForQueuedWork(held.state, 299_999), null)
  assert.equal(wakeReasonForQueuedWork(held.state, 300_000), 'hold_retry_due')
  assert.equal(apply(held, { type: 'wake_requested', admission: granted, reason: 'hold_retry_due' }).next.state.state, 'starting')
})

test('a message to an agent held by its provider waits for the retry', () => {
  const failed = apply(run(toInTurn()), { type: 'turn_failed', generation: 1, turnId: 't1', failure: 'credits', detail: 'x', retryAt: null })
  const held = apply(failed.next, { type: 'runner_gone', generation: 1, hadWork: true }).next
  assert.deepEqual(decideAgent(held, { type: 'wake_requested', admission: granted, reason: 'new_message' }, 2000, policy), { outcome: 'refused', why: 'held' })
  const waiting = apply(fresh(), { type: 'wake_requested', admission: { kind: 'refused', hold: 'no_slot', retryAt: 5000 }, reason: 'new_message' }).next
  assert.equal(apply(waiting, { type: 'wake_requested', admission: granted, reason: 'new_message' }).next.state.state, 'starting')
})

test('credit failures retry after 5, 10, 20, 40, then every 60 minutes, and a finished turn resets that', () => {
  const minutes = (ms: number) => ms / 60_000
  let lifecycle = run(toInTurn('t0'))
  const waits: number[] = []
  for (let failure = 0; failure < 6; failure++) {
    const now = 1000
    const failed = apply(lifecycle, { type: 'turn_failed', generation: lifecycle.instanceGeneration, turnId: `t${failure}`, failure: 'credits', detail: 'no credit', retryAt: null }, now)
    const held = apply(failed.next, { type: 'runner_gone', generation: lifecycle.instanceGeneration, hadWork: true }, now).next
    assert.ok(held.state.state === 'held' && held.state.retryAt !== null)
    waits.push(minutes(held.state.retryAt - now))
    lifecycle = apply(held, { type: 'wake_requested', admission: granted, reason: 'hold_retry_due' }).next
    lifecycle = apply(lifecycle, { type: 'runner_ready', generation: lifecycle.instanceGeneration }).next
    lifecycle = apply(lifecycle, { type: 'deliveries_dispatched', generation: lifecycle.instanceGeneration, turnId: `t${failure + 1}` }).next
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 60, 60])
  const finished = apply(lifecycle, { type: 'turn_finished', generation: lifecycle.instanceGeneration, turnId: 't6', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.equal(finished.next.consecutiveCreditFailures, 0)
})

test('a new release applies between turns and never mid-turn', () => {
  const mid = apply(run(toInTurn()), { type: 'new_release_available' })
  assert.deepEqual(mid.externalEffects, [])
  assert.ok(mid.next.state.state === 'in_turn')
  const after = apply(mid.next, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.deepEqual(after.externalEffects, [{ effect: 'signal_runner_stop', generation: 1 }])
  const relaunched = apply(after.next, { type: 'runner_gone', generation: 1, hadWork: false })
  assert.deepEqual(relaunched.externalEffects, [{ effect: 'launch_runner', generation: 2, resumeConversation: true }])
  const stoppedAgent = run([...toIdle(), { type: 'stop_requested', by: 'human' }, { type: 'runner_gone', generation: 1, hadWork: false }])
  assert.equal(decideAgent(stoppedAgent, { type: 'new_release_available' }, 1000, policy).outcome, 'refused')
})

test('archive and unarchive', () => {
  const archived = run([...toIdle(), { type: 'archive_requested' }, { type: 'runner_gone', generation: 1, hadWork: false }])
  assert.equal(archived.state.state, 'archived')
  assert.deepEqual(decideAgent(archived, { type: 'wake_requested', admission: granted, reason: 'new_message' }, 1000, policy), { outcome: 'refused', why: 'archived' })
  const back = apply(archived, { type: 'unarchive_requested' }).next
  assert.deepEqual(back.state, { state: 'stopped', since: 1000, stopped: { reason: 'unarchived' } })
})

test('a hold that began during a turn stops the agent between turns, and only then', () => {
  const idle = run(toIdle())
  const stopping = apply(idle, { type: 'hold_between_turns', hold: 'budget' })
  assert.equal(stopping.next.state.state, 'stopping')
  assert.deepEqual(stopping.externalEffects, [{ effect: 'signal_runner_stop', generation: 1 }])
  const held = apply(stopping.next, { type: 'runner_gone', generation: 1, hadWork: false })
  assert.deepEqual(held.next.state, { state: 'held', since: 1000, hold: 'budget', retryAt: null })
  assert.deepEqual(decideAgent(run(toInTurn()), { type: 'hold_between_turns', hold: 'budget' }, 1000, policy), { outcome: 'refused', why: 'not_applicable_in_state' })
})

test('deadlines become events', () => {
  const inTurn = run(toInTurn())
  const noFacts = { hasQueuedWork: false, activeGoal: false, nextGoalCycleAt: null, promptCache: null, backgroundTasks: null }
  assert.equal(dueEvent(inTurn, 1000 + policy.stallMs - 1, policy, noFacts), null)
  assert.deepEqual(dueEvent(inTurn, 1000 + policy.stallMs, policy, noFacts), { type: 'stall_detected' })
  const onTool = apply(inTurn, { type: 'turn_activity', generation: 1, turnId: 't1', activity: { kind: 'tool', toolName: 'Bash' } }, 1000).next
  assert.equal(dueEvent(onTool, 1000 + policy.stallMs, policy, noFacts), null)
  const idle = run(toIdle())
  assert.deepEqual(dueEvent(idle, 1000 + policy.idleExitMs!, policy, noFacts), { type: 'idle_timeout_reached' })
  assert.equal(dueEvent(idle, 1000 + policy.idleExitMs!, policy, { ...noFacts, hasQueuedWork: true }), null)
  assert.equal(dueEvent(idle, 1000 + policy.idleExitMs!, policy, { ...noFacts, activeGoal: true }), null)
})

test('a stall restarts the turn, and the agent is told how long it was silent', () => {
  const inTurn = run(toInTurn())
  const stalled = apply(inTurn, { type: 'stall_detected' }, 1000 + policy.stallMs)
  assert.equal(stalled.next.state.state, 'stopping')
  assert.deepEqual(stalled.transactionEffects, [
    { effect: 'requeue_in_turn_deliveries' },
    { effect: 'tell_agent_it_stalled', silentForMs: policy.stallMs },
  ])
})

test('a turn past the alert threshold is reported once, and a continuation turn counts afresh', () => {
  const inTurn = run(toInTurn('t1'))
  assert.equal(longTurnToReport(inTurn.state, 1000 + policy.longTurnAlertMs - 1, policy, null), null)
  assert.deepEqual(longTurnToReport(inTurn.state, 1000 + policy.longTurnAlertMs, policy, null), { turnId: 't1', busyForMs: policy.longTurnAlertMs })
  assert.equal(longTurnToReport(inTurn.state, 1000 + 2 * policy.longTurnAlertMs, policy, 't1'), null)
  const later = 1000 + policy.longTurnAlertMs
  const continued = decideAgent(inTurn, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'unacknowledged_deliveries_remain', nextTurnId: 't2' } }, later, policy)
  assert.equal(continued.outcome, 'transition')
  const next = (continued as Extract<AgentDecision, { outcome: 'transition' }>).next
  assert.equal(longTurnToReport(next.state, later + 1, policy, 't1'), null)
  assert.deepEqual(longTurnToReport(next.state, later + policy.longTurnAlertMs, policy, 't1'), { turnId: 't2', busyForMs: policy.longTurnAlertMs })
  assert.equal(longTurnToReport(run(toIdle()).state, later + policy.longTurnAlertMs, policy, null), null)
})

// Generated sequences. A small model of the world tracks which runners exist, driven only by the reducer's effects.
function nextRandom(seed: number): number {
  return (seed * 1664525 + 1013904223) >>> 0
}

test('generated event sequences never produce a second live instance', () => {
  for (let seed = 1; seed <= 300; seed++) {
    let random = seed
    const pick = (limit: number) => {
      random = nextRandom(random)
      return (random >>> 8) % limit
    }
    let lifecycle = fresh()
    let now = 1000
    // Runners launched and not yet confirmed gone, in the world outside the reducer.
    const liveRunners = new Set<number>()
    let previousGeneration = 0

    const perform = (effects: ExternalEffect[]) => {
      for (const effect of effects) {
        if (effect.effect !== 'launch_runner') continue
        assert.equal(liveRunners.size, 0, `seed ${seed}: launch of ${effect.generation} while ${[...liveRunners]} still live`)
        liveRunners.add(effect.generation)
      }
    }

    for (let step = 0; step < 200; step++) {
      now += pick(100_000)
      const generation = pick(5) === 0 ? lifecycle.instanceGeneration - 1 : lifecycle.instanceGeneration
      const turnId = lifecycle.state.state === 'in_turn' || lifecycle.state.state === 'interrupting' ? lifecycle.state.turnId : `turn-${step}`
      const candidates: AgentEvent[] = [
        { type: 'wake_requested', admission: pick(4) === 0 ? { kind: 'refused', hold: 'no_slot', retryAt: now + 1000 } : granted, reason: 'new_message' },
        { type: 'runner_ready', generation },
        { type: 'launch_deadline_passed' },
        { type: 'deliveries_dispatched', generation, turnId },
        { type: 'unprompted_turn_began', generation, turnId },
        { type: 'turn_activity', generation, turnId, activity: { kind: 'thinking' } },
        { type: 'turn_finished', generation, turnId, continuation: pick(4) === 0 ? { kind: 'unacknowledged_deliveries_remain', nextTurnId: `next-${step}` } : { kind: 'no_unacknowledged_deliveries' } },
        { type: 'turn_failed', generation, turnId, failure: (['logged_out', 'credits', 'usage_limit', 'transient', 'fatal', 'model_refused'] as const)[pick(6)]!, detail: 'x', retryAt: null },
        { type: 'stall_detected' },
        { type: 'interrupt_requested', by: 'human' },
        { type: 'interrupt_deadline_passed' },
        { type: 'compaction_requested' },
        { type: 'compaction_finished', generation },
        { type: 'stop_requested', by: 'human' },
        { type: 'stop_deadline_passed' },
        { type: 'idle_timeout_reached' },
        { type: 'hold_between_turns', hold: 'budget' },
        { type: 'finish_requested', summary: 'x' },
        { type: 'archive_requested' },
        { type: 'unarchive_requested' },
        { type: 'new_release_available' },
        { type: 'runner_gone', generation, hadWork: pick(2) === 0 },
      ]
      const event = candidates[pick(candidates.length)]!
      const decision = decideAgent(lifecycle, event, now, policy)
      if (decision.outcome === 'refused') continue

      // A runner reported gone is gone in the world, whichever state believed in it.
      if (event.type === 'runner_gone') liveRunners.delete(event.generation)
      perform(decision.externalEffects)

      lifecycle = decision.next
      assert.ok(lifecycle.instanceGeneration >= previousGeneration, `seed ${seed}: generation fell`)
      previousGeneration = lifecycle.instanceGeneration
      const live = liveGeneration(lifecycle.state)
      assert.ok(live === null || live === lifecycle.instanceGeneration, `seed ${seed}: state believes in generation ${live} of ${lifecycle.instanceGeneration}`)
      if (live === null) assert.equal(liveRunners.size, 0, `seed ${seed}: ${lifecycle.state.state} with a runner still live`)
    }
  }
})

test('a move waits for the end of the turn, then for the runner to be gone, and no wake starts it meanwhile', () => {
  const planned = apply(run(toInTurn()), { type: 'move_requested', toMachine: 'beta' })
  assert.deepEqual(planned.next.state.state === 'in_turn' && planned.next.state.afterTurn, { outcome: 'moving', toMachine: 'beta' })
  const finished = apply(planned.next, { type: 'turn_finished', generation: 1, turnId: 't1', continuation: { kind: 'no_unacknowledged_deliveries' } })
  assert.equal(finished.next.state.state, 'stopping')
  const gone = apply(finished.next, { type: 'runner_gone', generation: 1, hadWork: false })
  assert.deepEqual(gone.next.state, { state: 'moving', since: 1000, toMachine: 'beta', ownershipEpoch: 1, handoff: { kind: 'not_sent' } })
  assert.equal(decideAgent(gone.next, { type: 'wake_requested', admission: granted, reason: 'new_message' }, 1000, policy).outcome, 'refused')
  assert.equal(decideAgent(gone.next, { type: 'archive_requested' }, 1000, policy).outcome, 'refused')
})

test('a stopped agent moves at once; a move never replaces finishing', () => {
  assert.equal(apply(fresh(), { type: 'move_requested', toMachine: 'beta' }).next.state.state, 'moving')
  const finishing = apply(run(toInTurn()), { type: 'finish_requested', summary: 'all done' })
  assert.equal(decideAgent(finishing.next, { type: 'move_requested', toMachine: 'beta' }, 1000, policy).outcome, 'refused')
})

test('a move called off leaves it stopped here; a confirmed one leaves it moved, never to run here again', () => {
  const moving = apply(fresh(), { type: 'move_requested', toMachine: 'beta' }).next
  assert.deepEqual(apply(moving, { type: 'move_called_off', why: 'beta refused' }).next.state, { state: 'stopped', since: 1000, stopped: { reason: 'idle' } })
  const moved = apply(moving, { type: 'move_confirmed', to: 'worker@beta' }).next
  assert.deepEqual(moved.state, { state: 'moved', since: 1000, to: 'worker@beta' })
  for (const event of [{ type: 'wake_requested', admission: granted, reason: 'new_message' }, { type: 'unarchive_requested' }, { type: 'move_requested', toMachine: 'gamma' }] as AgentEvent[]) {
    assert.equal(decideAgent(moved, event, 1000, policy).outcome, 'refused', event.type)
  }
})
