import assert from 'node:assert/strict'
import { test } from 'node:test'
import { takeLaunchTap } from './launchTap.ts'
import type { LaunchTapSource } from './launchTap.ts'

/** As iOS keeps it: the launching tap survives a restart into an update until it is cleared. */
class RememberedTap implements LaunchTapSource<string> {
  private tap: string | null
  constructor(tap: string | null) { this.tap = tap }
  last() { return this.tap }
  clear() { this.tap = null }
}

test('the tap that launched the app is handled once, and not again after a restart into an update', () => {
  const system = new RememberedTap('open chat c1')
  const opened: string[] = []
  const launch = () => { const tap = takeLaunchTap(system); if (tap) opened.push(tap) }
  launch()
  launch() // the same process, restarted into the downloaded update
  assert.deepEqual(opened, ['open chat c1'])
})

test('cleared before it is handled, so a handler that restarts at once still sees it only once', () => {
  const system = new RememberedTap('open chat c1')
  const seenAtHandling: (string | null)[] = []
  const tap = takeLaunchTap(system)
  seenAtHandling.push(system.last())
  assert.equal(tap, 'open chat c1')
  assert.deepEqual(seenAtHandling, [null])
  assert.equal(takeLaunchTap(new RememberedTap(null)), null, 'a launch with no tap opens nothing')
})
