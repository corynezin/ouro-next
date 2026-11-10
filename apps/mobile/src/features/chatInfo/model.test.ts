import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEntity } from '@ouro/contract'
import { EntityStore } from '../../core/session/entityStore.ts'
import { agentOf, directChatOf, snapshotOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { dateTimeOf } from '../../design/format.ts'
import { CHAT_INFO_COPY, chatInfoModel, memberDestination } from './model.ts'

const group = (homeMachine: string): ChatEntity => ({
  id: 'g', kind: 'group', title: 'Team', members: [VIEWER_ADDRESS, 'fixer', 'human@sam'].map((address) => ({ address, joinedAt: 1 })),
  createdBy: 'human@sam', createdAt: 5000, homeMachine, latestMessage: null,
})
function storeWith() {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({
    agents: [agentOf({ id: 'a1', name: 'fixer' })],
    people: [{ id: 'p2', name: 'Sam', address: 'human@sam', isOwner: false, joinedAt: 1 }],
  }))
  return store
}

test('a group: who made it and when, its members, Leave for you and Remove for others, and adding', () => {
  const model = chatInfoModel(storeWith(), group('alpha'))
  assert.deepEqual(model.facts, [`Created by Sam · ${dateTimeOf(5000)}`])
  assert.equal(model.membersTitle, 'Members (3)')
  assert.deepEqual(model.members.map((m) => [m.label, m.isPerson, m.removal?.buttonLabel, m.removal?.confirmTitle, m.removal?.confirmAction]), [
    ['You', true, 'Leave', 'Leave this chat?', 'Leave'],
    ['fixer', false, 'Remove fixer', 'Remove fixer?', 'Remove'],
    ['Sam', true, 'Remove Sam', 'Remove Sam?', 'Remove'],
  ])
  // Both confirmations say the same of what was said (CINFO-04); a chat gone from here says so (CINFO-07).
  assert.equal(CHAT_INFO_COPY.removeMessage, 'What was said stays in the chat.')
  assert.equal(CHAT_INFO_COPY.gone, 'This chat isn’t here any more.')
  assert.equal(model.canAddMembers, true)
})

test('a chat that lives on another machine says so', () => {
  assert.equal(chatInfoModel(storeWith(), group('beta')).facts[1], 'Lives on beta')
})

test('a direct chat keeps its members: no removing, no adding', () => {
  const model = chatInfoModel(storeWith(), directChatOf('d', 'fixer'))
  assert.ok(model.members.every((member) => member.removal === null))
  assert.equal(model.canAddMembers, false)
})

test('an agent here opens its details; a person or an agent elsewhere, the person page', () => {
  const store = storeWith()
  assert.deepEqual(memberDestination(store, 'fixer'), { screen: 'Agent', agentRef: 'a1' })
  assert.deepEqual(memberDestination(store, 'human@sam'), { screen: 'Person', address: 'human@sam' })
  assert.deepEqual(memberDestination(store, 'fixer@beta'), { screen: 'Person', address: 'fixer@beta' })
})
