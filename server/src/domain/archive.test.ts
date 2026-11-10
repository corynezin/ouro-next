import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoArchiveDue } from './archive.ts'
import type { ArchiveFacts } from './archive.ts'

const HOUR = 3_600_000
const quietDone: ArchiveFacts = {
  state: { state: 'done', since: 0, summary: 'finished' }, lastActivityAt: 0, goalStillGoing: false, runningHelpers: 0, queuedDeliveries: 0, openAsks: 0, unreadByCreator: 0,
}

test('a finished agent quiet for the set hours is archived; off, or quiet for less, it is not', () => {
  assert.equal(autoArchiveDue(quietDone, 24 * HOUR, 24), true)
  assert.equal(autoArchiveDue(quietDone, 24 * HOUR - 1, 24), false)
  assert.equal(autoArchiveDue(quietDone, 1000 * HOUR, null), false)
  assert.equal(autoArchiveDue({ ...quietDone, lastActivityAt: 2 * HOUR }, 25 * HOUR, 24), false, 'quiet counts from its last activity')
})

test('only a finished agent, and never one something still depends on', () => {
  const later = 100 * HOUR
  assert.equal(autoArchiveDue({ ...quietDone, state: { state: 'stopped', since: 0, stopped: { reason: 'idle' } } }, later, 24), false)
  assert.equal(autoArchiveDue({ ...quietDone, goalStillGoing: true }, later, 24), false)
  assert.equal(autoArchiveDue({ ...quietDone, runningHelpers: 1 }, later, 24), false)
  assert.equal(autoArchiveDue({ ...quietDone, queuedDeliveries: 1 }, later, 24), false)
  assert.equal(autoArchiveDue({ ...quietDone, openAsks: 1 }, later, 24), false)
  assert.equal(autoArchiveDue({ ...quietDone, unreadByCreator: 1 }, later, 24), false)
})
