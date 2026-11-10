import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentState } from '@ouro/contract'
import { agentKeepsHostAwake, HOLD_RELEASE_GRACE_MS, HOLD_RENEW_MS, helloToSleeperDue, hostHoldStep, PEER_AWAKE_WITHIN_MS, SLEEPING_PEER_VISIT_MS } from './host-hold.ts'

const idle: AgentState = { state: 'idle', since: 0, generation: 1 }
const inTurn: AgentState = { state: 'in_turn', since: 0, generation: 1, turnId: 't', activity: { kind: 'thinking' }, lastOutputAt: 0, afterTurn: null }
const held: AgentState = { state: 'held', since: 0, hold: 'credits', retryAt: 10 }
const archived: AgentState = { state: 'archived', since: 0 }

test('a turn keeps the host awake; a resting agent does only with a message that wakes it waiting', () => {
  assert.equal(agentKeepsHostAwake(inTurn, false), true)
  assert.equal(agentKeepsHostAwake(idle, false), false)
  assert.equal(agentKeepsHostAwake(idle, true), true)
})

test('a stopped agent keeps the host awake only while a crash backoff will bring it back by itself', () => {
  const crashed = (relaunch: Extract<AgentState, { state: 'stopped' }>['stopped'] & { reason: 'crash' }): AgentState => ({ state: 'stopped', since: 0, stopped: relaunch })
  assert.equal(agentKeepsHostAwake(crashed({ reason: 'crash', consecutiveCrashes: 1, relaunch: { kind: 'at', at: 10 } }), true), true)
  assert.equal(agentKeepsHostAwake(crashed({ reason: 'crash', consecutiveCrashes: 5, relaunch: { kind: 'gave_up', why: 'crash loop' } }), true), false, 'waiting messages wait for a new one')
  assert.equal(agentKeepsHostAwake(crashed({ reason: 'crash', consecutiveCrashes: 1, relaunch: { kind: 'on_message' } }), false), false)
  assert.equal(agentKeepsHostAwake({ state: 'stopped', since: 0, stopped: { reason: 'deliberate', by: 'human' } }, true), false)
})

test('a held or archived agent never keeps the host awake, whatever waits for it', () => {
  assert.equal(agentKeepsHostAwake(held, true), false)
  assert.equal(agentKeepsHostAwake(archived, true), false)
})

test('work takes a hold, and renews it once it is due', () => {
  assert.equal(hostHoldStep({ held: false }, true, 0, 0), 'hold')
  assert.equal(hostHoldStep({ held: true, heldAt: 0 }, true, 0, HOLD_RENEW_MS - 1), 'none')
  assert.equal(hostHoldStep({ held: true, heldAt: 0 }, true, 0, HOLD_RENEW_MS), 'hold')
})

test('without work, the hold is let go only after the grace since the last work', () => {
  assert.equal(hostHoldStep({ held: true, heldAt: 0 }, false, 1_000, 1_000 + HOLD_RELEASE_GRACE_MS - 1), 'none')
  assert.equal(hostHoldStep({ held: true, heldAt: 0 }, false, 1_000, 1_000 + HOLD_RELEASE_GRACE_MS), 'release')
  assert.equal(hostHoldStep({ held: false }, false, 0, HOLD_RELEASE_GRACE_MS * 2), 'none')
})

test('a sleeping machine is greeted while it holds itself awake and has just said hello', () => {
  const now = 100_000
  assert.equal(helloToSleeperDue({ lastHelloFromAt: now - 1_000, heldAwake: true, lastVisitAt: null }, false, now), 'hello')
  assert.equal(helloToSleeperDue({ lastHelloFromAt: now - PEER_AWAKE_WITHIN_MS, heldAwake: true, lastVisitAt: null }, false, now), 'none')
  assert.equal(helloToSleeperDue({ lastHelloFromAt: now - 1_000, heldAwake: false, lastVisitAt: null }, false, now), 'none')
})

test('otherwise it is visited, rarely, and only while this machine is in use', () => {
  const now = 100_000
  const asleep = { lastHelloFromAt: null, heldAwake: false }
  assert.equal(helloToSleeperDue({ ...asleep, lastVisitAt: null }, true, now), 'visit')
  assert.equal(helloToSleeperDue({ ...asleep, lastVisitAt: now - SLEEPING_PEER_VISIT_MS + 1 }, true, now), 'none')
  assert.equal(helloToSleeperDue({ ...asleep, lastVisitAt: now - SLEEPING_PEER_VISIT_MS }, true, now), 'visit')
  assert.equal(helloToSleeperDue({ ...asleep, lastVisitAt: null }, false, now), 'none')
})
