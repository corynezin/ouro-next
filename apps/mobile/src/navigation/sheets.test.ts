import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NavigationState } from '@react-navigation/native'
import { withoutSheets } from './sheets.ts'

const stateOf = (names: string[]): NavigationState => ({
  key: 'root', index: names.length - 1, routeNames: names, type: 'stack', stale: false,
  routes: names.map((name, i) => ({ key: `${name}-${i}`, name })),
})

test('no sheet open: nothing to close', () => {
  assert.equal(withoutSheets(stateOf(['Agents', 'Chat', 'Log'])), null)
})

test('closing keeps the stack below the first sheet, and anything opened from that sheet goes with it', () => {
  const closed = withoutSheets(stateOf(['Agents', 'Chat', 'Settings', 'Servers', 'Pair']))
  assert.deepEqual(closed?.routes.map((route) => route.name), ['Agents', 'Chat'])
  assert.equal(closed?.index, 1)
})
