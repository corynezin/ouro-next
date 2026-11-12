// The network a server being made goes into, picked when it is named and kept on this phone until the phone pairs with
// it, which may be minutes later or after the app restarts. Then the phone puts it there: an invite into an existing
// network from a saved server holding its key, or a new network made on the new server itself. Once paired, the plan is
// kept under the saved server instead, until it is placed: a placement that fails waits there for the person's Retry.
import { z } from 'zod'
import { NetworkKind } from '@ouro/contract'
import type { DurableStore } from '../platform/ports.ts'

/** `networkKind`: the kind the person picked it as, which the joining server holds the inviting one to. */
export const NetworkPlan = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join'), networkId: z.string(), networkName: z.string(), networkKind: NetworkKind, hostServerId: z.string() }),
  z.object({ kind: z.literal('new_private'), name: z.string() }),
])
export type NetworkPlan = z.infer<typeof NetworkPlan>

/** Plans of servers not paired yet, by setup id: the machine's id on the server that makes it, or the hosted server's id
 * at the hub. */
const SETUP_PREFIX = 'network-plan:'
/** Plans of saved servers not placed yet, by saved server id. Their own prefix, so the two kinds of id never meet. */
const PLACEMENT_PREFIX = 'network-placement:'

/** A plan as stored, or null for anything this release can't read (it is then as if none was picked). */
export function parsePlan(raw: string | null): NetworkPlan | null {
  if (raw === null) return null
  try {
    const plan = NetworkPlan.safeParse(JSON.parse(raw))
    return plan.success ? plan.data : null
  } catch {
    return null
  }
}

/**
 * Once a server has made the private network `name`, every other server waiting to make it joins it instead: two servers
 * made into the same new network get one key, not two networks of the same name. Other plans stay as they are.
 */
export function joinMadeNetwork(plan: NetworkPlan, made: { name: string; networkId: string; hostServerId: string }): NetworkPlan {
  if (plan.kind !== 'new_private' || plan.name !== made.name) return plan
  return { kind: 'join', networkId: made.networkId, networkName: made.name, networkKind: 'private', hostServerId: made.hostServerId }
}

export class NetworkPlans {
  private readonly store: DurableStore
  constructor(store: DurableStore) {
    this.store = store
  }

  async set(setupId: string, plan: NetworkPlan): Promise<void> {
    await this.store.write(SETUP_PREFIX + setupId, JSON.stringify(plan))
  }

  async get(setupId: string): Promise<NetworkPlan | null> {
    return parsePlan(await this.store.read(SETUP_PREFIX + setupId).catch(() => null))
  }

  async clear(setupId: string): Promise<void> {
    await this.store.remove(SETUP_PREFIX + setupId).catch(() => {})
  }

  /** The server set up as `setupId` is paired and saved as `serverId`: its plan goes with it. */
  async movePlanToServer(setupId: string, serverId: string, plan: NetworkPlan): Promise<void> {
    await this.store.write(PLACEMENT_PREFIX + serverId, JSON.stringify(plan))
    await this.clear(setupId)
  }

  async placementOf(serverId: string): Promise<NetworkPlan | null> {
    return parsePlan(await this.store.read(PLACEMENT_PREFIX + serverId).catch(() => null))
  }

  async clearPlacement(serverId: string): Promise<void> {
    await this.store.remove(PLACEMENT_PREFIX + serverId).catch(() => {})
  }

  /** Every saved server still waiting to be placed, with its plan. */
  async placements(): Promise<Map<string, NetworkPlan>> {
    const stored = await this.store.readKeysWithPrefix(PLACEMENT_PREFIX).catch(() => [])
    const plans = new Map<string, NetworkPlan>()
    for (const { key, value } of stored) {
      const plan = parsePlan(value)
      if (plan) plans.set(key.slice(PLACEMENT_PREFIX.length), plan)
    }
    return plans
  }

  /** Rewrites every plan kept here, set up or saved, with `change`. */
  async rewriteAll(change: (plan: NetworkPlan) => NetworkPlan): Promise<void> {
    for (const prefix of [SETUP_PREFIX, PLACEMENT_PREFIX]) {
      for (const { key, value } of await this.store.readKeysWithPrefix(prefix).catch(() => [])) {
        const plan = parsePlan(value)
        if (!plan) continue
        const changed = change(plan)
        if (changed !== plan) await this.store.write(key, JSON.stringify(changed))
      }
    }
  }

  /** Signing out: nothing of the person's servers stays on the phone. */
  async clearAll(): Promise<void> {
    for (const prefix of [SETUP_PREFIX, PLACEMENT_PREFIX]) {
      for (const { key } of await this.store.readKeysWithPrefix(prefix).catch(() => [])) await this.store.remove(key).catch(() => {})
    }
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

  async clear(): Promise<void> {
    await this.store.remove(PENDING_KEY).catch(() => {})
  }
}
