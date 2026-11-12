import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeClock, FakeLifecycle, MemoryDurableStore, settle } from '../platform/fakes.ts'
import { checkOutcomeText, restartBannerText, runningCodeText, UpdateFlow, updateMarkInlineText, updateMarkStatus, updateMarkText, updateMarkView } from './updateFlow.ts'
import type { Place, UpdateSource } from './updateFlow.ts'
import type { ManifestCheck, UpdateEndpoint } from './manifest.ts'

class FakeUpdates implements UpdateSource {
  enabled = true
  checks = 0
  newVersionAvailable = false
  restarts = 0
  pointedAt: (string | null)[] = []
  pointAt(endpoint: UpdateEndpoint | null) { this.pointedAt.push(endpoint?.manifestUrl ?? null) }
  async downloadNewVersion() {
    this.checks++
    return this.newVersionAvailable
  }
  async restart() { this.restarts++ }
}

const PLACE: Place = { serverId: 's1', navigationState: '{"routes":["Agents","Chat"]}' }

const HOME: UpdateEndpoint = { manifestUrl: 'https://home.test/manifest', headers: {} }

function setup(place: Place | null = PLACE) {
  const source = new FakeUpdates()
  const clock = new FakeClock()
  const lifecycle = new FakeLifecycle()
  const store = new MemoryDurableStore()
  const manifest = { answer: { kind: 'valid' } as ManifestCheck, reads: 0 }
  const make = () => new UpdateFlow({ source, clock, lifecycle, store, currentPlace: () => place, checkManifest: async () => { manifest.reads++; return manifest.answer } })
  const flow = make()
  flow.setHome(HOME)
  return { source, clock, lifecycle, store, flow, make, manifest }
}

test('checks at launch, every 20 seconds while on screen, and on each return to the foreground', async () => {
  const ctx = setup()
  ctx.flow.start()
  await settle()
  assert.equal(ctx.source.checks, 1)
  await ctx.clock.advance(20_000)
  assert.equal(ctx.source.checks, 2)
  ctx.lifecycle.goToBackground()
  await ctx.clock.advance(60_000)
  assert.equal(ctx.source.checks, 2, 'no checks in the background')
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.source.checks, 3)
  ctx.flow.stop()
  assert.equal(ctx.clock.pendingTimerCount, 0)
})

test('a development build never checks', async () => {
  const ctx = setup()
  ctx.source.enabled = false
  ctx.flow.start()
  await ctx.clock.advance(60_000)
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.source.checks, 0)
  assert.equal(ctx.clock.pendingTimerCount, 0)
})

test('a downloaded version offers a restart once, and stops further checks', async () => {
  const ctx = setup()
  let told = 0
  ctx.flow.subscribe(() => told++)
  ctx.source.newVersionAvailable = true
  ctx.flow.start()
  await settle()
  assert.equal(ctx.flow.readyToRestart, true)
  assert.equal(told, 1)
  await ctx.clock.advance(60_000)
  assert.equal(ctx.source.checks, 1)
  ctx.flow.newVersionDownloaded()
  assert.equal(told, 1)
  ctx.flow.stop()
})

test('one the launch check downloaded also offers a restart', async () => {
  const ctx = setup()
  ctx.flow.newVersionDownloaded()
  assert.equal(ctx.flow.readyToRestart, true)
})

test('a failing check is quiet and tries again later', async () => {
  const ctx = setup()
  ctx.source.downloadNewVersion = async () => { ctx.source.checks++; throw new Error('offline') }
  ctx.flow.start()
  await settle()
  await ctx.clock.advance(20_000)
  assert.equal(ctx.source.checks, 2)
  assert.equal(ctx.flow.readyToRestart, false)
  ctx.flow.stop()
})

test('back in the foreground with a version downloaded, it restarts at once, keeping place', async () => {
  const ctx = setup()
  ctx.source.newVersionAvailable = true
  ctx.flow.start()
  await settle()
  ctx.lifecycle.goToBackground()
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.source.restarts, 1)
  assert.deepEqual(await ctx.make().takeSavedPlace(), PLACE)
  ctx.flow.stop()
})

test('the saved place reopens once, and only within 2 minutes', async () => {
  const ctx = setup()
  await ctx.flow.restartKeepingPlace()
  assert.equal(ctx.source.restarts, 1)
  const next = ctx.make()
  assert.deepEqual(await next.takeSavedPlace(), PLACE)
  assert.equal(await next.takeSavedPlace(), null, 'used once')

  // Each restart is a launch of its own: a flow already restarting saves nothing again.
  await ctx.make().restartKeepingPlace()
  await ctx.clock.advance(119_000)
  assert.deepEqual(await ctx.make().takeSavedPlace(), PLACE, 'still within 2 minutes')

  await ctx.make().restartKeepingPlace()
  assert.ok(await ctx.store.read('restore/place'), 'saved')
  await ctx.clock.advance(120_001)
  assert.equal(await ctx.make().takeSavedPlace(), null, 'stale')
  assert.equal(await ctx.store.read('restore/place'), null, 'and gone')
})

test('nothing on screen to keep still restarts; a failed save still restarts', async () => {
  const empty = setup(null)
  await empty.flow.restartKeepingPlace()
  assert.equal(empty.source.restarts, 1)
  assert.equal(await empty.make().takeSavedPlace(), null)

  const failing = setup()
  failing.store.write = async () => { throw new Error('disk full') }
  await failing.flow.restartKeepingPlace()
  assert.equal(failing.source.restarts, 1)
})

test('an unreadable or damaged saved place opens fresh', async () => {
  const ctx = setup()
  await ctx.store.write('restore/place', 'not json')
  assert.equal(await ctx.flow.takeSavedPlace(), null)
  await ctx.store.write('restore/place', JSON.stringify({ savedAt: ctx.clock.now(), serverId: 's1' }))
  assert.equal(await ctx.flow.takeSavedPlace(), null)
  ctx.store.read = async () => { throw new Error('locked') }
  assert.equal(await ctx.flow.takeSavedPlace(), null)
})

test('the footer says which code is running', () => {
  assert.equal(runningCodeText({ kind: 'development' }), 'updates off (development)')
  assert.equal(runningCodeText({ kind: 'embedded', runtimeVersion: '0123456789' }), 'embedded bundle · runtime 01234567')
  assert.equal(runningCodeText({ kind: 'embedded', runtimeVersion: null }), 'embedded bundle · runtime ?')
  assert.equal(runningCodeText({ kind: 'update', updateId: 'abcdef0123', createdAt: null, updateNumber: null, machineId: null }), 'update abcdef01')
  assert.equal(runningCodeText({ kind: 'update', updateId: 'abcdef0123', createdAt: null, updateNumber: 12, machineId: null }), 'update 12', 'the number the server published it as')
  const createdAt = new Date(2026, 10, 4, 9, 0)
  assert.equal(runningCodeText({ kind: 'update', updateId: 'abcdef0123', createdAt, updateNumber: null, machineId: null }), `update abcdef01 · ${createdAt.toLocaleString()}`, 'with the date it was published')
})

test('a malformed manifest never reaches expo-updates, and says why', async () => {
  const ctx = setup()
  ctx.manifest.answer = { kind: 'invalid', reason: 'createdAt: Invalid string' }
  ctx.source.newVersionAvailable = true
  const outcome = await ctx.flow.checkNow()
  assert.deepEqual(outcome, { kind: 'refused', reason: 'createdAt: Invalid string' })
  assert.equal(ctx.source.checks, 0)
  assert.equal(ctx.flow.readyToRestart, false)
  assert.match(checkOutcomeText(outcome), /malformed, so it wasn't installed/)
})

test('no newer manifest, or no answer: expo-updates is not asked', async () => {
  const ctx = setup()
  ctx.manifest.answer = { kind: 'none' }
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'up_to_date' })
  ctx.manifest.answer = { kind: 'unreachable', reason: 'offline' }
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'failed', reason: 'offline' })
  assert.equal(ctx.source.checks, 0)
})

test('without a home server nothing is checked and the built-in version runs', async () => {
  const ctx = setup()
  ctx.flow.setHome(null)
  assert.deepEqual(ctx.source.pointedAt.at(-1), null)
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'no_home' })
  assert.equal(ctx.manifest.reads, 0)
})

test('a new home is pointed at and fetched at once once started; the same home again does nothing', async () => {
  const ctx = setup()
  assert.deepEqual(ctx.source.pointedAt, ['https://home.test/manifest'], 'set before start: pointed, checked by the launch check')
  assert.equal(ctx.manifest.reads, 0)
  ctx.flow.start()
  await settle()
  assert.equal(ctx.manifest.reads, 1)
  ctx.flow.setHome({ manifestUrl: 'https://other.test/manifest', headers: {} })
  await settle()
  assert.deepEqual(ctx.source.pointedAt, ['https://home.test/manifest', 'https://other.test/manifest'])
  assert.equal(ctx.manifest.reads, 2)
  ctx.flow.setHome({ manifestUrl: 'https://other.test/manifest', headers: {} })
  await settle()
  assert.equal(ctx.manifest.reads, 2)
  ctx.flow.stop()
})

test('a launch with no home clears an override left by the last launch', () => {
  const ctx = setup()
  const relaunched = ctx.make()
  relaunched.setHome(null)
  assert.deepEqual(ctx.source.pointedAt, ['https://home.test/manifest', null])
})

test('if the home moves while its manifest is read, the old answer downloads nothing', async () => {
  const ctx = setup()
  let release = () => {}
  const flow = new UpdateFlow({
    source: ctx.source, clock: ctx.clock, lifecycle: ctx.lifecycle, store: ctx.store, currentPlace: () => null,
    checkManifest: () => new Promise((resolve) => { release = () => resolve({ kind: 'valid' }) }),
  })
  flow.setHome(HOME)
  ctx.source.newVersionAvailable = true
  const outcome = flow.checkNow()
  flow.setHome({ manifestUrl: 'https://other.test/manifest', headers: {} })
  release()
  assert.deepEqual(await outcome, { kind: 'up_to_date' })
  assert.equal(ctx.source.checks, 0)
})

test('check for an update says how it went', async () => {
  const ctx = setup()
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'up_to_date' })
  ctx.source.newVersionAvailable = true
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'downloaded' })
  assert.equal(ctx.flow.readyToRestart, true)
  const failing = setup()
  failing.source.downloadNewVersion = async () => { throw new Error('no network') }
  assert.deepEqual(await failing.flow.checkNow(), { kind: 'failed', reason: 'no network' })
  const off = setup()
  off.source.enabled = false
  assert.equal(checkOutcomeText(await off.flow.checkNow()), 'Updates are off in development builds.')
  assert.equal(checkOutcomeText('checking'), 'Checking…')
})

const never = <T>() => new Promise<T>(() => {})

test('a save of the place that never finishes holds the restart only 2 seconds', async () => {
  const ctx = setup()
  ctx.store.write = never
  void ctx.flow.restartKeepingPlace()
  await settle()
  assert.equal(ctx.source.restarts, 0)
  assert.deepEqual(ctx.flow.restartState, { kind: 'restarting' })
  await ctx.clock.advance(2_000)
  assert.equal(ctx.source.restarts, 1)
})

test('a tap while a check is still downloading restarts after it, or after 5 seconds; checks run one at a time', async () => {
  const ctx = setup()
  let finishDownload = (_ready: boolean) => {}
  ctx.source.downloadNewVersion = () => { ctx.source.checks++; return new Promise<boolean>((resolve) => { finishDownload = resolve }) }
  const first = ctx.flow.checkNow()
  const second = ctx.flow.checkNow()
  await settle()
  assert.equal(ctx.source.checks, 1, 'one download at a time')
  void ctx.flow.restartKeepingPlace()
  await settle()
  assert.equal(ctx.source.restarts, 0, 'not while it downloads')
  finishDownload(true)
  assert.deepEqual(await first, { kind: 'downloaded' })
  assert.deepEqual(await second, { kind: 'downloaded' })
  await settle()
  assert.equal(ctx.source.restarts, 1)

  const stuck = setup()
  stuck.source.downloadNewVersion = never
  void stuck.flow.checkNow()
  void stuck.flow.restartKeepingPlace()
  await stuck.clock.advance(4_999)
  assert.equal(stuck.source.restarts, 0)
  await stuck.clock.advance(1)
  assert.equal(stuck.source.restarts, 1, 'a download that hangs holds it only 5 seconds')
})

test('a restart that fails, or that has not happened 10 seconds on, says so on the banner; a tap tries again; a second tap meanwhile does nothing', async () => {
  const ctx = setup()
  assert.equal(restartBannerText(ctx.flow.restartState), 'A new version is ready: tap to restart')
  ctx.source.restart = async () => { ctx.source.restarts++; throw new Error('no update to launch') }
  await ctx.flow.restartKeepingPlace()
  assert.deepEqual(ctx.flow.restartState, { kind: 'failed', reason: 'no update to launch' })
  assert.equal(restartBannerText(ctx.flow.restartState), "Couldn't restart (no update to launch). Tap to try again.")
  assert.equal(ctx.clock.pendingTimerCount, 0)

  // Settles, as expo-updates' reload may just before the app goes, but the app is still here.
  ctx.source.restart = async () => { ctx.source.restarts++ }
  const notified: string[] = []
  ctx.flow.subscribe(() => notified.push(ctx.flow.restartState.kind))
  void ctx.flow.restartKeepingPlace()
  void ctx.flow.restartKeepingPlace()
  await settle()
  assert.equal(ctx.source.restarts, 2, 'the second tap did nothing')
  assert.equal(restartBannerText(ctx.flow.restartState), 'Restarting…')
  await ctx.clock.advance(9_999)
  assert.deepEqual(ctx.flow.restartState, { kind: 'restarting' })
  await ctx.clock.advance(1)
  assert.deepEqual(ctx.flow.restartState, { kind: 'failed', reason: "it didn't restart" })
  assert.deepEqual(notified, ['restarting', 'failed'])
})

test('a check that hangs is given up after 2 minutes, so later checks still run', async () => {
  const ctx = setup()
  ctx.source.downloadNewVersion = () => { ctx.source.checks++; return never<boolean>() }
  const hung = ctx.flow.checkNow()
  await ctx.clock.advance(120_000)
  assert.deepEqual(await hung, { kind: 'failed', reason: 'the check took too long' })
  ctx.source.downloadNewVersion = async () => { ctx.source.checks++; return true }
  assert.deepEqual(await ctx.flow.checkNow(), { kind: 'downloaded' })
  assert.equal(ctx.source.checks, 2)
})

test('a marked update reads as in the app only when this computer\'s running update is that one or later', () => {
  const mark = { updateNumber: 12, machineId: 'home' }
  const running = (updateNumber: number | null, machineId: string | null) => ({ kind: 'update' as const, updateId: 'u', createdAt: null, updateNumber, machineId })
  assert.equal(updateMarkStatus(mark, running(12, 'home'), false), 'in_app')
  assert.equal(updateMarkStatus(mark, running(13, 'home'), false), 'in_app')
  assert.equal(updateMarkStatus(mark, running(11, 'home'), false), 'not_yet')
  assert.equal(updateMarkStatus(mark, running(40, 'other'), false), 'elsewhere', 'numbers count per computer')
  assert.equal(updateMarkStatus(mark, running(40, null), false), 'unknown')
  assert.equal(updateMarkStatus(mark, { kind: 'development' }, false), 'unknown')
  assert.equal(updateMarkText(12, 'in_app'), 'Update 12 is in your app')
  assert.equal(updateMarkInlineText(12, 'not_yet'), 'update 12 (not in your app yet)', 'inside a sentence it stays a noun')
})

test('on the built-in bundle a mark is "not yet" only while the banner offers an update; otherwise the app cannot tell', () => {
  const mark = { updateNumber: 12, machineId: 'home' }
  const embedded = { kind: 'embedded' as const, runtimeVersion: '1' }
  assert.equal(updateMarkStatus(mark, embedded, true), 'not_yet')
  assert.equal(updateMarkStatus(mark, embedded, false), 'unknown', 'a new build, or updates taken from another computer: no banner will come')
  assert.deepEqual(updateMarkView(mark, embedded, false), { text: "Update 12: this app can't tell whether it has it", inlineText: 'update 12', tone: 'unsure' })
  assert.equal(updateMarkView(mark, embedded, true).tone, 'not_yet')
})
