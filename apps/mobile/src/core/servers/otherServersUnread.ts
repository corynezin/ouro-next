// Unread on the saved servers that aren't open, for the Servers list. Only the open server has a stream, so the others
// are read with one snapshot each: at most once a minute, when the app comes to the foreground or Servers opens.
import type { AppCore } from '../appCore.ts'
import { EntityStore } from '../session/entityStore.ts'

export const OTHER_SERVERS_CHECK_INTERVAL_MS = 60_000

export interface OtherServersUnreadDeps {
  core: AppCore
  /** The same count as the open server's badge. */
  unreadOf: (store: EntityStore) => number
}

export class OtherServersUnread {
  private readonly deps: OtherServersUnreadDeps
  /** By saved server id. A server whose last check failed has no entry. */
  private countsByServer: ReadonlyMap<string, number> = new Map()
  private checkInFlight = false
  private lastCheckStartedAt: number | null = null
  private listeners = new Set<() => void>()

  constructor(deps: OtherServersUnreadDeps) {
    this.deps = deps
  }

  get counts() { return this.countsByServer }
  get checking() { return this.checkInFlight }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed() { for (const listener of this.listeners) listener() }

  /** Checks on each foreground from now on. Returns the unsubscribe. */
  start() {
    return this.deps.core.deps.lifecycle.onForeground(() => { void this.checkIfDue() })
  }

  /** Nothing if a check is running or one started less than a minute ago. */
  async checkIfDue() {
    const now = this.deps.core.deps.clock.now()
    const recent = this.lastCheckStartedAt !== null && now - this.lastCheckStartedAt < OTHER_SERVERS_CHECK_INTERVAL_MS
    if (this.checkInFlight || recent) return
    this.lastCheckStartedAt = now
    this.checkInFlight = true
    this.changed()
    try {
      await this.check()
    } finally {
      this.checkInFlight = false
      this.changed()
    }
  }

  private async check() {
    const { core, unreadOf } = this.deps
    const activeId = core.activeSession?.serverId ?? null
    const others = (await core.servers.list()).filter((server) => server.id !== activeId)
    const counted = await Promise.all(others.map(async (server): Promise<[string, number] | null> => {
      const snapshot = await core.snapshotOf(server)
      if (!snapshot?.ok) return null
      const store = new EntityStore()
      store.applySnapshot(snapshot.value)
      return [server.id, unreadOf(store)]
    }))
    this.countsByServer = new Map(counted.filter((entry) => entry !== null))
  }
}
