import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatEntity, PersonEntity, SearchHit } from '@ouro/contract'
import { EntityStore } from '../../core/session/entityStore.ts'
import { directChatOf, snapshotOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { chatSearchModel, markWords, searchFor } from './search.ts'
import type { MessageSearch, SearchRow } from './search.ts'

const NOW = 10_000_000
const person = (name: string, address: string): PersonEntity => ({ id: name, name, address, isOwner: false, joinedAt: 1 })
const group = (id: string, members: string[], title: string | null): ChatEntity => ({
  id, kind: 'group', title, members: members.map((address) => ({ address, joinedAt: 1 })), createdBy: VIEWER_ADDRESS, createdAt: 5, homeMachine: 'alpha', latestMessage: null,
})
const hit = (chatId: string, messageId: string, excerpt: string, from = 'fixer'): SearchHit => ({ chatId, messageId, seq: 3, at: NOW - 60_000, from, excerpt, match: '' })
const found = (hits: SearchHit[], more = false): MessageSearch => ({ kind: 'found', page: { hits, more } })

function store() {
  const entities = new EntityStore()
  entities.applySnapshot(snapshotOf({
    people: [person('Sam', 'human@sam')],
    chats: [
      directChatOf('d1', 'fixer'),
      group('g1', [VIEWER_ADDRESS, 'fixer'], 'Launch plan'),
      group('g2', ['human@sam', 'fixer'], 'Launch party'),
    ],
  }))
  return entities
}

const titles = (rows: SearchRow[]) => rows.map((row) => (row.kind === 'chat' ? row.chat.title : `${row.hit.title}: ${row.hit.excerpt.map((part) => part.text).join('')}`))

test('chats by every word of their name, yours first; then messages in your chats, then in others', () => {
  const model = chatSearchModel(store(), 'LAUNCH', found([hit('g2', 'm2', 'the launch party'), hit('d1', 'm1', 'launch at noon'), hit('gone', 'm3', 'launch?', 'human@sam')]), NOW)
  assert.deepEqual(model.sections.map((section) => section.title), ['Chats', 'In your chats', 'In other chats'])
  assert.deepEqual(titles(model.sections[0]!.rows), ['Launch plan', 'Launch party'])
  assert.deepEqual(titles(model.sections[1]!.rows), ['fixer: launch at noon'])
  assert.deepEqual(titles(model.sections[2]!.rows), ['Launch party: the launch party', 'A new chat: launch?'])
  const unknown = model.sections[2]!.rows[1]!
  assert.equal(unknown.kind === 'hit' && unknown.hit.senderText, 'Sam')
  assert.equal(unknown.kind === 'hit' && unknown.hit.kind, null)
  assert.equal(model.noteText, 'Archived agents’ direct chats aren’t searched.')
  assert.deepEqual(chatSearchModel(store(), 'launch plan', found([]), NOW).sections.map((section) => titles(section.rows)), [['Launch plan']])
})

test('the note: searching, failed, nothing, and only the newest', () => {
  assert.equal(chatSearchModel(store(), 'launch', { kind: 'searching' }, NOW).noteText, 'Searching messages…')
  assert.equal(chatSearchModel(store(), 'zzz', { kind: 'failed', reason: 'offline' }, NOW).noteText, 'Couldn’t search messages: offline')
  assert.equal(chatSearchModel(store(), ' zzz ', found([]), NOW).noteText, 'Nothing matches “zzz”.\n\nArchived agents’ direct chats aren’t searched.')
  assert.equal(chatSearchModel(store(), 'zzz', found([], true), NOW).noteText, 'Nothing matches “zzz”.\n\nThese are the newest matches. More words narrow it down.\n\nArchived agents’ direct chats aren’t searched.')
})

test('the words are marked in any case, longest first, and nothing else', () => {
  assert.deepEqual(markWords('École and ecole', 'ÉCOLE'), [{ text: 'École', marked: true }, { text: ' and ecole', marked: false }])
  assert.deepEqual(markWords('a deploy, deployed', 'deploy deployed'), [
    { text: 'a ', marked: false }, { text: 'deploy', marked: true }, { text: ', ', marked: false }, { text: 'deployed', marked: true },
  ])
  assert.deepEqual(markWords('cost (1+1)?', '(1+1)?'), [{ text: 'cost ', marked: false }, { text: '(1+1)?', marked: true }])
  assert.deepEqual(markWords('plain', '  '), [{ text: 'plain', marked: false }])
})

test('an answer for an older query is ignored: still searching until the typed one answers (ROOMS-16)', () => {
  const failed = { kind: 'failed', reason: 'busy' } as const
  assert.deepEqual(searchFor('deploy', { query: 'dep', search: failed }), { kind: 'searching' })
  assert.deepEqual(searchFor('deploy', { query: 'deploy', search: failed }), failed)
  assert.deepEqual(searchFor('deploy', null), { kind: 'searching' })
})
