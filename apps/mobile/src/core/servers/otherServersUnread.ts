// Unread on the saved servers that aren't open, for the Servers list, and the networks each holds and the computers it
// knows, so the list can show every server in the network it lives in whichever is open. Only the open server has a
// stream, so the others are read with one snapshot each: at most once a minute, when the app comes to the foreground or
// Servers opens.
import type { ComputerEntity, NetworkEntity } from '@ouro/contract'
import type { AppCore } from '../appCore.ts'
import { EntityStore } from '../session/entityStore.ts'

export const OTHER_SERVERS_CHECK_INTERVAL_MS = 60_000

export interface OtherServersUnreadDeps {
  core: AppCore
  /** The same count as the open server's badge. */
  unreadOf: (store: EntityStore) => number
}

/** What one server says about networks: the ones it holds keys for, and the computers it is linked to. */
export interface ServerPlace { networks: readonly NetworkEntity[]; computers: readonly ComputerEntity[] }

export class OtherServersUnread {
  private readonly deps: OtherServersUnreadDeps
  /** By saved server id. A server whose last check failed has no entry. */
  private countsByServer: ReadonlyMap<string, number> = new Map()
  /** By saved server id, from the same snapshots. A server whose last check failed has no entry. */
  private placesByServer: ReadonlyMap<string, ServerPlace> = new Map()
  private checkInFlight = false
  private lastCheckStartedAt: number | null = null
  private listeners = new Set<() => void>()

  constructor(deps: OtherServersUnreadDeps) {
    this.deps = deps
  }

  get counts() { return this.countsByServer }
  get places() { return this.placesByServer }
  get checking() { return this.checkInFlight }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changeCount = 0
  /** Moves on at every change, for a view to know when to draw again. */
  get version() { return this.changeCount }
  private changed() { this.changeCount += 1; for (const listener of this.listeners) listener() }

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

  /** Every saved server, the open one too: its networks are needed once another is open, and a check may not run between
   * switching and opening Servers. Each server's answer shows as it comes, so one that is slow to answer holds up none of
   * the others. A server whose check fails keeps its last place: where a server lives rarely changes. */
  private async check() {
    const { core, unreadOf } = this.deps
    const activeId = core.activeSession?.serverId ?? null
    const servers = await core.servers.list()
    const ids = new Set(servers.map((server) => server.id))
    this.countsByServer = new Map([...this.countsByServer].filter(([id]) => ids.has(id) && id !== activeId))
    this.placesByServer = new Map([...this.placesByServer].filter(([id]) => ids.has(id)))
    await Promise.all(servers.map(async (server) => {
      const snapshot = await core.snapshotOf(server).catch(() => null)
      const counts = new Map(this.countsByServer)
      if (!snapshot?.ok) {
        counts.delete(server.id)
        this.countsByServer = counts
        return
      }
      const store = new EntityStore()
      store.applySnapshot(snapshot.value)
      if (server.id !== activeId) counts.set(server.id, unreadOf(store))
      this.countsByServer = counts
      this.placesByServer = new Map(this.placesByServer).set(server.id, { networks: store.server?.networks ?? [], computers: [...store.computers.values()] })
      this.changed()
    }))
  }
}
