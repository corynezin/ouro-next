import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseUpdateOf, continueDecision, dropDecision, overtakenBase, resolveDecision, takeRefusal } from './base-update.ts'
import type { BaseUpdateRecord } from './base-update.ts'

const offer = { n: 3, notes: 'faster summaries' }

test('only the offered base is taken, and only when no update is under way or waiting', () => {
  assert.equal(takeRefusal({ state: 'idle' }, offer, 3), null)
  assert.equal(takeRefusal({ state: 'failed', n: 3, why: 'build' }, offer, 3), null, 'a failed update can be taken again')
  assert.equal(takeRefusal({ state: 'idle' }, offer, 2)?.code, 'base_not_offered')
  assert.equal(takeRefusal({ state: 'idle' }, null, 3)?.code, 'base_not_offered')
  assert.equal(takeRefusal({ state: 'merging', n: 3 }, offer, 3)?.code, 'base_update_in_progress')
  assert.equal(takeRefusal({ state: 'deploying', n: 3, deploymentId: 'd', commit: 'c' }, offer, 3)?.code, 'base_update_in_progress')
  assert.equal(takeRefusal({ state: 'conflict', n: 3, files: ['a'], resolver: 'base-3' }, offer, 3)?.code, 'base_update_in_progress')
})

test('an update continues only from a conflict whose merge is resolved and committed', () => {
  const conflict: BaseUpdateRecord = { state: 'conflict', n: 3, files: ['a'], resolver: 'base-3' }
  assert.deepEqual(continueDecision(conflict, () => null), { kind: 'continues', n: 3 })
  assert.deepEqual(continueDecision(conflict, () => 'a still conflicts'), { kind: 'refused', refusal: { code: 'base_conflict_unresolved', message: 'a still conflicts' } })
  assert.equal(continueDecision({ state: 'idle' }, () => null).kind, 'refused')
})

test('merging and deploying both show as updating', () => {
  assert.deepEqual(baseUpdateOf({ state: 'merging', n: 4 }), { state: 'updating', n: 4 })
  assert.deepEqual(baseUpdateOf({ state: 'deploying', n: 4, deploymentId: 'd', commit: 'c' }), { state: 'updating', n: 4 })
  assert.deepEqual(baseUpdateOf({ state: 'conflict', n: 4, files: ['x'], notes: 'n', resolver: null }), { state: 'conflict', n: 4, files: ['x'], resolver: null })
  assert.deepEqual(baseUpdateOf({ state: 'conflict', n: 4, files: ['x'], notes: 'n', resolver: 'base-4' }), { state: 'conflict', n: 4, files: ['x'], resolver: 'base-4' })
  const fromBefore = { state: 'conflict', n: 4, files: ['x'] } as unknown as BaseUpdateRecord
  assert.deepEqual(baseUpdateOf(fromBefore), { state: 'conflict', n: 4, files: ['x'], resolver: null }, 'a record from before resolvers names none: it waits for the owner')
})

test('a conflict waits for the person: an agent is started to merge it, or it is dropped; it is merged only once', () => {
  const waiting: BaseUpdateRecord = { state: 'conflict', n: 3, files: ['a'], notes: 'faster', resolver: null }
  assert.deepEqual(resolveDecision(waiting), { kind: 'goes_ahead', n: 3, files: ['a'], notes: 'faster' })
  assert.deepEqual(dropDecision(waiting), { kind: 'goes_ahead', n: 3, stopping: null })
  assert.match(takeRefusal(waiting, offer, 3)!.message, /ouro base resolve/)
  const resolving: BaseUpdateRecord = { ...waiting, resolver: 'base-3' }
  assert.equal(resolveDecision(resolving).kind, 'refused')
  assert.equal(resolveDecision({ state: 'idle' }).kind, 'refused')
  assert.equal(dropDecision({ state: 'idle' }).kind, 'refused')
})

test('a conflict can be dropped while an agent is resolving it, and that agent is the one told to stop', () => {
  const resolving: BaseUpdateRecord = { state: 'conflict', n: 3, files: ['a'], notes: 'faster', resolver: 'base-3' }
  assert.deepEqual(dropDecision(resolving), { kind: 'goes_ahead', n: 3, stopping: 'base-3' })
  assert.match(takeRefusal(resolving, offer, 3)!.message, /ouro base drop/, 'the refusal names the way out')
})

test('a conflict recorded before the choice existed waits for the owner: it can be resolved or dropped', () => {
  const fromBefore = { state: 'conflict', n: 3, files: ['a'] } as unknown as BaseUpdateRecord
  assert.deepEqual(resolveDecision(fromBefore), { kind: 'goes_ahead', n: 3, files: ['a'], notes: '' })
  assert.deepEqual(dropDecision(fromBefore), { kind: 'goes_ahead', n: 3, stopping: null })
})

test('a failed or unresolved update to a base the source has since taken another way is overtaken; others stand', () => {
  assert.equal(overtakenBase({ state: 'failed', n: 6, why: 'rolled back' }, 6), 6)
  assert.equal(overtakenBase({ state: 'failed', n: 6, why: 'rolled back' }, 7), 6, 'a later base carries it')
  assert.equal(overtakenBase({ state: 'failed', n: 6, why: 'rolled back' }, 5), null, 'still not in: it stands')
  assert.equal(overtakenBase({ state: 'conflict', n: 6, files: ['a'], resolver: null }, 6), 6)
  assert.equal(overtakenBase({ state: 'conflict', n: 6, files: ['a'], resolver: 'base-6' }, 6), null, 'an agent is resolving it')
  assert.equal(overtakenBase({ state: 'deploying', n: 6, deploymentId: 'd', commit: 'c' }, 6), null)
  assert.equal(overtakenBase({ state: 'idle' }, 6), null)
  assert.equal(overtakenBase({ state: 'failed', n: 6, why: 'x' }, null), null)
})
