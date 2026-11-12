import assert from 'node:assert/strict'
import { test } from 'node:test'
import { destroyServerMachine, removeAndUnlink, removeChoiceOf } from './actions.ts'
import type { ServerActionPorts } from './actions.ts'
import type { ServerRow } from './model.ts'

const row = (link: ServerRow['link']): ServerRow => ({ id: 's1', label: 'Work', url: 'https://w.test', personText: null, isActive: false, canRemove: true, link, unreadBadge: null, checking: false })
const linked: ServerRow['link'] = { kind: 'linked', computerId: 'c1', stateText: 'Online', fullTrust: true, incompatibility: null }

function ports(options: { deleteFails?: string; unlinkFails?: boolean } = {}) {
  const calls: string[] = []
  const fake: ServerActionPorts = {
    deleteMachine: async (id) => { calls.push(`delete ${id}`); return options.deleteFails ?? null },
    unlinkComputer: async (id) => { calls.push(`unlink ${id}`); return !options.unlinkFails },
    forget: async (id) => { calls.push(`forget ${id}`) },
  }
  return { calls, fake }
}

test('Remove offers to unlink only to the owner, and only for a linked server', () => {
  assert.deepEqual(removeChoiceOf(row(linked), true), { kind: 'forget_or_unlink', computerId: 'c1' })
  assert.deepEqual(removeChoiceOf(row(linked), false), { kind: 'forget_only' })
  assert.deepEqual(removeChoiceOf(row({ kind: 'not_linked' }), true), { kind: 'forget_only' })
})

test('Remove and unlink forgets the server only once it is unlinked', async () => {
  const ok = ports()
  assert.deepEqual(await removeAndUnlink(ok.fake, row(linked), 'c1'), { kind: 'done' })
  assert.deepEqual(ok.calls, ['unlink c1', 'forget s1'])
  const failing = ports({ unlinkFails: true })
  assert.deepEqual(await removeAndUnlink(failing.fake, row(linked), 'c1'), { kind: 'kept' })
  assert.deepEqual(failing.calls, ['unlink c1'])
})

test('Destroy deletes the machine first, then unlinks and forgets; a failed delete leaves the server as it was', async () => {
  const ok = ports({ unlinkFails: true })
  assert.deepEqual(await destroyServerMachine(ok.fake, row(linked), 'm1'), { kind: 'done' })
  assert.deepEqual(ok.calls, ['delete m1', 'unlink c1', 'forget s1'], 'a failed unlink does not keep a destroyed server')
  const unlinked = ports()
  await destroyServerMachine(unlinked.fake, row({ kind: 'not_linked' }), 'm1')
  assert.deepEqual(unlinked.calls, ['delete m1', 'forget s1'])
  const failing = ports({ deleteFails: 'AWS refused' })
  assert.deepEqual(await destroyServerMachine(failing.fake, row(linked), 'm1'), { kind: 'failed', why: 'AWS refused' })
  assert.deepEqual(failing.calls, ['delete m1'])
})
