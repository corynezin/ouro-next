import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEntity, ComputerEntity, PersonEntity, RemoteAgentEntity } from '@ouro/contract'
import { EntityStore } from '../../core/session/entityStore.ts'
import { agentOf, directChatOf, readStateOf, snapshotOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { addMembersInTurn, agentsElsewhereChoices, chatDestination, chatPreview, chatsListModel, chatsWithMember, pinTargetOfChat, chatTitle, chosenMembers, memberChoices, memberPickerDoneTitle, mentionOptions, NEW_CHAT_COPY } from './model.ts'

const NOW = 10_000_000
const live = { phase: 'live' as const, detail: '', downSince: null }
const person = (name: string, address: string): PersonEntity => ({ id: name, name, address, isOwner: false, joinedAt: 1 })
const group = (id: string, members: string[], title: string | null = 'Team', latest: ChatEntity['latestMessage'] = null): ChatEntity => ({
  id, kind: 'group', title, members: members.map((address) => ({ address, joinedAt: 1 })), createdBy: VIEWER_ADDRESS, createdAt: 5, homeMachine: 'alpha', latestMessage: latest,
})
function storeWith(partial: Parameters<typeof snapshotOf>[0]) {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf(partial))
  return store
}

test('titles: the name; your direct chat by the other side; else everyone, & for direct', () => {
  const people = [person('Sam Lee', 'human@sam')]
  const store = storeWith({ people })
  assert.equal(chatTitle(store, group('g', [VIEWER_ADDRESS, 'fixer'])), 'Team')
  assert.equal(chatTitle(store, group('g', [VIEWER_ADDRESS, 'fixer', 'human@sam'], null)), 'You, fixer, Sam Lee')
  assert.equal(chatTitle(store, directChatOf('d', 'fixer')), 'fixer')
  const theirs = { ...directChatOf('d', 'fixer'), members: [{ address: 'human@sam', joinedAt: 1 }, { address: 'fixer', joinedAt: 1 }] }
  assert.equal(chatTitle(store, theirs), 'Sam Lee & fixer')
})

test('previews: a group says who; your direct chat marks yours; others\' direct chats show none', () => {
  const store = storeWith({ people: [person('Sam', 'human@sam')] })
  const latest = (from: string) => ({ seq: 1, from, at: 9, text: 'hello' })
  assert.equal(chatPreview(store, group('g', [VIEWER_ADDRESS, 'human@sam'], 'T', latest('human@sam'))), 'Sam: hello')
  assert.equal(chatPreview(store, { ...directChatOf('d', 'fixer'), latestMessage: latest(VIEWER_ADDRESS) }), 'you: hello')
  assert.equal(chatPreview(store, { ...directChatOf('d', 'fixer'), latestMessage: latest('fixer') }), 'hello')
  const theirs = { ...directChatOf('d', 'fixer'), members: [{ address: 'human@sam', joinedAt: 1 }, { address: 'fixer', joinedAt: 1 }], latestMessage: latest('fixer') }
  assert.equal(chatPreview(store, theirs), null)
})

test('pinned chats lead in pin order: a pinned group, and your direct chat with a pinned agent; long-press pins what it shows', () => {
  const team = group('team', [VIEWER_ADDRESS, 'a'], 'Team')
  const newest = group('newest', [VIEWER_ADDRESS, 'a'], 'Newest', { seq: 1, from: 'a', at: 90, text: 'x' })
  const withFixer = directChatOf('d', 'fixer')
  const store = storeWith({
    agents: [agentOf({ id: 'f', name: 'fixer' })],
    chats: [team, newest, withFixer],
    pins: [{ id: 'p1', target: { kind: 'agent', agentId: 'f' }, position: 0, pinnedAt: 0 }, { id: 'p2', target: { kind: 'chat', chatId: 'team' }, position: 1, pinnedAt: 0 }],
  })
  const model = chatsListModel(store, live, NOW)
  assert.deepEqual(model.mine.map((r) => [r.chatId, r.pinned]), [['d', true], ['team', true], ['newest', false]])
  assert.deepEqual(pinTargetOfChat(store, withFixer), { kind: 'agent', agentId: 'f' })
  assert.deepEqual(pinTargetOfChat(store, team), { kind: 'chat', chatId: 'team' })
  assert.deepEqual(pinTargetOfChat(store, directChatOf('r', 'bob@mac')), { kind: 'remote_agent', address: 'bob@mac' })
})

test('yours latest first, then others; unread from the read state; empty text by situation', () => {
  const mineOld = group('old', [VIEWER_ADDRESS, 'a'], 'Old')
  const mineNew = group('new', [VIEWER_ADDRESS, 'a'], 'New', { seq: 1, from: 'a', at: 50, text: 'x' })
  const theirs = group('theirs', ['human@sam', 'a'], 'Theirs')
  const store = storeWith({ chats: [mineOld, mineNew, theirs], readStates: [readStateOf('new', 0, 4)] })
  const model = chatsListModel(store, live, NOW)
  assert.deepEqual(model.mine.map((r) => r.chatId), ['new', 'old'])
  assert.deepEqual(model.others.map((r) => r.chatId), ['theirs'])
  assert.equal(model.mine[0]!.unread, 4)
  assert.equal(model.emptyText, null)
  assert.equal(chatsListModel(storeWith({ chats: [theirs] }), live, NOW).emptyText, 'You aren’t in any chats yet.')
  assert.equal(chatsListModel(storeWith({}), live, NOW).emptyText, 'No chats yet.')
  assert.equal(chatsListModel(storeWith({}), { phase: 'connecting', detail: '', downSince: NOW }, NOW).emptyText, 'Connecting…')
})

test('your direct chat with an agent opens its conversation; everything else the room', () => {
  const store = storeWith({ agents: [agentOf({ id: 'a1', name: 'fixer' })] })
  assert.deepEqual(chatDestination(store, directChatOf('d', 'fixer')), { screen: 'Chat', agentRef: 'a1' })
  assert.deepEqual(chatDestination(store, group('g', [VIEWER_ADDRESS, 'fixer'])), { screen: 'ChatRoom', chatId: 'g' })
  assert.deepEqual(chatDestination(store, directChatOf('d', 'gone')), { screen: 'ChatRoom', chatId: 'd' }, 'no such agent here')
})

test('mentions: people by name or their address name, agents bare unless two share it, never yourself', () => {
  const store = storeWith({ people: [person('Sam Lee', 'human@sam'), person('Kim', 'human@kim')] })
  const chat = group('g', [VIEWER_ADDRESS, 'human@sam', 'human@kim', 'fixer@alpha', 'fixer@beta', 'ios'])
  assert.deepEqual(mentionOptions(store, chat), [
    { label: 'Sam Lee', insert: 'sam' },
    { label: 'Kim', insert: 'Kim' },
    { label: 'fixer@alpha', insert: 'fixer@alpha' },
    { label: 'fixer@beta', insert: 'fixer@beta' },
    { label: 'ios', insert: 'ios' },
  ])
})

test('member choices: people and agents here, less you, the members and archived agents, found accent-insensitively', () => {
  const store = storeWith({
    people: [person('Zoë', 'human@zoe'), person('Ana', 'human@ana'), { ...person('Me', VIEWER_ADDRESS) }],
    agents: [agentOf({ id: 'a1', name: 'fixer' }), agentOf({ id: 'a2', name: 'builder' }), agentOf({ id: 'a3', name: 'old', state: { state: 'archived', since: 1 } })],
  })
  assert.deepEqual(memberChoices(store, null, ''), {
    people: [{ address: 'human@ana', label: 'Ana' }, { address: 'human@zoe', label: 'Zoë' }],
    agents: [{ address: 'builder', label: 'builder' }, { address: 'fixer', label: 'fixer' }],
  })
  const chat = group('g', [VIEWER_ADDRESS, 'fixer', 'human@ana'])
  assert.deepEqual(memberChoices(store, chat, ''), { people: [{ address: 'human@zoe', label: 'Zoë' }], agents: [{ address: 'builder', label: 'builder' }] })
  assert.deepEqual(memberChoices(store, null, ' zoe ').people.map((c) => c.label), ['Zoë'])
  assert.deepEqual(memberChoices(store, null, 'zoe').agents, [])
})

test('the members chosen are the toggled ones and the typed address, each once', () => {
  assert.deepEqual(chosenMembers(['fixer'], '  human@sam '), ['fixer', 'human@sam'])
  assert.deepEqual(chosenMembers(['fixer'], 'fixer'), ['fixer'])
  assert.deepEqual(chosenMembers([], '   '), [])
})

test('a member’s chats, latest first, by their titles', () => {
  const store = storeWith({ chats: [group('g1', [VIEWER_ADDRESS, 'fixer'], 'Old'), group('g2', [VIEWER_ADDRESS, 'fixer'], 'New', { seq: 1, from: 'fixer', at: 50, text: 'x' }), group('g3', [VIEWER_ADDRESS], 'Other')] })
  assert.deepEqual(chatsWithMember(store, 'fixer'), [{ chatId: 'g2', title: 'New' }, { chatId: 'g1', title: 'Old' }])
})

test("agents on other computers: a section per computer by name, each agent by its bare name, alphabetical (NCHAT-05)", () => {
  const computers = new Map([['c1', { id: 'c1', name: 'mac' } as ComputerEntity], ['c2', { id: 'c2', name: 'beta' } as ComputerEntity]])
  const remote = (name: string, computerId: string, computerName: string) => ({ id: `${computerId}:${name}`, computerId, name, address: `${name}@${computerName}`, activity: 'waiting', details: null, refreshedAt: 1 }) as RemoteAgentEntity
  const agents = [remote('zed', 'c1', 'mac'), remote('amy', 'c1', 'mac'), remote('bob', 'c2', 'beta'), remote('lost', 'c9', 'gone')]
  assert.deepEqual(agentsElsewhereChoices(agents, computers, null, ''), [
    { computerName: 'beta', agents: [{ address: 'bob@beta', label: 'bob' }] },
    { computerName: 'mac', agents: [{ address: 'amy@mac', label: 'amy' }, { address: 'zed@mac', label: 'zed' }] },
  ])
  assert.deepEqual(agentsElsewhereChoices(agents, computers, group('g', ['amy@mac']), '').map((section) => section.agents.map((agent) => agent.label)), [['bob'], ['zed']], 'members left out')
  assert.deepEqual(agentsElsewhereChoices(agents, computers, null, ' ZED ').map((section) => section.computerName), ['mac'], 'found by name')
})

test("the sheet's done button and footer (NCHAT-01, NCHAT-04)", () => {
  assert.deepEqual([memberPickerDoneTitle(false, false), memberPickerDoneTitle(false, true), memberPickerDoneTitle(true, false), memberPickerDoneTitle(true, true)], ['Create', 'Creating…', 'Add', 'Adding…'])
  assert.equal(NEW_CHAT_COPY.notListedFooter, 'Someone not listed? Type them as human@server, or an agent as name@server.')
})

test('adding members goes one by one and stops at the first refusal, said as "member: reason" (NCHAT-06)', async () => {
  const asked: string[] = []
  const add = async (address: string) => { asked.push(address); return address === 'bob' ? 'not a member of this computer' : null }
  const label = (address: string) => address.toUpperCase()
  assert.equal(await addMembersInTurn(['ann', 'bob', 'cy'], add, label), 'BOB: not a member of this computer')
  assert.deepEqual(asked, ['ann', 'bob'], 'nobody after the refusal is asked')
  assert.equal(await addMembersInTurn(['ann'], add, label), null)
})
