import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageOf, snapshotOf } from '../testSupport.ts'
import { EntityStore, mergeBySeq } from './entityStore.ts'
import { ServerSentDataParser } from './syncEngine.ts'

test('frames split across chunks reassemble; comments and other fields are ignored', () => {
  const parser = new ServerSentDataParser()
  assert.deepEqual(parser.push(': keepalive\n\nid: 3\nda'), [])
  assert.deepEqual(parser.push('ta: {"a":1}\n'), [])
  assert.deepEqual(parser.push('\ndata: {"b":2}\n\ndata: {"c"'), ['{"a":1}', '{"b":2}'])
  assert.deepEqual(parser.push(':3}\n\n'), ['{"c":3}'])
})

test('a timeline merge keeps order and takes the newer copy of a message', () => {
  const a = messageOf({ seq: 1, chatId: 'c', text: 'old' })
  const b = messageOf({ seq: 3, chatId: 'c' })
  const merged = mergeBySeq([a, b], [messageOf({ seq: 2, chatId: 'c' }), messageOf({ seq: 1, chatId: 'c', text: 'new' })])
  assert.deepEqual(merged.map((m) => m.seq), [1, 2, 3])
  assert.equal(merged[0]!.text, 'new')
})

test('a latest page that does not join what is loaded replaces it, keeping its own hasOlder', () => {
  const store = new EntityStore()
  store.applyHistoryPage('c', { messages: [messageOf({ seq: 1, chatId: 'c' })], hasOlder: false }, 'latest')
  store.applyHistoryPage('c', { messages: [messageOf({ seq: 90, chatId: 'c' })], hasOlder: true }, 'latest')
  const timeline = store.timeline('c')!
  assert.deepEqual(timeline.messages.map((m) => m.seq), [90])
  assert.equal(timeline.hasOlder, true)
})

test('a latest page that joins what is loaded keeps the older messages and paging state', () => {
  const store = new EntityStore()
  store.applyHistoryPage('c', { messages: [messageOf({ seq: 1, chatId: 'c' }), messageOf({ seq: 2, chatId: 'c' })], hasOlder: false }, 'latest')
  store.applyHistoryPage('c', { messages: [messageOf({ seq: 2, chatId: 'c' }), messageOf({ seq: 3, chatId: 'c' })], hasOlder: true }, 'latest')
  const timeline = store.timeline('c')!
  assert.deepEqual(timeline.messages.map((m) => m.seq), [1, 2, 3])
  assert.equal(timeline.hasOlder, false)
})

test('listeners hear about a burst of changes once, on the next microtask', async () => {
  const store = new EntityStore()
  let notified = 0
  store.subscribe(() => { notified++ })
  store.applyHistoryPage('c', { messages: [], hasOlder: false }, 'latest')
  store.applyHistoryPage('d', { messages: [], hasOlder: false }, 'latest')
  assert.equal(notified, 0)
  await Promise.resolve()
  assert.equal(notified, 1)
})

test('entities are replaced, never edited, so selectors can compare by identity', () => {
  const store = new EntityStore()
  store.applyHistoryPage('c', { messages: [messageOf({ seq: 1, chatId: 'c' })], hasOlder: false }, 'latest')
  const before = store.timeline('c')!
  store.applyHistoryPage('other', { messages: [], hasOlder: false }, 'latest')
  assert.equal(store.timeline('c'), before)
  store.putMessageIfAbsent(messageOf({ seq: 2, chatId: 'c' }))
  assert.notEqual(store.timeline('c'), before)
})

test('the notification settings shown are the viewer’s own', () => {
  const store = new EntityStore()
  const beforeSnapshot = store.notificationSettings
  assert.equal(beforeSnapshot, undefined)
  store.applySnapshot(snapshotOf({}))
  assert.equal(store.notificationSettings?.id, store.viewer?.personId)
  store.applyChange({ cursor: 1, entity: 'notification_settings', id: 'p1', op: 'upsert', value: { ...store.notificationSettings!, mode: 'nothing' } })
  assert.equal(store.notificationSettings?.mode, 'nothing')
})
