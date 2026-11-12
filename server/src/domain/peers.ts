// Peers: the person's other computers running Ouro. What a signed request covers, whether two versions can work
// together, and how recent contact reads as a status. Pure.
import { parseAddress, PEER_MIN_PROTOCOL, PEER_PROTOCOL } from '@ouro/contract'
import type { ComputerStatus } from '@ouro/contract'

/** A signed request older or newer than this, by the receiver's clock, is refused. */
export const PEER_CLOCK_SKEW_MS = 60_000
export const COMPUTER_INVITE_LIFETIME_MS = 30 * 60_000
/** How often each machine says hello to each peer. */
export const PEER_HELLO_INTERVAL_MS = 2_000
const ONLINE_WITHIN_MS = 10_000
const RECONNECTING_WITHIN_MS = 45_000

export interface SignedFields {
  method: string
  /** With its query. */
  path: string
  bodySha256: string
  machineId: string
  time: string
  nonce: string
}

/** The exact text a peer request's signature covers: one field per line, so no field may hold a newline. */
export function signedPayload(fields: SignedFields): string {
  const parts = ['ouro-peer/1', fields.method.toUpperCase(), fields.path, fields.bodySha256, fields.machineId, fields.time, fields.nonce]
  if (parts.some((part) => part.includes('\n'))) throw new Error('a signed field holds a newline')
  return parts.join('\n')
}

/** Why this release can't work with a peer that speaks `protocol` down to `minProtocol`, fit to show; null: it can. */
export function protocolProblem(theirs: { protocol: number; minProtocol: number }): string | null {
  if (theirs.protocol < PEER_MIN_PROTOCOL) return `It speaks protocol ${theirs.protocol} and this server needs ${PEER_MIN_PROTOCOL} or newer: update it.`
  if (theirs.minProtocol > PEER_PROTOCOL) return `It needs protocol ${theirs.minProtocol} or newer and this server speaks ${PEER_PROTOCOL}: update this server.`
  return null
}

export function computerStatusOf(lastSeenAt: number | null, now: number): ComputerStatus {
  if (lastSeenAt === null) return 'offline'
  const silentMs = now - lastSeenAt
  if (silentMs <= ONLINE_WITHIN_MS) return 'online'
  return silentMs <= RECONNECTING_WITHIN_MS ? 'reconnecting' : 'offline'
}

/** A signed request's time is believable. */
export function withinClockSkew(time: number, now: number): boolean {
  return Number.isFinite(time) && Math.abs(now - time) <= PEER_CLOCK_SKEW_MS
}

const PEER_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/** How long a message waits before trying a machine again, after `attempts` tries that it didn't answer. */
export function peerRetryDelayMs(attempts: number): number {
  return PEER_RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), PEER_RETRY_DELAYS_MS.length - 1)]!
}

/**
 * An address as written on the machine `peerName`, as this machine `ownName` writes it: an agent there gains its machine,
 * one of this machine's loses it, and anyone else stays as written. People keep their address: the owner is the same
 * person on every one of their computers.
 */
export function addressFromPeer(address: string, peerName: string, ownName: string): string {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'agent') return address
  if (parsed.machine === null) return `${parsed.agentName}@${peerName}`
  return parsed.machine === ownName ? parsed.agentName : address
}

/**
 * Where the person's other computers reach this one: the address it was given, or else its public URL, where its API
 * already answers peers as it answers phones. Null: it gives no address, and only reaches out to the others.
 */
export function ownPeerAddress(configured: { peerAddress?: string | undefined; publicUrl?: string | undefined }): string | null {
  return configured.peerAddress || configured.publicUrl || null
}
