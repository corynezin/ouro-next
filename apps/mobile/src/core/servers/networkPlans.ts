// The network a server being made goes into, picked when it is named and kept on this phone until the phone pairs with
// it, which may be minutes later or after the app restarts. Then the phone puts it there: an invite into an existing
// network from a saved server holding its key, or a new network made on the new server itself.
import type { DurableStore } from '../platform/ports.ts'

export type NetworkPlan =
  | { kind: 'join'; networkId: string; networkName: string; hostServerId: string }
  | { kind: 'new_private'; name: string }

const PREFIX = 'network-plan:'

/** `setupId`: the machine's id on the server that makes it, or the hosted server's id at the hub. */
export class NetworkPlans {
  private readonly store: DurableStore
  constructor(store: DurableStore) {
    this.store = store
  }

  async set(setupId: string, plan: NetworkPlan): Promise<void> {
    await this.store.write(PREFIX + setupId, JSON.stringify(plan))
  }

  async get(setupId: string): Promise<NetworkPlan | null> {
    const raw = await this.store.read(PREFIX + setupId).catch(() => null)
    if (raw === null) return null
    try {
      const plan = JSON.parse(raw) as NetworkPlan
      return ['join', 'new_private'].includes(plan.kind) ? plan : null
    } catch {
      return null
    }
  }

  async clear(setupId: string): Promise<void> {
    await this.store.remove(PREFIX + setupId).catch(() => {})
  }
}

const PENDING_KEY = 'pending-private-networks'

/**
 * Private networks the person started that no server is in yet. A private network lives on its servers, and a server is
 * in one network only, so one started from a server already in a network waits here, named, until a new server is put
 * in it: that server makes it.
 */
export class PendingNetworks {
  private readonly store: DurableStore
  constructor(store: DurableStore) {
    this.store = store
  }

  async list(): Promise<string[]> {
    const raw = await this.store.read(PENDING_KEY).catch(() => null)
    try {
      const names: unknown = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
    } catch {
      return []
    }
  }

  async add(name: string): Promise<void> {
    const names = await this.list()
    if (!names.includes(name)) await this.store.write(PENDING_KEY, JSON.stringify([...names, name]))
  }

  async remove(name: string): Promise<void> {
    const names = await this.list()
    if (names.includes(name)) await this.store.write(PENDING_KEY, JSON.stringify(names.filter((other) => other !== name)))
  }
}
