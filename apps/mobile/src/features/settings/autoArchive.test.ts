import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoArchiveKey, autoArchiveOptions } from './model.ts'

test('auto-archive offers off and a few waits, plus a wait set elsewhere', () => {
  assert.deepEqual(autoArchiveOptions(null).map((option) => option.label), ['Off', 'After 1 hour', 'After 6 hours', 'After 1 day', 'After 3 days', 'After 1 week'])
  assert.deepEqual(autoArchiveOptions(48).map((option) => option.label).slice(3, 5), ['After 1 day', 'After 2 days'])
  assert.deepEqual(autoArchiveOptions(null)[0], { key: 'off', label: 'Off', afterHours: null })
  assert.equal(autoArchiveKey(null), 'off')
  assert.equal(autoArchiveKey(24), '24')
  assert.ok(autoArchiveOptions(24).some((option) => option.key === autoArchiveKey(24)), 'the current wait is always selectable')
})
