import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEntity } from '@ouro/contract'
import { EntityStore } from '../../core/session/entityStore.ts'
import { directChatOf, messageOf, snapshotOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { groupSend, homeDeliveryNote, ROOM_COPY, roomFooter, roomHeader, senderLabel } from './model.ts'

const store = new EntityStore()
store.applySnapshot(snapshotOf({ people: [{ id: 'p2', name: 'Sam', address: 'human@sam', isOwner: false, joinedAt: 1 }] }))
const group = (members: string[]): ChatEntity => ({
  id: 'g', kind: 'group', title: 'Team', members: members.map((address) => ({ address, joinedAt: 1 })), createdBy: VIEWER_ADDRESS, createdAt: 1, homeMachine: 'alpha', latestMessage: null,
})

test('the header counts members and says when you are not one', () => {
  assert.deepEqual(roomHeader(store, group([VIEWER_ADDRESS])), { title: 'Team', subtitle: '1 member' })
  assert.deepEqual(roomHeader(store, group(['human@sam', 'fixer'])), { title: 'Team', subtitle: '2 members · you aren’t in it' })
  assert.equal(roomHeader(store, directChatOf('d', 'fixer')).subtitle, 'Direct chat')
})

test('members get a composer; a group you are not in says so; someone else\'s direct chat is read-only', () => {
  assert.deepEqual(roomFooter(store, group([VIEWER_ADDRESS, 'fixer'])), { kind: 'composer', placeholder: 'Message Team' })
  assert.deepEqual(roomFooter(store, group(['fixer'])), { kind: 'members_only' })
  const theirs = { ...directChatOf('d', 'fixer'), members: [{ address: 'human@sam', joinedAt: 1 }, { address: 'fixer', joinedAt: 1 }] }
  assert.deepEqual(roomFooter(store, theirs), { kind: 'reading_others' })
})

test('names over others\' messages only, and a post goes to the chat as text', () => {
  assert.equal(senderLabel(store, VIEWER_ADDRESS), undefined)
  assert.equal(senderLabel(store, 'human@sam'), 'Sam')
  assert.deepEqual(groupSend(group([VIEWER_ADDRESS]), 'hi'), { destination: { kind: 'group', chatId: 'g' }, conversationId: 'g', text: 'hi', attachments: [] })
})

test("your post to a chat whose home is another computer is on its way there until the home has it (ROOM-05)", () => {
  const copy = { ...group([VIEWER_ADDRESS]), homeMachine: 'beta' }
  const mine = (state: 'queued' | 'accepted') => messageOf({ seq: 1, chatId: 'g', from: VIEWER_ADDRESS, remoteDeliveries: [{ recipient: 'team@beta', state: state === 'queued' ? { state, since: 1, attempts: 0 } : { state, at: 2 } }] })
  assert.equal(homeDeliveryNote(store, copy, mine('queued')), '◌ on its way to beta')
  assert.equal(homeDeliveryNote(store, copy, mine('accepted')), null, 'the home has it')
  assert.equal(homeDeliveryNote(store, group([VIEWER_ADDRESS]), mine('queued')), null, 'a chat whose home is here')
  assert.equal(homeDeliveryNote(store, copy, { ...mine('queued'), from: 'human@sam' }), null, "someone else's")
})

test("the room's words: empty, members only, and joining (ROOM-04, ROOM-10)", () => {
  assert.deepEqual(ROOM_COPY, { empty: 'No messages yet.', membersOnly: 'Only members can post here.', readingOthers: 'You’re reading someone else’s chat.', join: 'Join', joining: 'Joining…' })
})
