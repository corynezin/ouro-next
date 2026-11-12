import assert from 'node:assert/strict'
import { test } from 'node:test'
import { starterDecision } from './starter.ts'

const fresh = { settledBefore: false, activeLegacyId: null, archivedLegacy: false }

test('a fresh machine makes a starter agent, once', () => {
  assert.deepEqual(starterDecision(fresh), { kind: 'make' })
  assert.deepEqual(starterDecision({ ...fresh, settledBefore: true }), { kind: 'none' })
})

test('a machine with a master adopts it; one whose master was archived gets none', () => {
  assert.deepEqual(starterDecision({ ...fresh, activeLegacyId: 'm1' }), { kind: 'adopt_legacy', agentId: 'm1' })
  assert.deepEqual(starterDecision({ ...fresh, activeLegacyId: 'm1', archivedLegacy: true }), { kind: 'adopt_legacy', agentId: 'm1' }, 'a live master wins over an older archived one')
  assert.deepEqual(starterDecision({ ...fresh, archivedLegacy: true }), { kind: 'keep_archived' })
})

test('once settled, nothing about a master changes it again', () => {
  assert.deepEqual(starterDecision({ settledBefore: true, activeLegacyId: 'm1', archivedLegacy: true }), { kind: 'none' })
})
