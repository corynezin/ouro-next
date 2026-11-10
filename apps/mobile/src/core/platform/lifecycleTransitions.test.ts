import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transitionsOf } from './lifecycleTransitions.ts'

test('a system prompt opening and closing is switching away and back, never the foreground', () => {
  assert.deepEqual(transitionsOf('active', 'inactive'), ['switching_away'])
  assert.deepEqual(transitionsOf('inactive', 'active'), ['active_again'])
})

test('going to the background and back', () => {
  assert.deepEqual(transitionsOf('active', 'background'), ['switching_away', 'background'])
  assert.deepEqual(transitionsOf('inactive', 'background'), ['background'])
  assert.deepEqual(transitionsOf('background', 'inactive'), [])
  assert.deepEqual(transitionsOf('background', 'active'), ['active_again', 'foreground'])
})
