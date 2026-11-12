import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { chatItems, historyLoadNote, JUMP_COPY, jumpStep, MAX_JUMP_PAGES } from './model.ts'

const itemsOf = (seqs: number[], extra: Parameters<typeof messageOf>[0][] = []) => chatItems({
  messages: [...seqs.map((seq) => messageOf({ seq, chatId: 'c' })), ...extra.map((partial) => messageOf(partial))], outbox: [], viewerAddress: VIEWER_ADDRESS, recipientLastOutputAt: null,
})

test('opening at a message: scroll to it when loaded, else page back while it can still be older', () => {
  const items = itemsOf([10, 11, 12])
  assert.deepEqual(jumpStep(items, { messageId: 'm11', seq: 11 }, true, 0), { kind: 'scroll', index: 1, messageId: 'm11' })
  assert.deepEqual(jumpStep(items, { messageId: 'm4', seq: 4 }, true, 0), { kind: 'load_older' })
  assert.deepEqual(jumpStep(items, { messageId: 'm4', seq: 4 }, true, MAX_JUMP_PAGES), { kind: 'too_far' })
})

test('a message whose place is loaded but which is not there: the nearest at or before it, else the oldest; too far after 25 pages (CHAT-71, CHAT-72)', () => {
  const items = itemsOf([10, 12, 14])
  assert.deepEqual(jumpStep(items, { messageId: 'gone', seq: 13 }, true, 0), { kind: 'scroll', index: 1, messageId: 'm12' })
  assert.deepEqual(jumpStep(items, { messageId: 'gone', seq: 4 }, false, 0), { kind: 'scroll', index: 2, messageId: 'm10' }, 'the start of the chat is loaded')
  assert.deepEqual(jumpStep(itemsOf([]), { messageId: 'gone', seq: 4 }, false, 0), { kind: 'not_here' }, 'no messages at all')
  assert.deepEqual(jumpStep(items, { messageId: 'm4', seq: 4 }, true, MAX_JUMP_PAGES - 1), { kind: 'load_older' })
  assert.deepEqual(jumpStep(items, { messageId: 'm4', seq: 4 }, true, MAX_JUMP_PAGES), { kind: 'too_far' })
  assert.equal(JUMP_COPY.tooFar, 'That message is too far back to jump to.')
})

test("a history page that fails says why in the status bar's note, and one that loads clears it (CHAT-16)", () => {
  assert.equal(historyLoadNote({ ok: false, failure: { kind: 'no_answer', reason: 'reset' } }), "Couldn't reach your Ouro machine. Try again in a few seconds.")
  assert.equal(historyLoadNote({ ok: true, value: undefined }), null)
})
