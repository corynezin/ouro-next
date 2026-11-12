import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOLD_MS, type Steady, steadyPush, steadyStart, steadyTick, steadyWakeAt } from './steady.ts'

const key = (value: string) => value.split(' · ')[0]!
const push = (state: Steady<string>, value: string, now: number) => steadyPush(state, value, key, now)

test('the first change after a quiet spell shows at once', () => {
  const state = push(steadyStart('thinking', 0), 'running Bash', 5000)
  assert.equal(state.shown, 'running Bash')
  assert.equal(steadyWakeAt(state), null)
})

test('a blip that comes and goes within the hold never shows', () => {
  let state = push(steadyStart('thinking', 0), 'running Bash', 5000)
  state = push(state, 'thinking', 5300)
  state = push(state, 'running Bash', 5600)
  assert.equal(state.shown, 'running Bash')
  assert.equal(steadyWakeAt(state), null, 'nothing is left waiting')
  assert.equal(steadyTick(state, 9000).shown, 'running Bash')
})

test('a change that stays shows when the hold ends, the latest one only', () => {
  let state = push(steadyStart('thinking', 0), 'running Bash', 5000)
  state = push(state, 'thinking', 5300)
  state = push(state, 'running Read', 5400)
  assert.equal(state.shown, 'running Bash')
  assert.equal(steadyWakeAt(state), 5000 + HOLD_MS)
  assert.equal(steadyTick(state, 6000).shown, 'running Bash', 'not before the hold ends')
  state = steadyTick(state, 5000 + HOLD_MS)
  assert.equal(state.shown, 'running Read')
  assert.equal(state.shownAt, 5000 + HOLD_MS)
})

test('details under the same key stay live during a hold', () => {
  let state = push(steadyStart('idle', 0), 'thinking · 1s', 5000)
  state = push(state, 'thinking · 2s', 5100)
  assert.equal(state.shown, 'thinking · 2s')
  assert.equal(state.shownAt, 5000, 'the hold is not restarted')
})
