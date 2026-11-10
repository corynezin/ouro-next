import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseUpdateOf, continueDecision, takeRefusal } from './base-update.ts'
import type { BaseUpdateRecord } from './base-update.ts'

const offer = { n: 3, notes: 'faster summaries' }

test('only the offered base is taken, and only when no update is under way or waiting', () => {
  assert.equal(takeRefusal({ state: 'idle' }, offer, 3), null)
  assert.equal(takeRefusal({ state: 'failed', n: 3, why: 'build' }, offer, 3), null, 'a failed update can be taken again')
  assert.equal(takeRefusal({ state: 'idle' }, offer, 2)?.code, 'base_not_offered')
  assert.equal(takeRefusal({ state: 'idle' }, null, 3)?.code, 'base_not_offered')
  assert.equal(takeRefusal({ state: 'merging', n: 3 }, offer, 3)?.code, 'base_update_in_progress')
  assert.equal(takeRefusal({ state: 'deploying', n: 3, deploymentId: 'd', commit: 'c' }, offer, 3)?.code, 'base_update_in_progress')
  assert.equal(takeRefusal({ state: 'conflict', n: 3, files: ['a'] }, offer, 3)?.code, 'base_update_in_progress')
})

test('an update continues only from a conflict whose merge is resolved and committed', () => {
  const conflict: BaseUpdateRecord = { state: 'conflict', n: 3, files: ['a'] }
  assert.deepEqual(continueDecision(conflict, () => null), { kind: 'continues', n: 3 })
  assert.deepEqual(continueDecision(conflict, () => 'a still conflicts'), { kind: 'refused', refusal: { code: 'base_conflict_unresolved', message: 'a still conflicts' } })
  assert.equal(continueDecision({ state: 'idle' }, () => null).kind, 'refused')
})

test('merging and deploying both show as updating', () => {
  assert.deepEqual(baseUpdateOf({ state: 'merging', n: 4 }), { state: 'updating', n: 4 })
  assert.deepEqual(baseUpdateOf({ state: 'deploying', n: 4, deploymentId: 'd', commit: 'c' }), { state: 'updating', n: 4 })
  assert.deepEqual(baseUpdateOf({ state: 'conflict', n: 4, files: ['x'] }), { state: 'conflict', n: 4, files: ['x'] })
})
