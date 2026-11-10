// The delivery lifecycle: queued -> handed_to_runner -> taken_in -> completed, back to queued (possibly seen) after a turn
// that didn't finish. A turn that ends can complete a delivery the runner never reported taken in.
// Each function is one legal transition; it refuses by throwing, because an illegal one is a bug in the caller.
import type { DeliveryState, DeliveryWake, TurnFailure } from '@ouro/contract'

export class IllegalDeliveryTransition extends Error {}

export interface DeliveryForDispatch {
  deliveryId: string
  wake: DeliveryWake
  state: DeliveryState
  seq: number
}

export function newQueuedDelivery(now: number): DeliveryState {
  return { state: 'queued', since: now, possiblySeen: false }
}

export type DeliveryInTurn = Extract<DeliveryState, { state: 'handed_to_runner' | 'taken_in' }>

/** Handed to the runner or taken in: part of the agent's current turn either way. */
export function isInTurn(state: DeliveryState): state is DeliveryInTurn {
  return state.state === 'handed_to_runner' || state.state === 'taken_in'
}

function requireInTurn(current: DeliveryState, transition: string): DeliveryInTurn {
  if (!isInTurn(current)) throw new IllegalDeliveryTransition(`${transition} from ${current.state}`)
  return current
}

export function handToRunner(current: DeliveryState, turnId: string, attemptId: string, now: number): DeliveryState {
  if (current.state !== 'queued') throw new IllegalDeliveryTransition(`hand to runner from ${current.state}`)
  return { state: 'handed_to_runner', since: now, turnId, attemptId, possiblySeen: current.possiblySeen }
}

/** The runner saw it enter the model's conversation. */
export function markTakenIn(current: DeliveryState, at: number): DeliveryState {
  if (current.state !== 'handed_to_runner') throw new IllegalDeliveryTransition(`mark taken in from ${current.state}`)
  return { ...current, state: 'taken_in', since: at }
}

export function retagTurn(current: DeliveryState, toTurnId: string): DeliveryState {
  return { ...requireInTurn(current, 'retag'), turnId: toTurnId }
}

export function completeDelivery(current: DeliveryState, outcome: 'turn_finished' | 'turn_interrupted', now: number): DeliveryState {
  return { state: 'completed', at: now, turnId: requireInTurn(current, 'complete').turnId, outcome }
}

/** Requeueing is not resending: this only puts it back. The next dispatch is a new attempt, marked as possibly seen. */
export function requeueDelivery(current: DeliveryState, now: number): DeliveryState {
  requireInTurn(current, 'requeue')
  return { state: 'queued', since: now, possiblySeen: true }
}

/** It was in this turn, and the turn failed in a way a retry can't fix. */
export function failDelivery(current: DeliveryState, failure: TurnFailure, now: number): DeliveryState {
  return { state: 'failed', at: now, turnId: requireInTurn(current, 'fail').turnId, failure }
}

export function refuseDelivery(current: DeliveryState, reason: string, now: number): DeliveryState {
  if (current.state !== 'queued') throw new IllegalDeliveryTransition(`refuse from ${current.state}`)
  return { state: 'undeliverable', at: now, reason }
}

/**
 * What to hand the runner, oldest first. An FYI never starts anything, so it goes only along with a real message or into
 * a turn that's already running.
 */
export function selectForDispatch(queued: readonly DeliveryForDispatch[], agentInTurn: boolean): DeliveryForDispatch[] {
  const ordered = [...queued].sort((a, b) => a.seq - b.seq)
  const hasWakingDelivery = ordered.some((delivery) => delivery.wake === 'wake')
  return hasWakingDelivery || (agentInTurn && ordered.length > 0) ? ordered : []
}

export function hasWakingDelivery(queued: readonly Pick<DeliveryForDispatch, 'wake'>[]): boolean {
  return queued.some((delivery) => delivery.wake === 'wake')
}
