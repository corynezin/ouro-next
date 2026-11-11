// New versions arrive without waiting for the next launch. It checks at launch, on each return to the foreground and every
// 20 seconds while on screen. Once a version is downloaded it offers a restart. Back in the foreground with one
// downloaded, it restarts at once. Restarting keeps your place: the open screens are saved and the new version reopens
// them. Drafts and unsent messages are durable already.
//
// Updates come from one "home" server, chosen apart from the active one: switching servers never moves it. Every check
// reads the manifest and validates it first; only a valid one reaches expo-updates.
import type { AppLifecycle, Clock, DurableStore } from '../platform/ports.ts'
import type { ManifestCheck, UpdateEndpoint } from './manifest.ts'

/** The over-the-air update system, as this flow needs it. */
export interface UpdateSource {
  /** False in development builds, which load their code from the bundler. */
  readonly enabled: boolean
  /** Sends expo-updates to this endpoint from now on, or back to the built-in version with null. */
  pointAt(endpoint: UpdateEndpoint | null): void
  /** Checks for a newer version and downloads it. True when a new version is now downloaded and ready. */
  downloadNewVersion(): Promise<boolean>
  /** Starts the downloaded version. May settle just before the app goes, so settling isn't failing; rejecting is. */
  restart(): Promise<void>
}

/** Where the person was, for the new version to reopen. Navigation state is the navigator's own, serialized by it. */
export interface Place { serverId: string; navigationState: string }
interface SavedPlace extends Place { savedAt: number }

/** Where a restart the person asked for stands, for the banner. */
export type RestartState =
  | { kind: 'not_asked' }
  | { kind: 'restarting' }
  /** It didn't happen: the banner says why and a tap tries again. */
  | { kind: 'failed'; reason: string }

const CHECK_INTERVAL_MS = 20_000
/** Saving the place waits no longer than this: a busy store mustn't hold up the restart. */
const PLACE_SAVE_LIMIT_MS = 2_000
/** A check still downloading is given this long to finish first: reloading mid-download can stall expo-updates. */
const CHECK_SETTLE_LIMIT_MS = 5_000
/** A check taking longer than this is given up, so a hung download can't stop every later check. */
const CHECK_LIMIT_MS = 120_000
/** Still running this long after asking for the restart: it didn't happen. */
const RESTART_LIMIT_MS = 10_000
/** A restart this long after the save is a later launch, not the restart into the update: it opens fresh. */
const PLACE_FRESH_MS = 120_000
const PLACE_KEY = 'restore/place'

export class UpdateFlow {
  private readonly source: UpdateSource
  private readonly clock: Clock
  private readonly lifecycle: AppLifecycle
  private readonly store: DurableStore
  private readonly currentPlace: () => Place | null
  private readonly checkManifest: (endpoint: UpdateEndpoint) => Promise<ManifestCheck>
  private home: UpdateEndpoint | null = null
  private homeApplied = false
  private started = false
  private ready = false
  private restart: RestartState = { kind: 'not_asked' }
  /** The check under way, if any: one at a time, since expo-updates takes one check and download at a time. */
  private checking: Promise<CheckOutcome> | null = null
  private cancelRestartWatch: (() => void) | null = null
  private listeners = new Set<() => void>()
  private cleanups: (() => void)[] = []

  constructor(deps: {
    source: UpdateSource
    clock: Clock
    lifecycle: AppLifecycle
    store: DurableStore
    currentPlace: () => Place | null
    checkManifest: (endpoint: UpdateEndpoint) => Promise<ManifestCheck>
  }) {
    this.source = deps.source
    this.clock = deps.clock
    this.lifecycle = deps.lifecycle
    this.store = deps.store
    this.currentPlace = deps.currentPlace
    this.checkManifest = deps.checkManifest
  }

  /**
   * Where updates come from. Pointing expo-updates and fetching happen together, in the same session, as tested: once
   * started, a new home is checked at once. Before start, the launch check does it.
   */
  setHome(endpoint: UpdateEndpoint | null) {
    // The native override outlives the process, so the first home of a launch is always applied, even "none".
    const same = this.homeApplied && endpoint?.manifestUrl === this.home?.manifestUrl
    this.home = endpoint
    this.homeApplied = true
    if (same || !this.source.enabled) return
    this.source.pointAt(endpoint)
    if (this.started) void this.check()
  }

  /** A new version is downloaded and a restart would start it. */
  get readyToRestart() { return this.ready }

  get restartState() { return this.restart }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start() {
    if (!this.source.enabled) return
    this.started = true
    void this.check()
    this.cleanups.push(this.lifecycle.onForeground(() => {
      if (this.ready) void this.restartKeepingPlace()
      else void this.check()
    }))
    this.scheduleCheck()
  }

  stop() {
    this.started = false
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.cancelRestartWatch?.()
    this.cancelRestartWatch = null
  }

  /** The update system downloaded one by itself, as at launch. */
  newVersionDownloaded() {
    if (this.ready) return
    this.ready = true
    this.changed()
  }

  /**
   * Saves the place, then restarts into the new version. Nothing on the way may hang it: the save and a check still
   * downloading are each waited for only so long. A restart that fails, or hasn't happened in time, becomes `failed`,
   * which the banner shows; tapping again tries again. A second ask while one is under way does nothing.
   */
  async restartKeepingPlace() {
    if (this.restart.kind === 'restarting') return
    this.setRestart({ kind: 'restarting' })
    const checking = this.checking
    if (checking) await this.withinLimit(checking.then(() => {}), CHECK_SETTLE_LIMIT_MS)
    const place = this.currentPlace()
    if (place) {
      const saved: SavedPlace = { ...place, savedAt: this.clock.now() }
      // Losing the place is better than not restarting.
      await this.withinLimit(this.store.write(PLACE_KEY, JSON.stringify(saved)).catch(() => {}), PLACE_SAVE_LIMIT_MS)
    }
    this.cancelRestartWatch?.()
    this.cancelRestartWatch = this.clock.setTimer(RESTART_LIMIT_MS, () => {
      this.cancelRestartWatch = null
      if (this.restart.kind === 'restarting') this.setRestart({ kind: 'failed', reason: "it didn't restart" })
    })
    try {
      await this.source.restart()
    } catch (failure) {
      this.cancelRestartWatch?.()
      this.cancelRestartWatch = null
      this.setRestart({ kind: 'failed', reason: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** Waits for `work`, or for `limitMs`, whichever comes first. */
  private withinLimit(work: Promise<void>, limitMs: number) {
    return new Promise<void>((resolve) => {
      const cancel = this.clock.setTimer(limitMs, resolve)
      void work.then(() => { cancel(); resolve() })
    })
  }

  private setRestart(state: RestartState) {
    this.restart = state
    this.changed()
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }

  /** What the version before this one saved, once: it's removed as it's read. Null when none, stale or unreadable. */
  async takeSavedPlace(): Promise<Place | null> {
    let raw: string | null
    try {
      raw = await this.store.read(PLACE_KEY)
      if (raw === null) return null
      await this.store.remove(PLACE_KEY)
    } catch {
      return null
    }
    const saved = parseSavedPlace(raw)
    if (!saved || this.clock.now() - saved.savedAt > PLACE_FRESH_MS) return null
    return { serverId: saved.serverId, navigationState: saved.navigationState }
  }

  private scheduleCheck() {
    const cancel = this.clock.setTimer(CHECK_INTERVAL_MS, () => {
      if (this.lifecycle.isActive()) void this.check()
      this.scheduleCheck()
    })
    this.cleanups.push(cancel)
  }

  private async check() {
    await this.checkNow().catch(() => {})
  }

  /** One check: the manifest first, then expo-updates. Also "Check for an update", which says how it went. Asked while
   * one is under way, it answers with that one. */
  checkNow(): Promise<CheckOutcome> {
    if (this.checking) return this.checking
    const checking = this.checkWithinLimit().finally(() => { this.checking = null })
    this.checking = checking
    return checking
  }

  private checkWithinLimit(): Promise<CheckOutcome> {
    return new Promise<CheckOutcome>((resolve) => {
      const cancel = this.clock.setTimer(CHECK_LIMIT_MS, () => resolve({ kind: 'failed', reason: 'the check took too long' }))
      void this.checkOnce().then((outcome) => { cancel(); resolve(outcome) })
    })
  }

  private async checkOnce(): Promise<CheckOutcome> {
    if (!this.source.enabled) return { kind: 'disabled' }
    if (this.ready) return { kind: 'downloaded' }
    const home = this.home
    if (home === null) return { kind: 'no_home' }
    const manifest = await this.checkManifest(home)
    switch (manifest.kind) {
      case 'none': return { kind: 'up_to_date' }
      case 'unreachable': return { kind: 'failed', reason: manifest.reason }
      case 'invalid': return { kind: 'refused', reason: manifest.reason }
      case 'valid': break
    }
    // The home may have moved while the manifest was read; expo-updates would then fetch from the new one, unchecked.
    if (this.home !== home) return { kind: 'up_to_date' }
    try {
      if (!(await this.source.downloadNewVersion())) return { kind: 'up_to_date' }
    } catch (failure) {
      return { kind: 'failed', reason: failure instanceof Error ? failure.message : String(failure) }
    }
    this.newVersionDownloaded()
    return { kind: 'downloaded' }
  }
}

export type CheckOutcome =
  | { kind: 'disabled' }
  /** No server is set to give updates: the built-in version runs. */
  | { kind: 'no_home' }
  | { kind: 'up_to_date' }
  | { kind: 'downloaded' }
  /** The manifest was malformed, so it never reached expo-updates. */
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }

/** The banner's words: what it offers, or how the restart is going. */
export function restartBannerText(state: RestartState) {
  switch (state.kind) {
    case 'not_asked': return 'A new version is ready: tap to restart'
    case 'restarting': return 'Restarting…'
    case 'failed': return `Couldn't restart (${state.reason}). Tap to try again.`
  }
}

export function checkOutcomeText(outcome: CheckOutcome | 'checking') {
  if (outcome === 'checking') return 'Checking…'
  switch (outcome.kind) {
    case 'disabled': return 'Updates are off in development builds.'
    case 'no_home': return 'No server is set to give updates.'
    case 'up_to_date': return 'Up to date.'
    case 'downloaded': return 'Downloaded: tap the banner (or restart the app) to use it.'
    case 'refused': return `The update was malformed, so it wasn't installed: ${outcome.reason}`
    case 'failed': return outcome.reason
  }
}

function parseSavedPlace(raw: string): SavedPlace | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { savedAt, serverId, navigationState } = value as Record<string, unknown>
    if (typeof savedAt !== 'number' || typeof serverId !== 'string' || typeof navigationState !== 'string') return null
    return { savedAt, serverId, navigationState }
  } catch {
    return null
  }
}

/** Which code is running, for the footer: the build's own, or an update. */
export type RunningCode =
  | { kind: 'development' }
  | { kind: 'embedded'; runtimeVersion: string | null }
  /**
   * `updateNumber` is the server's count from the manifest's extra.ouro; null when the manifest doesn't carry it.
   * `machineId` is the computer that published it, which numbers count on; null in manifests made before it was added.
   */
  | { kind: 'update'; updateId: string; createdAt: Date | null; updateNumber: number | null; machineId: string | null }

export function runningCodeText(code: RunningCode) {
  switch (code.kind) {
    case 'development': return 'updates off (development)'
    case 'embedded': return `embedded bundle · runtime ${code.runtimeVersion?.slice(0, 8) ?? '?'}`
    case 'update': {
      const which = code.updateNumber !== null ? `update ${code.updateNumber}` : `update ${code.updateId.slice(0, 8)}`
      return code.createdAt ? `${which} · ${code.createdAt.toLocaleString()}` : which
    }
  }
}

/** Whether an update an agent marked in a message (`ouro publish` prints the mark) is in the app that's running. */
export type UpdateMarkStatus = 'in_app' | 'not_yet' | 'elsewhere' | 'unknown'

export function updateMarkStatus(mark: { updateNumber: number; machineId: string }, code: RunningCode): UpdateMarkStatus {
  switch (code.kind) {
    case 'development': return 'unknown'
    // No update has been taken since the app was installed.
    case 'embedded': return 'not_yet'
    case 'update':
      if (code.updateNumber === null || code.machineId === null) return 'unknown'
      // Numbers count per computer: another computer's update 12 says nothing about this one's.
      if (code.machineId !== mark.machineId) return 'elsewhere'
      // Every update is built from the same source and numbers only rise, so a later one includes it.
      return code.updateNumber >= mark.updateNumber ? 'in_app' : 'not_yet'
  }
}

/** A mark on a line of its own: a sentence. */
export function updateMarkText(updateNumber: number, status: UpdateMarkStatus) {
  switch (status) {
    case 'in_app': return `Update ${updateNumber} is in your app`
    case 'not_yet': return `Update ${updateNumber} isn't in your app yet. Tap the banner to get it.`
    case 'elsewhere': return `Update ${updateNumber} comes from a computer this app doesn't update from`
    case 'unknown': return `Update ${updateNumber}: this app can't tell whether it has it`
  }
}

/** A mark inside a sentence: still reads as "update N", with its status after it. */
export function updateMarkInlineText(updateNumber: number, status: UpdateMarkStatus) {
  switch (status) {
    case 'in_app': return `update ${updateNumber} (in your app)`
    case 'not_yet': return `update ${updateNumber} (not in your app yet)`
    case 'elsewhere': return `update ${updateNumber} (from another computer)`
    case 'unknown': return `update ${updateNumber}`
  }
}
