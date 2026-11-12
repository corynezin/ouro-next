// What New server's last step does, apart from the screen: pair a server already run, or make one where the person
// picked, keeping the network picked for it until the phone pairs with it. NewServerScreen.tsx draws the outcome.
import type { NetworkPlan } from '../../core/servers/networkPlans.ts'
import { NOTHING_USABLE_TO_PAIR_WITH } from '../pair/model.ts'
import { existingServerTargetOf } from './model.ts'

export type NewServerRequest =
  /** `typed`: the link or address and code typed in step 2. */
  | { kind: 'existing'; typed: string; plan: NetworkPlan | null }
  /** `where`: 'hosted', or one of the open server's providers. */
  | { kind: 'make'; where: string; label: string; plan: NetworkPlan | null }

/** A server being set up here: one on the hosted account, or one the open server makes. */
export interface SettingUp { kind: 'hosted' | 'machine'; id: string; label: string }

export type NewServerOutcome =
  /** Paired: the phone has switched to it, and with it every screen. */
  | { kind: 'paired' }
  | { kind: 'setting_up'; setup: SettingUp }
  | { kind: 'failed'; why: string }

type Made = { ok: true; id: string; label: string } | { ok: false; why: string }

export interface NewServerPorts {
  newId(): string
  createHosted(label: string): Promise<Made>
  createMachine(provider: string, label: string): Promise<Made>
  keepPlan(setupId: string, plan: NetworkPlan): Promise<void>
  forgetPlan(setupId: string): Promise<void>
  /** Throws a readable error when it fails. */
  pair(target: { url: string; code: string }, setupId: string): Promise<void>
}

export async function createNewServer(ports: NewServerPorts, request: NewServerRequest): Promise<NewServerOutcome> {
  if (request.kind === 'existing') {
    const target = existingServerTargetOf(request.typed)
    if (target === null) return { kind: 'failed', why: NOTHING_USABLE_TO_PAIR_WITH }
    const setupId = `pair-${ports.newId()}`
    try {
      if (request.plan) await ports.keepPlan(setupId, request.plan)
      await ports.pair(target, setupId)
      return { kind: 'paired' }
    } catch (failed) {
      // Not paired: the plan isn't kept for a server this phone doesn't have.
      await ports.forgetPlan(setupId)
      return { kind: 'failed', why: failed instanceof Error ? failed.message : String(failed) }
    }
  }
  const hosted = request.where === 'hosted'
  const made = hosted ? await ports.createHosted(request.label) : await ports.createMachine(request.where, request.label)
  if (!made.ok) return { kind: 'failed', why: made.why }
  // Kept before setup starts, which pairs as soon as the server is ready. If it can't be kept, the server is still made
  // and set up, and is put in a network from Servers.
  if (request.plan) await ports.keepPlan(made.id, request.plan).catch(() => {})
  return { kind: 'setting_up', setup: { kind: hosted ? 'hosted' : 'machine', id: made.id, label: made.label } }
}
