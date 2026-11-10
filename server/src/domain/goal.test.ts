import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentState } from '@ouro/contract'
import { completeGoal, endCycle, GoalRefusal, MAX_GOAL_BACKOFF_MS, newGoal, nextCycle, noteInterrupt, noteRealMessage, pauseGoal, reopenGoal, resumeGoal, startCycle, validateInterval } from './goal.ts'

const idle: AgentState = { state: 'idle', since: 1000, generation: 1 }
const facts = { agentState: idle, agentQuietSince: 1000, hasQueuedDeliveries: false, planHold: null }
const goal = newGoal({ agentId: 'a', text: 'make it fast', kind: { kind: 'finishing' }, intervalSeconds: null, setBy: 'human', now: 0 })

test('a cycle is due one interval after the agent goes quiet', () => {
  assert.deepEqual(nextCycle(goal, facts), { at: 31_000, waitingFor: null })
})

test('queued messages come first', () => {
  assert.deepEqual(nextCycle(goal, { ...facts, hasQueuedDeliveries: true }), { at: null, waitingFor: null })
})

test('a plan used past what cycles may take holds them until its window resets', () => {
  const planHold = { kind: 'plan_usage', windowMinutes: 300, usedFraction: 0.52, resetsAt: 900_000 } as const
  assert.deepEqual(nextCycle(goal, { ...facts, planHold }), { at: 900_000, waitingFor: planHold })
})

test('failed cycles back off, up to thirty minutes', () => {
  let failing = goal
  for (let failures = 1; failures <= 12; failures++) {
    failing = endCycle(startCycle(failing, `m${failures}`), { interrupted: false, attempts: 2 }, 5000)
    const next = nextCycle(failing, facts)
    assert.equal(next.waitingFor?.kind, 'backoff')
    assert.ok(next.at! - 5000 <= MAX_GOAL_BACKOFF_MS)
  }
  assert.equal(nextCycle(failing, facts).at, 5000 + MAX_GOAL_BACKOFF_MS)
  const recovered = endCycle(startCycle(failing, 'ok'), { interrupted: false, attempts: 1 }, 9000)
  assert.equal(recovered.consecutiveFailedCycles, 0)
})

test('an interrupt pauses cycles until the next real message', () => {
  const interrupted = noteInterrupt(goal)
  assert.deepEqual(nextCycle(interrupted, facts), { at: null, waitingFor: { kind: 'next_message_after_interrupt' } })
  assert.equal(nextCycle(noteRealMessage(interrupted), facts).at, 31_000)
})

test('a deliberately stopped agent takes no cycles', () => {
  const stopped: AgentState = { state: 'stopped', since: 1, stopped: { reason: 'deliberate', by: 'human' } }
  assert.deepEqual(nextCycle(goal, { ...facts, agentState: stopped }), { at: null, waitingFor: { kind: 'agent_unavailable' } })
})

test('open-ended goals refuse done, and checked ones need their check', () => {
  const openEnded = { ...goal, kind: { kind: 'open_ended' as const } }
  assert.throws(() => completeGoal(openEnded, 'x', { kind: 'not_needed' }, 1), GoalRefusal)
  const checked = { ...goal, kind: { kind: 'checked' as const, checkCommand: 'npm test' } }
  assert.throws(() => completeGoal(checked, 'x', { kind: 'failed', output: '1 failing' }, 1), /1 failing/)
  assert.equal(completeGoal(checked, 'x', { kind: 'passed' }, 1).progress.status, 'complete')
})

test('pause, resume, complete and reopen', () => {
  const paused = pauseGoal(goal, 'human', 'lunch', 5)
  assert.throws(() => pauseGoal(paused, 'human', null, 6), GoalRefusal)
  const complete = completeGoal(resumeGoal(paused), 'shipped', { kind: 'not_needed' }, 7)
  assert.equal(reopenGoal(complete).progress.status, 'active')
})

test('intervals are five seconds to seven days', () => {
  assert.throws(() => validateInterval(4), GoalRefusal)
  assert.throws(() => validateInterval(8 * 86_400), GoalRefusal)
  assert.equal(validateInterval(60), 60)
  assert.equal(validateInterval(null), null)
})
