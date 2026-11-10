import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EntityStore } from '../core/session/entityStore.ts'
import { agentOf, snapshotOf } from '../core/testSupport.ts'
import { isShowingPushPlace, routeOfPushPlace } from './pushOpening.ts'

const store = new EntityStore()
store.applySnapshot(snapshotOf({ agents: [agentOf({ id: 'a1', name: 'alice' })] }))

test('a push opens the agent chat by id, or the room', () => {
  assert.deepEqual(routeOfPushPlace({ kind: 'agent_chat', agentId: 'a1' }), { name: 'Chat', params: { agentRef: 'a1' } })
  assert.deepEqual(routeOfPushPlace({ kind: 'room', chatId: 'g1' }), { name: 'ChatRoom', params: { chatId: 'g1' } })
})

test('already showing: the chat named either way, or the same room', () => {
  const alice = { kind: 'agent_chat' as const, agentId: 'a1' }
  assert.equal(isShowingPushPlace({ name: 'Chat', params: { agentRef: 'alice' } }, alice, store), true)
  assert.equal(isShowingPushPlace({ name: 'Chat', params: { agentRef: 'a1' } }, alice, store), true)
  assert.equal(isShowingPushPlace({ name: 'Log', params: { agentRef: 'a1' } }, alice, store), false)
  assert.equal(isShowingPushPlace({ name: 'Agents' }, alice, store), false)
  assert.equal(isShowingPushPlace({ name: 'ChatRoom', params: { chatId: 'g1' } }, { kind: 'room', chatId: 'g1' }, store), true)
  assert.equal(isShowingPushPlace({ name: 'ChatRoom', params: { chatId: 'g2' } }, { kind: 'room', chatId: 'g1' }, store), false)
})
