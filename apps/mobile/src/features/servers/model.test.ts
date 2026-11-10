import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostedServer } from '@ouro/contract'
import { checkingNote, createFailureText, hostedRows, newServerLabelOf, renamedLabel, serverRows } from './model.ts'

const server = (id: string, personName: string | null = null) => ({ id, label: `L${id}`, url: `https://${id}`, deviceName: 'mac', deviceId: 'd', personName, hostedServerId: null })

test('rows mark the active server, which cannot be removed from here', () => {
  const rows = serverRows([server('a', 'ada'), server('b')], 'a', { counts: new Map(), checking: false })
  assert.deepEqual(rows.map((r) => [r.id, r.isActive, r.canRemove, r.personText]), [['a', true, false, 'You: ada'], ['b', false, true, null]])
})

test('a rename that is blank or unchanged does nothing', () => {
  assert.equal(renamedLabel('  ', 'Home'), null)
  assert.equal(renamedLabel(' Home ', 'Home'), null)
  assert.equal(renamedLabel(' Work ', 'Home'), 'Work')
})

test('other servers show their unread as a badge, a spinner while a check has nothing for them yet, and the total below', () => {
  const unread = { counts: new Map([['a', 9], ['b', 2], ['c', 0]]), checking: true }
  const rows = serverRows([server('a'), server('b'), server('c')], 'a', unread)
  assert.deepEqual(rows.map((r) => [r.id, r.unreadBadge, r.checking]), [['a', null, false], ['b', 2, false], ['c', null, true]])
  assert.equal(checkingNote(rows, true), 'Checking other servers (2 unread)…', "the open server's count is not in it")
  assert.equal(checkingNote(serverRows([server('b')], 'a', { counts: new Map(), checking: true }), true), 'Checking other servers…')
  assert.equal(checkingNote(rows, false), null)
})

const hosted = (id: string, status: HostedServer['status']): HostedServer => ({ id, label: `H${id}`, createdAt: 1, primary: false, status })

test("the account's servers not on this phone: by hosted id, or by address for one paired before ids were kept", () => {
  const saved = [{ ...server('a'), hostedServerId: 'h1' }, { ...server('b'), url: 'https://b.example/' }]
  const rows = hostedRows([
    hosted('h1', { state: 'ready', address: 'https://a', pairing: null }),
    hosted('h2', { state: 'ready', address: 'https://b.example', pairing: null }),
    hosted('h3', { state: 'ready', address: 'https://c', pairing: { code: 'x', expiresAt: 1 } }),
    hosted('h4', { state: 'failed', why: 'The disk is full.' }),
    hosted('h5', { state: 'failed', why: '' }),
    hosted('h6', { state: 'provisioning', step: 'install' }),
  ], saved)
  assert.deepEqual(rows.map((row) => [row.id, row.detail]), [
    ['h3', 'Ready — tap to connect'], ['h4', 'Error: The disk is full.'], ['h5', 'Error: unknown'], ['h6', 'Installing tools…'],
  ])
})

test('a new server needs a short, printable name', () => {
  assert.equal(newServerLabelOf('   '), null)
  assert.deepEqual(newServerLabelOf(' Work '), { label: 'Work' })
  assert.deepEqual(newServerLabelOf('x'.repeat(41)), { error: 'Name too long (max 40 characters).' })
  assert.deepEqual(newServerLabelOf('a\tb'), { error: 'Name contains invalid characters.' })
  assert.equal(createFailureText({ kind: 'refused', code: 'invalid_request', message: 'Give the server a name.', retryable: false }), 'Give the server a name.')
  assert.equal(createFailureText({ kind: 'invalid_answer', status: 500 }), 'Could not create the server.')
})
