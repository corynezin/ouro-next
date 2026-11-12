// The person's other computers: inviting one, joining one, proving each request between them, saying hello, and letting
// go. Each machine keeps the other as a peer, with the key it signs with. Requests between peers are signed; the invite's
// code is the only credential for the one request that isn't, joining.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { LogPage as LogPageSchema } from '@ouro/contract'
import type { LogPage, MadeServerInvite } from '@ouro/contract'
import { PeerMemoryPush, PeerPullRequest, PEER_API_PREFIX, PEER_NETWORK_HEADERS, PEER_NETWORKS_PROTOCOL, PeerNetworkJoinResult, PEER_ASK_SNOOZE_PROTOCOL, PEER_LOG_PROTOCOL, PeerLogRequest, PEER_MEMORY_PROTOCOL, PEER_MIN_PROTOCOL, PeerAskSnooze, PeerAskSnoozeResult, PEER_PROTOCOL, PeerMemory, PeerMemoryRequest, PEER_SIGNATURE_HEADERS, PeerAgentList, PeerControl, PeerControlResult, PeerCreateAgent, PeerCreateAgentResult, PeerGroupPost, PeerGroupUpdate, PeerHello, PeerJoinResult, PeerMessage, PeerMessageResult, PeerMove, PeerOwnerAsk, PeerOwnerMessage, PeerMoveCheck, PeerMoveCheckResult, PeerMoveResult } from '@ouro/contract'
import type { NetworkInvite, NetworkKind, NetworkRole, PeerNetworkJoinRequest, ComputerEntity, ComputerInvite, ComputerStatus, ComputerTrust, PeerAgentCard, PeerClaudePlan, PeerIdentity, PeerJoinRequest, PeerSender, RemoteAgentAction, RemoteAgentEntity } from '@ouro/contract'
import { networkSignatureValid, PeerRefused, PeerUnreachable, peerRequest, sha256Hex, signatureValid } from '../adapters/peer-transport.ts'
import type { MachineKey, NetworkKeyFile, NetworkSigner } from '../adapters/peer-transport.ts'
import { helloToSleeperDue } from '../domain/host-hold.ts'
import { COMPUTER_INVITE_LIFETIME_MS, computerStatusOf, PEER_CLOCK_SKEW_MS, PEER_HELLO_INTERVAL_MS, peerRetryDelayMs, protocolProblem, signedPayload, withinClockSkew } from '../domain/peers.ts'
import { acceptance, joinedKindRefusal, peerMay, sharesMemoryWith, showsAgentDetailsTo, signingFor, visitingAfter } from '../domain/networks.ts'
import type { ClaimedNetwork, HeldNetwork, PeerAction, Signing } from '../domain/networks.ts'
import { CommandRefused } from './failure.ts'
import type { NetworkRow, PeerRow, Store } from '../store/store.ts'
export type { PeerRow } from '../store/store.ts'

export interface PeersConfig {
  store: Store
  machineId: string
  machineName: string
  /** The name this server gives its owner in shared networks. */
  ownerName: () => string
  /** Where other machines reach this one's API; null: nobody can, so it can't invite or join. */
  address: string | null
  key: MachineKey
  networkKeys: NetworkKeyFile
  release: string
  now: () => number
  commit: <T>(body: () => T) => T
  agentCounts: () => { running: number; total: number }
  /** See PeerHello.ownerPushTokenHashes. */
  ownerPushTokenHashes: () => string[]
  /** This machine's unarchived agents, as a peer with this trust may see them. */
  agentCards: (trust: ComputerTrust) => PeerAgentCard[]
  /** Claude's plan as this machine knows it, with its agents' costs, for a fully trusted peer. */
  claudePlan: () => PeerClaudePlan
  /** A peer's word on Claude's plan, as this machine counts it, changed. Runs inside a transaction. */
  peerClaudePlanChanged: () => void
  /** A fully trusted peer's control of an agent here. Runs its own transaction. */
  controlFromPeer: (peer: PeerRow, control: PeerControl) => PeerControlResult
  /** A fully trusted peer starts an agent here. Runs its own transaction. */
  createAgentFromPeer: (peer: PeerRow, request: PeerCreateAgent) => Promise<PeerCreateAgentResult>
  /** A message from a peer for someone here. Runs inside a transaction; answers whether it was taken. */
  deliverFromPeer: (peer: PeerRow, message: PeerMessage) => PeerMessageResult
  /** A group's home says how the group is now, perhaps with a post. Runs inside a transaction. */
  groupUpdateFromPeer: (peer: PeerRow, update: PeerGroupUpdate) => PeerMessageResult
  /** A member's machine posts to a group whose home is here. Runs inside a transaction. */
  groupPostFromPeer: (peer: PeerRow, post: PeerGroupPost) => PeerMessageResult
  /** What an agent there said to the person, for the person's chat with it here. Runs inside a transaction. */
  ownerMessageFromPeer: (peer: PeerRow, message: PeerOwnerMessage) => PeerMessageResult
  /** An ask of an agent there to the person, opened or closed, for the person's chat with it here. Runs inside a transaction. */
  ownerAskFromPeer: (peer: PeerRow, ask: PeerOwnerAsk) => PeerMessageResult
  /** The person snoozed a copy there of an ask here. Runs its own transaction. */
  askSnoozeFromPeer: (peer: PeerRow, snooze: PeerAskSnooze) => PeerAskSnoozeResult
  /** How often to pull a fully trusted peer's memory. Memory moves slowly, and a pull is every note about the person and
   * of the projects both have. */
  memoryPullIntervalMs: number
  /** The projects this machine has memory for. */
  memoryProjectKeys: () => string[]
  /** What a fully trusted peer pulls of this machine's memory. */
  memoryForPeer: (peer: PeerRow, projectKeys: string[]) => PeerMemory
  /** Takes in a fully trusted peer's memory. Runs its own transaction. */
  memoryFromPeer: (peer: PeerRow, memory: PeerMemory) => void
  /** A page of the log of this machine's agent of that name, for a fully trusted peer. Null: no such agent here. */
  logForPeer: (request: PeerLogRequest) => LogPage | null
  /** Whether an agent of this name could move here now. Changes nothing. */
  moveCheckFromPeer: (peer: PeerRow, check: PeerMoveCheck) => PeerMoveCheckResult
  /** A fully trusted peer hands an agent over. Runs its own transaction. */
  moveFromPeer: (peer: PeerRow, move: PeerMove) => PeerMoveResult
  /** A copy of this machine's agent of that name, for a server pulling it; null: no such agent here. */
  pullForPeer: (agentName: string) => PeerMove | null
  /** A private server's project notes, pushed into this server's network. Runs its own transaction. */
  memoryPushFromPeer: (peer: PeerRow, push: PeerMemoryPush) => void
  /** This host pauses when idle. */
  hostSleeps: boolean
  /** This host is holding itself awake for work now. */
  heldAwake: () => boolean
  /** Someone is using this machine: it holds itself awake, or an app is watching it. */
  inUse: () => boolean
  /** Holds this host awake for work a peer brings; false when it can't be. */
  holdForWork: () => Promise<boolean>
  log: (event: string, fields: Record<string, unknown>) => void
}

/** What became of handing an agent over. `unknown`: the request may have arrived and been taken, so the agent mustn't
 * run here until the same handoff is answered. */
export type HandoverOutcome =
  | { kind: 'taken'; address: string }
  | { kind: 'not_taken'; why: string }
  | { kind: 'unknown'; why: string }

/** Long enough to write a long conversation in on the other side. */
const MOVE_TIMEOUT_MS = 120_000

/** Long enough for the other side to ask a model for the agent's name (NAME_SUGGESTION_TIMEOUT_MS) and start it. */
const CREATE_AGENT_TIMEOUT_MS = 30_000

/** A peer request refused, with the code and words for its answer. */
export class PeerRequestRefused extends Error {
  readonly code: 'unauthenticated' | 'invite_invalid' | 'invalid_request' | 'forbidden' | 'not_found' | 'incompatible' | 'host_hold_refused'
  constructor(code: PeerRequestRefused['code'], message: string) {
    super(message)
    this.code = code
  }
}

const INVITE_HASH_KEY = 'computer_invite_hash'
const INVITE_EXPIRES_KEY = 'computer_invite_expires_at'
const hashCode = (code: string): Buffer => createHash('sha256').update(code).digest()

/** An address whose traffic is encrypted on the way: HTTPS, a Tailscale address (100.64.0.0/10, or a name under ts.net),
 * or this machine itself. A network's key travels only to and from one. */
export function privateTransport(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.ts.net')) return true
  const octets = host.split('.').map(Number)
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet)) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
}

/** Why this server and the peer can't work together, from what it last said in a hello; null: they can, or it hasn't said yet. */
const incompatibilityOf = (peer: PeerRow): string | null => (peer.hello ? protocolProblem(peer.hello) : null)

export class Peers {
  private readonly config: PeersConfig
  /** Nonces seen within twice the skew window, by machine: a replayed request is refused. */
  private readonly seenNonces = new Map<string, number>()
  private readonly helloInFlight = new Set<string>()
  private readonly sendInFlight = new Set<string>()
  private readonly lastHelloSentAt = new Map<string, number>()
  /** When each peer last said hello to this machine, as against answering one. */
  private readonly lastHelloFromAt = new Map<string, number>()
  private readonly lastVisitAt = new Map<string, number>()
  /** When this machine last pulled each peer's memory. */
  private readonly lastMemoryPullAt = new Map<string, number>()
  /** Each computer's agents as it last showed them: a cache, rebuilt from the next answer after a restart. */
  private readonly copies = new Map<string, Map<string, RemoteAgentEntity>>()
  /** Claude's plan as each fully trusted computer last told it: a cache like its agents. */
  private readonly claudePlans = new Map<string, PeerClaudePlan>()
  /** The status each computer was last reported to clients with: a change of status without any contact is a change too. */
  private readonly reportedStatus = new Map<string, ComputerStatus>()

  constructor(config: PeersConfig) {
    this.config = config
  }

  private identity(): PeerIdentity {
    return {
      machineId: this.config.machineId,
      name: this.config.machineName,
      address: this.requireAddress(),
      publicKey: this.config.key.publicKeyPem,
      protocol: PEER_PROTOCOL,
      minProtocol: PEER_MIN_PROTOCOL,
    }
  }

  private requireAddress(): string {
    if (this.config.address === null) throw new CommandRefused('invalid_request', "this server has no address other computers can reach (set OURO_PEER_ADDRESS)")
    return this.config.address
  }

  /** This machine's hello. In a network, it says who this machine is and which servers live in that network, as this one
   * knows them. */
  private hello(networkId: string | null = null, to: string | null = null): PeerHello {
    const { running, total } = this.config.agentCounts()
    const base: PeerHello = { protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL, release: this.config.release, agentsRunning: running, agentCount: total, sleeps: this.config.hostSleeps, heldAwake: this.config.heldAwake(), ownerPushTokenHashes: this.config.ownerPushTokenHashes() }
    if (networkId === null || this.config.address === null) return base
    const addresses = this.config.store.listPeers()
      .filter((peer) => peer.networkId === networkId && !peer.visiting && peer.machineId !== to)
      .map((peer) => ({ machineId: peer.machineId, name: peer.name, address: peer.address }))
    return { ...base, identity: this.identity(), ownerName: this.config.ownerName(), addresses }
  }

  // Networks

  /** The networks this server holds keys for, without the keys. */
  heldNetworks(): HeldNetwork[] {
    return this.config.store.listNetworks().map((network) => ({ id: network.id, kind: network.kind, role: network.role }))
  }

  /** This server's home network, as the network decisions take it. */
  homeNetwork(): HeldNetwork | null {
    const home = this.config.store.homeNetwork()
    return home && { id: home.id, kind: home.kind, role: home.role }
  }

  /** How this server reaches a peer, if it does: see signingFor. */
  signingFor(peer: PeerRow): Signing {
    return signingFor(peer, this.heldNetworks())
  }

  /** A signed request from the peer that does `action`, refused unless it may (see peerMay). Every working route asks this
   * first, in interfaces/peer.ts. */
  requireMay(action: PeerAction, peer: PeerRow): void {
    const may = peerMay(action, peer, this.homeNetwork())
    if (may.kind === 'refused') throw new PeerRequestRefused('forbidden', `${this.config.machineName} refused: ${may.reason}`)
  }

  /** The peer, which this server must be able to contact: refused at once, with the reason, when it never does. */
  requireReachable(peer: PeerRow): PeerRow {
    const signing = this.signingFor(peer)
    if (signing.kind === 'never') throw new CommandRefused('forbidden', signing.reason)
    return peer
  }

  private networkSigner(signing: Signing, recipient: string): NetworkSigner | null {
    if (signing.kind !== 'keyed') return null
    const network = this.config.store.networkById(signing.networkId)
    const key = network && this.config.networkKeys.get(network.id)
    return network && key ? { id: network.id, key, visiting: signing.visiting, recipient } : null
  }

  /** An invite for a server this one made: into the home network when this server has one, else to be one of its
   * computers. Either replaces the open invite of its kind, as making one by hand does, so an invite the person made a
   * moment ago for another computer stops working. */
  inviteForMadeServer(): MadeServerInvite {
    const home = this.config.store.homeNetwork()
    if (home) {
      const invite = this.createNetworkInvite(home.id)
      return { kind: 'network', networkKind: home.kind, address: invite.address, code: invite.code }
    }
    return { kind: 'computer', address: this.requireAddress(), code: this.createInvite().code }
  }

  /** A one-use invite into a network this server holds a key for, for 30 minutes, replacing any open one into it. */
  createNetworkInvite(networkId: string): NetworkInvite {
    const address = this.requireAddress()
    if (!privateTransport(address)) throw new CommandRefused('invalid_request', `an invite's answer carries the network's key, so it is made only where this server is reached over HTTPS or Tailscale, and ${address} is neither`)
    const network = this.config.store.networkById(networkId)
    if (!network) throw new CommandRefused('not_found', 'this server holds no key for that network')
    const code = randomBytes(16).toString('hex')
    const expiresAt = this.config.now() + COMPUTER_INVITE_LIFETIME_MS
    this.config.store.setNetworkInvite(network.id, hashCode(code).toString('hex'), expiresAt)
    // The kind in the command is this server's word on it: the joining server's person runs it only if that is what they
    // expect, and both servers refuse another kind (see joinedKindRefusal).
    return { networkId: network.id, code, address, expiresAt, command: `ouro networks join ${address} ${code} --kind ${network.kind}` }
  }

  /** The network whose open invite is this code, still open. Looking doesn't use it. */
  private networkOfInvite(code: string): NetworkRow | null {
    const offered = hashCode(code)
    const now = this.config.now()
    for (const network of this.config.store.listNetworks()) {
      if (network.inviteHash === null || network.inviteExpiresAt === null || now > network.inviteExpiresAt) continue
      const open = Buffer.from(network.inviteHash, 'hex')
      if (offered.length === open.length && timingSafeEqual(offered, open)) return network
    }
    return null
  }

  /** Another server trades this server's invite for the network's key. One taking it as its home key lives in the network,
   * so it goes in the address book here. A join this server refuses leaves the invite open: the person on the other side
   * may have picked the wrong kind, and can try again. */
  acceptNetworkJoin(request: PeerNetworkJoinRequest): PeerNetworkJoinResult {
    const host = this.identity()
    if (!privateTransport(host.address)) throw new PeerRequestRefused('forbidden', `${this.config.machineName} gives a network's key only over HTTPS or Tailscale`)
    return this.config.commit(() => {
      const network = this.networkOfInvite(request.code)
      if (!network) throw new PeerRequestRefused('invite_invalid', 'That invite is not valid: it was used, replaced, or it expired.')
      const refusal = joinedKindRefusal(request.kind, network.kind) ?? (network.kind === 'private' && request.role === 'extra' ? 'a private network is joined only as a home' : null)
      if (refusal !== null) throw new PeerRequestRefused('forbidden', `${this.config.machineName} refused: ${refusal}.`)
      if (request.role === 'home') this.admitInNetwork(request.joiner, network.id, false, request.ownerName)
      // Invited back on purpose, if it was removed: see remove.
      this.config.store.forgetRemovedFromNetwork(network.id, request.joiner.machineId)
      // Used: no one else trades it.
      this.config.store.setNetworkInvite(network.id, null, null)
      const key = this.config.networkKeys.get(network.id)
      if (key === null) throw new PeerRequestRefused('invite_invalid', 'That invite is not valid: this server no longer holds the key.')
      return { network: { key, name: network.name, kind: network.kind }, host, hostOwnerName: this.config.ownerName(), hostVisiting: network.role === 'extra' }
    })
  }

  /** Trades an invite's code at `address` for its network's key, refused if it isn't of the kind the person expects. Nothing
   * is kept here until the caller keeps it. */
  async askToJoinNetwork(address: string, code: string, role: NetworkRole, kind: NetworkKind): Promise<PeerNetworkJoinResult> {
    if (!privateTransport(address)) throw new CommandRefused('invalid_request', `the key would come back in the clear: ${address} is reached neither over HTTPS nor Tailscale`)
    let answer: unknown
    try {
      answer = await peerRequest(address, 'POST', '/network-join', { code, joiner: this.identity(), ownerName: this.config.ownerName(), role, kind } satisfies PeerNetworkJoinRequest, null, this.config.now())
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', error.message)
      if (error instanceof PeerRefused) throw new CommandRefused(error.code === 'invite_invalid' || error.code === 'forbidden' ? 'forbidden' : 'invalid_request', error.message)
      throw error
    }
    // Everything it says is checked before any of it is kept or shown: the name lands in this server's notices.
    const joined = PeerNetworkJoinResult.safeParse(answer)
    if (!joined.success) throw new CommandRefused('invalid_request', `${address} answered with something that isn't a network`)
    const refusal = joinedKindRefusal(kind, joined.data.network.kind)
    if (refusal !== null) throw new CommandRefused('forbidden', refusal)
    return joined.data
  }

  /** The server that invited this one, once the key is kept here: it goes in the address book unless it only visits. */
  admitInviter(result: PeerNetworkJoinResult, networkId: string): void {
    this.config.store.forgetRemovedFromNetwork(networkId, result.host.machineId)
    if (result.hostVisiting) return
    try {
      this.admitInNetwork(result.host, networkId, false, result.hostOwnerName)
    } catch (error) {
      if (error instanceof PeerRequestRefused) throw new CommandRefused('invalid_request', error.message)
      throw error
    }
  }

  /** A server heard from in a network, with its key: kept, or updated, as it says it is now. */
  private admitInNetwork(peer: PeerIdentity, networkId: string, visiting: boolean, ownerName: string | null): void {
    this.refuseIfUnadmittable(peer)
    const known = this.config.store.peerById(peer.machineId)
    // A machine's key is believed the first time only: after that, nothing rebinds its id to another key.
    if (known && known.publicKey !== '' && known.publicKey !== peer.publicKey) throw new PeerRequestRefused('unauthenticated', `${peer.name} is known here with another key`)
    this.config.store.savePeerInNetwork({ machineId: peer.machineId, name: peer.name, address: peer.address, publicKey: peer.publicKey, networkId, visiting, ownerName, joinedAt: known?.joinedAt ?? this.config.now() })
  }

  /** Servers another one says live in a network this one holds a key for: kept as addresses, until each is heard from
   * itself. Only ones unknown here, and never one the person removed from that network; what is known stays as it is.
   * An address isn't checked: any member can name any URL, and this server then POSTs its signed hello there (and, once
   * answered, asks for its agents). The key it keeps is the one the answer gives for that machine id, never rebound after. */
  private learnAddresses(networkId: string, addresses: NonNullable<PeerHello['addresses']>): void {
    if (!this.config.store.networkById(networkId)) return
    for (const entry of addresses) {
      if (entry.machineId === this.config.machineId || entry.name === this.config.machineName) continue
      if (this.config.store.removedFromNetwork(networkId, entry.machineId)) continue
      if (this.config.store.peerById(entry.machineId) || this.config.store.peerByName(entry.name)) continue
      this.config.store.savePeerInNetwork({ machineId: entry.machineId, name: entry.name, address: entry.address, publicKey: '', networkId, visiting: false, ownerName: null, joinedAt: this.config.now() })
    }
  }

  entityOf(peer: PeerRow): ComputerEntity {
    return {
      id: peer.machineId,
      name: peer.name,
      trust: peer.trust,
      status: computerStatusOf(peer.lastSeenAt, this.config.now()),
      lastSeenAt: peer.lastSeenAt,
      release: peer.hello?.release ?? null,
      agentsRunning: peer.hello?.agentsRunning ?? null,
      agentCount: peer.hello?.agentCount ?? null,
      incompatibility: incompatibilityOf(peer),
      joinedAt: peer.joinedAt,
      address: peer.address,
      networkId: peer.networkId,
      visiting: peer.visiting,
    }
  }

  /** Computers this server has heard from: an address not yet heard from isn't shown. */
  list(): ComputerEntity[] {
    return this.config.store.listPeers().filter((peer) => peer.publicKey !== '').map((peer) => this.entityOf(peer))
  }

  // Inviting and joining

  createInvite(): ComputerInvite {
    if (this.config.store.homeNetwork()) throw new CommandRefused('invalid_request', 'this server is in a network: invite other servers into it instead (create_network_invite)')
    const address = this.requireAddress()
    const code = randomBytes(16).toString('hex')
    const expiresAt = this.config.now() + COMPUTER_INVITE_LIFETIME_MS
    this.config.store.setMeta(INVITE_HASH_KEY, hashCode(code).toString('hex'))
    this.config.store.setMeta(INVITE_EXPIRES_KEY, String(expiresAt))
    return { code, expiresAt, command: `ouro computers join ${address} ${code}`, address }
  }

  /** The open invite is this code, and still open; using it closes it. */
  private takeInvite(code: string): boolean {
    const hash = this.config.store.getMeta(INVITE_HASH_KEY)
    const expiresAt = Number(this.config.store.getMeta(INVITE_EXPIRES_KEY) ?? 0)
    if (hash === null || this.config.now() > expiresAt) return false
    const offered = hashCode(code)
    const open = Buffer.from(hash, 'hex')
    if (offered.length !== open.length || !timingSafeEqual(offered, open)) return false
    this.config.store.setMeta(INVITE_HASH_KEY, '')
    return true
  }

  /** Another machine joins with this machine's invite: it becomes a fully trusted peer, as the invite's maker meant. */
  acceptJoin(request: PeerJoinRequest): { host: PeerIdentity } {
    const { joiner } = request
    const host = this.identity()
    return this.config.commit(() => {
      if (this.config.store.homeNetwork()) throw new PeerRequestRefused('forbidden', `${this.config.machineName} is in a network now: it takes in servers through network invites`)
      if (!this.takeInvite(request.code)) throw new PeerRequestRefused('invite_invalid', 'That invite is not valid: it was used, replaced, or it expired.')
      this.admit(joiner)
      return { host }
    })
  }

  /** Asks the machine at `address` to take this one in, with an invite it made; answers who it is. Nothing is kept here
   * until `admitHost`. */
  async askToJoin(address: string, code: string): Promise<PeerIdentity> {
    if (this.config.store.homeNetwork()) throw new CommandRefused('invalid_request', 'this server is in a network: join others with a network invite (join_network)')
    const joiner = this.identity()
    let answer: unknown
    try {
      answer = await peerRequest(address, 'POST', '/join', { code, joiner } satisfies PeerJoinRequest, null, this.config.now())
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', error.message)
      if (error instanceof PeerRefused) throw new CommandRefused(error.code === 'invite_invalid' ? 'forbidden' : 'invalid_request', error.message)
      throw error
    }
    return PeerJoinResult.parse(answer).host
  }

  /** The machine that took this one in becomes a fully trusted peer here too. */
  admitHost(host: PeerIdentity): ComputerEntity {
    try {
      this.admit(host)
    } catch (error) {
      if (error instanceof PeerRequestRefused) throw new CommandRefused('invalid_request', error.message)
      throw error
    }
    return this.entityOf(this.config.store.peerById(host.machineId)!)
  }

  private admit(peer: PeerIdentity): void {
    this.refuseIfUnadmittable(peer)
    this.config.store.savePeer({ machineId: peer.machineId, name: peer.name, address: peer.address, publicKey: peer.publicKey, trust: 'full', joinedAt: this.config.now() })
  }

  /** What every server taken in must be: not this one, not named as this one or another computer here, and able to work
   * with it. */
  private refuseIfUnadmittable(peer: PeerIdentity): void {
    if (peer.machineId === this.config.machineId) throw new PeerRequestRefused('invalid_request', 'A computer cannot join itself.')
    if (peer.name === this.config.machineName) throw new PeerRequestRefused('invalid_request', `This computer is called "${peer.name}" too: rename one of them first.`)
    const sameName = this.config.store.peerByName(peer.name)
    if (sameName && sameName.machineId !== peer.machineId) throw new PeerRequestRefused('invalid_request', `Another computer here is called "${peer.name}" already.`)
    const problem = protocolProblem(peer)
    if (problem) throw new PeerRequestRefused('incompatible', problem)
  }

  // Signed requests

  /** The peer a signed request is from, once its signature, time and nonce check out. */
  verify(request: { method: string; path: string; body: string; header: (name: string) => string | undefined }): PeerRow {
    const machineId = request.header(PEER_SIGNATURE_HEADERS.machine)
    const time = request.header(PEER_SIGNATURE_HEADERS.time)
    const nonce = request.header(PEER_SIGNATURE_HEADERS.nonce)
    const signature = request.header(PEER_SIGNATURE_HEADERS.signature)
    if (!machineId || !time || !nonce || !signature) throw new PeerRequestRefused('unauthenticated', 'the request is not signed')
    const now = this.config.now()
    if (!withinClockSkew(Number(time), now)) throw new PeerRequestRefused('unauthenticated', 'the request is too far from this server\'s clock')
    let payload: string
    try {
      payload = signedPayload({ method: request.method, path: request.path, bodySha256: sha256Hex(request.body), machineId, time, nonce })
    } catch {
      throw new PeerRequestRefused('unauthenticated', 'the request is not signed')
    }
    const home = this.config.store.homeNetwork()
    const claimed = this.claimedNetwork(request, payload, home)
    const known = this.config.store.peerById(machineId)
    // A server not heard from yet, in this server's network, introduces itself with a hello that says who it is.
    const introduction = known === null || known.publicKey === '' ? this.introductionOf(request, machineId, home, claimed) : null
    const publicKey = introduction?.publicKey ?? known?.publicKey
    if (publicKey === undefined) throw new PeerRequestRefused('unauthenticated', 'this server does not know that computer')
    if (!signatureValid(publicKey, payload, signature)) throw new PeerRequestRefused('unauthenticated', 'the signature does not match')
    const accepted = acceptance(this.homeNetwork(), claimed, known)
    if (accepted.kind === 'refused') throw new PeerRequestRefused('unauthenticated', `${this.config.machineName} refused it: ${accepted.reason}`)
    if (!this.freshNonce(machineId, nonce, now)) throw new PeerRequestRefused('unauthenticated', 'the request was replayed')
    const network = accepted.network
    if (network !== null) {
      this.config.commit(() => {
        if (introduction) this.admitInNetwork(introduction, network.id, network.visiting, null)
        else this.config.store.notePeerNetwork(machineId, network.id, visitingAfter(network.visiting, known, network.id))
      })
    }
    return this.config.store.peerById(machineId)!
  }

  /** The network a request says it was sent in, and whether its network signature checks out with this server's home key. */
  private claimedNetwork(request: { header: (name: string) => string | undefined }, payload: string, home: NetworkRow | null): ClaimedNetwork | null {
    const networkId = request.header(PEER_NETWORK_HEADERS.network)
    const signature = request.header(PEER_NETWORK_HEADERS.signature)
    // Before networks, this server takes no notice of them.
    if (!networkId || !signature || home === null) return null
    const visiting = request.header(PEER_NETWORK_HEADERS.visiting) === '1'
    const key = networkId === home.id ? this.config.networkKeys.get(home.id) : null
    return { networkId, visiting, signatureValid: key !== null && networkSignatureValid(key, payload, networkId, visiting, this.config.machineId, signature) }
  }

  /** Who a server this one doesn't know yet says it is, in a hello signed in this server's network. */
  private introductionOf(request: { method: string; path: string; body: string }, machineId: string, home: NetworkRow | null, claimed: ClaimedNetwork | null): PeerIdentity {
    const unknown = new PeerRequestRefused('unauthenticated', 'this server does not know that computer')
    if (home === null || claimed === null || !claimed.signatureValid) throw unknown
    if (request.method !== 'POST' || new URL(request.path, 'http://peer.invalid').pathname !== `${PEER_API_PREFIX}/hello`) throw unknown
    let body: unknown
    try {
      body = JSON.parse(request.body)
    } catch {
      throw unknown
    }
    const hello = PeerHello.safeParse(body)
    if (!hello.success || !hello.data.identity || hello.data.identity.machineId !== machineId) throw unknown
    // Removed from the network here: it still holds the key, but it doesn't come back by saying hello.
    if (this.config.store.removedFromNetwork(home.id, machineId)) throw unknown
    return hello.data.identity
  }

  private freshNonce(machineId: string, nonce: string, now: number): boolean {
    for (const [key, seenAt] of this.seenNonces) if (now - seenAt > 2 * PEER_CLOCK_SKEW_MS) this.seenNonces.delete(key)
    const key = `${machineId}:${nonce}`
    if (this.seenNonces.has(key)) return false
    this.seenNonces.set(key, now)
    return true
  }

  /** A request other than hello or forget from a peer: refused while the two can't work together. */
  requireWorksWith(peer: PeerRow): void {
    const problem = incompatibilityOf(peer)
    if (problem) throw new PeerRequestRefused('incompatible', `${this.config.machineName} can't work with this computer: ${problem}`)
  }

  /** The peer, to ask for anything but hello or forget: refused while the two can't work together. */
  private requireWorkingPeer(machineId: string): PeerRow {
    const peer = this.requireReachable(this.requirePeer(machineId))
    const problem = incompatibilityOf(peer)
    if (problem) throw new CommandRefused('peer_incompatible', `${peer.name} can't work with this computer: ${problem}`)
    return peer
  }

  // Hellos

  /** A peer's hello: it is alive. Answers this machine's. */
  receiveHello(peer: PeerRow, body: unknown): PeerHello {
    const hello = PeerHello.safeParse(body)
    if (!hello.success) throw new PeerRequestRefused('invalid_request', 'not a hello')
    this.lastHelloFromAt.set(peer.machineId, this.config.now())
    // Signed in this server's network, or, from a link before networks, in no network.
    const networkId = this.config.store.homeNetwork() !== null ? peer.networkId : null
    this.config.commit(() => this.noteHello(peer.machineId, hello.data, networkId))
    return this.hello(networkId, peer.machineId)
  }

  /** `networkId`: the network the hello came in, whose addresses it brings. */
  private noteHello(machineId: string, hello: PeerHello, networkId: string | null): void {
    const before = this.config.store.peerById(machineId)
    if (!before) return
    if (hello.ownerName !== undefined) this.config.store.notePeerOwnerName(machineId, hello.ownerName)
    // A server known only from an address book, that this one reached itself: its key is what it says.
    if (before.publicKey === '' && networkId !== null && hello.identity?.machineId === machineId) {
      this.config.store.savePeerInNetwork({ machineId, name: before.name, address: before.address, publicKey: hello.identity.publicKey, networkId, visiting: before.visiting, ownerName: hello.ownerName ?? null, joinedAt: before.joinedAt })
    }
    // Only a server living in the network vouches for others in it: a visitor's word would make strangers members.
    if (networkId !== null && !before.visiting && hello.addresses) this.learnAddresses(networkId, hello.addresses)
    const { identity: _identity, addresses: _addresses, ownerName: _ownerName, ...kept } = hello
    hello = kept
    this.config.store.notePeerHello(machineId, this.config.now(), hello)
    const changed = JSON.stringify(before.hello) !== JSON.stringify(hello) || this.reportedStatus.get(machineId) !== 'online'
    if (changed) this.config.store.markChanged('computer', machineId)
    this.reportedStatus.set(machineId, 'online')
  }

  /** From the server's tick: says hello to each peer that is due, one at a time per peer, and reports statuses that
   * changed with time alone. */
  tick(): void {
    const now = this.config.now()
    for (const peer of this.config.store.listPeers()) {
      const status = computerStatusOf(peer.lastSeenAt, now)
      if (this.reportedStatus.get(peer.machineId) !== status) {
        this.reportedStatus.set(peer.machineId, status)
        this.config.commit(() => this.config.store.markChanged('computer', peer.machineId))
      }
      const signing = this.signingFor(peer)
      this.sendNextQueued(peer, now, signing)
      // A visitor, or a server in no network this one holds, is never contacted.
      if (signing.kind === 'never') continue
      if (this.helloInFlight.has(peer.machineId) || now - (this.lastHelloSentAt.get(peer.machineId) ?? 0) < PEER_HELLO_INTERVAL_MS) continue
      if (!this.helloDue(peer, now)) continue
      this.lastHelloSentAt.set(peer.machineId, now)
      this.helloInFlight.add(peer.machineId)
      const networkId = signing.kind === 'keyed' ? signing.networkId : null
      this.signed(peer, 'POST', '/hello', this.hello(networkId, peer.machineId))
        .then((answer) => this.config.commit(() => this.noteHello(peer.machineId, PeerHello.parse(answer), networkId)))
        .then(() => this.refreshCopiesFrom(peer.machineId))
        .then(() => this.pullMemoryIfDue(peer.machineId).catch((error: unknown) => this.config.log('peer_memory_not_pulled', { machineId: peer.machineId, error: (error as Error).message })))
        .catch(() => { /* not answering is what its status shows */ })
        .finally(() => this.helloInFlight.delete(peer.machineId))
    }
  }

  /** Any request wakes a machine that sleeps, so it hears from this one only while it is up anyway, or now and then
   * while someone uses this one. What is sent to it on purpose, such as messages, goes regardless. */
  private helloDue(peer: PeerRow, now: number): boolean {
    if (!peer.hello?.sleeps) return true
    const sleeper = { lastHelloFromAt: this.lastHelloFromAt.get(peer.machineId) ?? null, heldAwake: peer.hello.heldAwake, lastVisitAt: this.lastVisitAt.get(peer.machineId) ?? null }
    const due = helloToSleeperDue(sleeper, this.config.inUse(), now)
    if (due === 'visit') this.lastVisitAt.set(peer.machineId, now)
    return due !== 'none'
  }

  /** Its agents, asked for after a hello, unless what it said makes them two machines that can't work together. */
  private async refreshCopiesFrom(machineId: string): Promise<void> {
    const peer = this.config.store.peerById(machineId)
    if (!peer || incompatibilityOf(peer) !== null) return
    const answer = PeerAgentList.parse(await this.signed(peer, 'POST', '/agents', {}))
    this.config.commit(() => {
      this.refreshCopies(peer, answer.agents)
      this.refreshClaudePlan(peer, answer.claudePlan)
    })
  }

  /** Its memory, now and then after a hello, from a peer this machine trusts fully. That peer checks the same of this one. */
  private async pullMemoryIfDue(machineId: string): Promise<void> {
    const peer = this.config.store.peerById(machineId)
    const now = this.config.now()
    if (!peer || !sharesMemoryWith(peer, this.homeNetwork()) || (peer.hello?.protocol ?? 0) < PEER_MEMORY_PROTOCOL) return
    if (now - (this.lastMemoryPullAt.get(machineId) ?? 0) < this.config.memoryPullIntervalMs) return
    this.lastMemoryPullAt.set(machineId, now)
    const request: PeerMemoryRequest = { projectKeys: this.config.memoryProjectKeys() }
    const answer = PeerMemory.parse(await this.signed(peer, 'POST', '/memory', request))
    this.config.memoryFromPeer(peer, answer)
  }

  /** A page of an agent's log, read from its computer at once. Only a computer that trusts this one fully shows it. */
  async remoteLog(remoteAgentId: string, position: { after: number | null; before: number | null }): Promise<LogPage> {
    const copy = this.remoteAgentById(remoteAgentId)
    if (!copy) throw new CommandRefused('not_found', 'no such agent on another computer')
    const peer = this.requireWorkingPeer(copy.computerId)
    if (copy.details === null) throw new CommandRefused('forbidden', `${peer.name} trusts this computer only to message its agents`)
    if ((peer.hello?.protocol ?? 0) < PEER_LOG_PROTOCOL) throw new CommandRefused('peer_incompatible', `${peer.name} needs an update before its agents' logs can be read here`)
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/log', { agentName: copy.name, ...position } satisfies PeerLogRequest)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    return LogPageSchema.parse(answer)
  }

  receiveLogRequest(_peer: PeerRow, body: unknown): LogPage {
    const request = PeerLogRequest.safeParse(body)
    if (!request.success) throw new PeerRequestRefused('invalid_request', 'not a log request')
    const page = this.config.logForPeer(request.data)
    if (!page) throw new PeerRequestRefused('not_found', `no agent named ${request.data.agentName} here`)
    return page
  }

  receiveMemoryRequest(peer: PeerRow, body: unknown): PeerMemory {
    const request = PeerMemoryRequest.safeParse(body)
    if (!request.success) throw new PeerRequestRefused('invalid_request', 'not a memory request')
    return this.config.memoryForPeer(peer, request.data.projectKeys)
  }

  /** Work a peer brings must not be taken while this host could pause under it. */
  private async requireHoldForWork(): Promise<void> {
    if (!(await this.config.holdForWork())) throw new PeerRequestRefused('host_hold_refused', `${this.config.machineName} couldn't stay awake for it; try again`)
  }

  // Across the firewall: what a private server asks of a shared network it holds an extra key for

  /** The shared server a private one pulls from or pushes memory to: it must visit that server's network from a private
   * home, and the server must speak networks. */
  private requireSharedFromPrivate(machineId: string, what: string): PeerRow {
    const peer = this.requireWorkingPeer(machineId)
    const home = this.homeNetwork()
    const signing = this.signingFor(peer)
    if (home?.kind !== 'private' || signing.kind !== 'keyed' || !signing.visiting) throw new CommandRefused('forbidden', `${what} only from a private server, from a shared network it holds a key for, and ${peer.name} isn't one`)
    if ((peer.hello?.protocol ?? 0) < PEER_NETWORKS_PROTOCOL) throw new CommandRefused('peer_incompatible', `${peer.name} needs an update first`)
    return peer
  }

  /** A copy of an agent in a shared network, asked for at once. */
  async pull(remoteAgentId: string): Promise<{ peer: PeerRow; copy: PeerMove }> {
    const remote = this.remoteAgentById(remoteAgentId)
    if (!remote) throw new CommandRefused('not_found', 'no such agent on another computer')
    const peer = this.requireSharedFromPrivate(remote.computerId, 'agents are pulled')
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/pull', { agentName: remote.name } satisfies PeerPullRequest, MOVE_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused(error.code === 'not_found' ? 'not_found' : 'forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    // The other server picks what it answers: only the agent asked for is taken, so the name it writes into the copy's
    // label and first note is the one already shown here.
    const copy = PeerMove.safeParse(answer)
    if (!copy.success) throw new CommandRefused('invalid_request', `${peer.name} answered with something that isn't an agent`)
    if (copy.data.agent.name !== remote.name) throw new CommandRefused('forbidden', `${peer.name} answered with another agent than ${remote.name}`)
    return { peer, copy: copy.data }
  }

  /** Only a shared server gives copies, and only to a server in its network: never a private one, nor before networks
   * (see peerMay). */
  receivePull(_peer: PeerRow, body: unknown): PeerMove {
    const request = PeerPullRequest.safeParse(body)
    if (!request.success) throw new PeerRequestRefused('invalid_request', 'not a pull')
    const copy = this.config.pullForPeer(request.data.agentName)
    if (!copy) throw new PeerRequestRefused('not_found', `no agent named ${request.data.agentName} here`)
    return copy
  }

  /** A project's shared notes, sent into a shared network at once. */
  async pushMemory(machineId: string, push: PeerMemoryPush): Promise<void> {
    const peer = this.requireSharedFromPrivate(machineId, 'memory is pushed')
    try {
      await this.signed(peer, 'POST', '/memory-push', push)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
  }

  /** Memory comes into a shared network only when pushed; a private server takes none this way. */
  receiveMemoryPush(peer: PeerRow, body: unknown): Record<string, never> {
    const push = PeerMemoryPush.safeParse(body)
    if (!push.success) throw new PeerRequestRefused('invalid_request', 'not a memory push')
    this.config.memoryPushFromPeer(peer, push.data)
    return {}
  }

  // Its agents, both ways

  receiveAgentsRequest(peer: PeerRow): PeerAgentList {
    const home = this.homeNetwork()
    return { agents: this.config.agentCards(showsAgentDetailsTo(peer, home) ? 'full' : 'limited'), claudePlan: sharesMemoryWith(peer, home) ? this.config.claudePlan() : null }
  }

  /** Only a computer this one trusts fully is believed about the plan. */
  private refreshClaudePlan(peer: PeerRow, told: PeerClaudePlan | null): void {
    const counted = sharesMemoryWith(peer, this.homeNetwork()) ? told : null
    const before = this.claudePlans.get(peer.machineId) ?? null
    if (JSON.stringify(before) === JSON.stringify(counted)) return
    if (counted === null) this.claudePlans.delete(peer.machineId)
    else this.claudePlans.set(peer.machineId, counted)
    this.config.peerClaudePlanChanged()
  }

  /** Claude's plan as every computer this one trusts fully told it, on whatever login. */
  peersClaudePlans(): PeerClaudePlan[] {
    return [...this.claudePlans.values()]
  }

  private refreshCopies(peer: PeerRow, cards: PeerAgentCard[]): void {
    const before = this.copies.get(peer.machineId) ?? new Map<string, RemoteAgentEntity>()
    const after = new Map<string, RemoteAgentEntity>()
    const now = this.config.now()
    for (const card of cards) {
      const id = `${peer.machineId}:${card.name}`
      const previous = before.get(card.name)
      const same = previous !== undefined && previous.activity === card.activity && JSON.stringify(previous.details) === JSON.stringify(card.details)
      after.set(card.name, same ? previous : { id, computerId: peer.machineId, name: card.name, address: `${card.name}@${peer.name}`, activity: card.activity, details: card.details, refreshedAt: now })
      if (!same) this.config.store.markChanged('remote_agent', id)
    }
    for (const [name, gone] of before) if (!after.has(name)) this.config.store.markDeleted('remote_agent', gone.id)
    this.copies.set(peer.machineId, after)
  }

  /** Asks the agent's computer to do `action` to it, at once; answers the agent as it is after. Refusals there are
   * refusals here, with the same code and words. */
  async control(remoteAgentId: string, action: RemoteAgentAction, idempotencyKey: string): Promise<{ computerId: string; card: PeerAgentCard }> {
    const copy = this.remoteAgentById(remoteAgentId)
    if (!copy) throw new CommandRefused('not_found', 'no such agent on another computer')
    const peer = this.requireWorkingPeer(copy.computerId)
    if (copy.details === null) throw new CommandRefused('forbidden', `${peer.name} trusts this computer only to message its agents`)
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/control', { idempotencyKey, agentName: copy.name, action } satisfies PeerControl)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    const result = PeerControlResult.parse(answer)
    if (result.outcome === 'refused') throw new CommandRefused(result.code, `${peer.name}: ${result.message}`)
    return { computerId: peer.machineId, card: result.agent }
  }

  /** An agent as its computer just answered for it, after a control or a create: shown here at once rather than at the
   * next refresh. */
  noteAnswered(computerId: string, card: PeerAgentCard): RemoteAgentEntity {
    const peer = this.requirePeer(computerId)
    const copies = this.copies.get(computerId) ?? new Map<string, RemoteAgentEntity>()
    const entity: RemoteAgentEntity = { id: `${computerId}:${card.name}`, computerId, name: card.name, address: `${card.name}@${peer.name}`, activity: card.activity, details: card.details, refreshedAt: this.config.now() }
    copies.set(card.name, entity)
    this.copies.set(computerId, copies)
    this.config.store.markChanged('remote_agent', entity.id)
    return entity
  }

  /** Asks that computer to start an agent, at once; answers the agent as it is there. Refusals there are refusals here,
   * with the same code and words. */
  async createRemote(machineId: string, from: PeerSender, request: Omit<PeerCreateAgent, 'idempotencyKey' | 'from'>, idempotencyKey: string): Promise<{ computerId: string; card: PeerAgentCard }> {
    const peer = this.requireWorkingPeer(machineId)
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/create-agent', { ...request, idempotencyKey, from } satisfies PeerCreateAgent, CREATE_AGENT_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    const result = PeerCreateAgentResult.parse(answer)
    if (result.outcome === 'refused') throw new CommandRefused(result.code, `${peer.name}: ${result.message}`)
    return { computerId: peer.machineId, card: result.agent }
  }

  async receiveCreateAgent(peer: PeerRow, body: unknown): Promise<PeerCreateAgentResult> {
    const request = PeerCreateAgent.safeParse(body)
    if (!request.success) throw new PeerRequestRefused('invalid_request', 'not a create')
    await this.requireHoldForWork()
    return this.config.createAgentFromPeer(peer, request.data)
  }

  /** Snoozes, at its computer, the ask a copy here is of; answers the snooze it has there now. Refusals there are refusals
   * here, with the same code and words. */
  async snoozeRemoteAsk(computerId: string, request: PeerAskSnooze): Promise<PeerAskSnooze['snooze']> {
    const peer = this.requireWorkingPeer(computerId)
    if ((peer.hello?.protocol ?? 0) < PEER_ASK_SNOOZE_PROTOCOL) throw new CommandRefused('peer_incompatible', `${peer.name} needs an update before its questions can be snoozed here`)
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/owner-ask-snoozes', request)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    const result = PeerAskSnoozeResult.parse(answer)
    if (result.outcome === 'refused') throw new CommandRefused(result.code, `${peer.name}: ${result.message}`)
    return result.snooze
  }

  /** A computer of the person's, that they talk to the agent from, may snooze its asks, as it may answer them. */
  receiveAskSnooze(peer: PeerRow, body: unknown): PeerAskSnoozeResult {
    const snooze = PeerAskSnooze.safeParse(body)
    if (!snooze.success) throw new PeerRequestRefused('invalid_request', 'not an ask snooze')
    return this.config.askSnoozeFromPeer(peer, snooze.data)
  }

  receiveControl(peer: PeerRow, body: unknown): PeerControlResult {
    const control = PeerControl.safeParse(body)
    if (!control.success) throw new PeerRequestRefused('invalid_request', 'not a control')
    return this.config.controlFromPeer(peer, control.data)
  }

  // Moves

  /** Whether that computer would take an agent of this name now: refused here at once if it can't be asked. */
  async checkMove(machineId: string, name: string): Promise<void> {
    const peer = this.requireWorkingPeer(machineId)
    // Only where this server would take an agent from: the person's own computers.
    const may = peerMay('move', peer, this.homeNetwork())
    if (may.kind === 'refused') throw new CommandRefused('forbidden', `agents don't move to ${peer.name}: ${may.reason}`)
    let answer: unknown
    try {
      answer = await this.signed(peer, 'POST', '/move-check', { name } satisfies PeerMoveCheck)
    } catch (error) {
      if (error instanceof PeerUnreachable) throw new CommandRefused('peer_unreachable', `${peer.name} can't be reached: ${error.message}`)
      if (error instanceof PeerRefused) throw new CommandRefused('forbidden', `${peer.name} refused: ${error.message}`)
      throw error
    }
    const result = PeerMoveCheckResult.parse(answer)
    if (result.outcome === 'refused') throw new CommandRefused('forbidden', `${peer.name}: ${result.reason}`)
  }

  /** Hands an agent over, answering whether the other computer took it, certainly didn't, or may have. */
  async handOver(peer: PeerRow, move: PeerMove): Promise<HandoverOutcome> {
    try {
      const result = PeerMoveResult.parse(await this.signed(peer, 'POST', '/move', move, MOVE_TIMEOUT_MS))
      return result.outcome === 'taken' ? { kind: 'taken', address: result.address } : { kind: 'not_taken', why: `${peer.name} refused: ${result.reason}` }
    } catch (error) {
      if (error instanceof PeerUnreachable) return error.mayHaveArrived ? { kind: 'unknown', why: error.message } : { kind: 'not_taken', why: `${peer.name} can't be reached: ${error.message}` }
      // An internal failure there may have come after it was taken.
      if (error instanceof PeerRefused) return error.code === 'internal' ? { kind: 'unknown', why: error.message } : { kind: 'not_taken', why: `${peer.name} refused: ${error.message}` }
      return { kind: 'unknown', why: (error as Error).message }
    }
  }

  receiveMoveCheck(peer: PeerRow, body: unknown): PeerMoveCheckResult {
    const check = PeerMoveCheck.safeParse(body)
    if (!check.success) throw new PeerRequestRefused('invalid_request', 'not a move check')
    return this.config.moveCheckFromPeer(peer, check.data)
  }

  async receiveMove(peer: PeerRow, body: unknown): Promise<PeerMoveResult> {
    const move = PeerMove.safeParse(body)
    if (!move.success) throw new PeerRequestRefused('invalid_request', 'not a move')
    await this.requireHoldForWork()
    return this.config.moveFromPeer(peer, move.data)
  }

  remoteAgents(): RemoteAgentEntity[] {
    return [...this.copies.values()].flatMap((agents) => [...agents.values()])
  }

  remoteAgentById(id: string): RemoteAgentEntity | null {
    for (const agents of this.copies.values()) for (const agent of agents.values()) if (agent.id === id) return agent
    return null
  }

  // Messages

  /** The oldest request waiting for a machine, once it is due; one at a time, so they arrive in order. */
  private sendNextQueued(peer: PeerRow, now: number, signing: Signing): void {
    // Waiting messages stay queued, in order, until one of the two is updated.
    if (this.sendInFlight.has(peer.machineId) || incompatibilityOf(peer) !== null) return
    const head = this.config.store.headOfPeerOutbox(peer.machineId)
    if (!head || head.nextAttemptAt > now) return
    // Nothing goes to a server this one never contacts: what was queued before is undeliverable, one by one.
    if (signing.kind === 'never') {
      this.config.commit(() => this.config.store.settlePeerOutbox(head.seq, { state: 'undeliverable', at: now, reason: signing.reason }))
      return
    }
    this.sendInFlight.add(peer.machineId)
    this.signed(peer, 'POST', head.request.route, head.request.body)
      .then((answer) => {
        const result = PeerMessageResult.parse(answer)
        const at = this.config.now()
        this.config.commit(() => this.config.store.settlePeerOutbox(head.seq, result.outcome === 'accepted' ? { state: 'accepted', at } : { state: 'undeliverable', at, reason: result.reason }))
      })
      .catch((error: unknown) => {
        // Not answering, or refusing for now: tried again later, in the same place in the queue.
        this.config.commit(() => this.config.store.notePeerOutboxAttemptFailed(head.seq, this.config.now() + peerRetryDelayMs(head.attempts + 1)))
        this.config.log('peer_message_not_taken', { machineId: peer.machineId, messageId: head.messageId, error: (error as Error).message })
      })
      .finally(() => this.sendInFlight.delete(peer.machineId))
  }

  /** A message from a peer. Taken at most once, by its id, however often it is sent. */
  async receiveMessage(peer: PeerRow, body: unknown): Promise<PeerMessageResult> {
    const message = PeerMessage.safeParse(body)
    if (!message.success) throw new PeerRequestRefused('invalid_request', 'not a message')
    // An FYI waits for the next real message; it doesn't keep this host awake.
    if (message.data.wake === 'wake') await this.requireHoldForWork()
    return this.config.commit(() => this.config.deliverFromPeer(peer, message.data))
  }

  async receiveGroupUpdate(peer: PeerRow, body: unknown): Promise<PeerMessageResult> {
    const update = PeerGroupUpdate.safeParse(body)
    if (!update.success) throw new PeerRequestRefused('invalid_request', 'not a group update')
    if (update.data.post !== null && update.data.recipients.some((recipient) => recipient.wake === 'wake')) await this.requireHoldForWork()
    return this.config.commit(() => this.config.groupUpdateFromPeer(peer, update.data))
  }

  /** Wakes no agent: it is for the person, so it brings no work. */
  receiveOwnerMessage(peer: PeerRow, body: unknown): PeerMessageResult {
    const message = PeerOwnerMessage.safeParse(body)
    if (!message.success) throw new PeerRequestRefused('invalid_request', 'not a message to the person')
    return this.config.commit(() => this.config.ownerMessageFromPeer(peer, message.data))
  }

  /** Wakes no agent, as an owner message doesn't. */
  receiveOwnerAsk(peer: PeerRow, body: unknown): PeerMessageResult {
    const ask = PeerOwnerAsk.safeParse(body)
    if (!ask.success) throw new PeerRequestRefused('invalid_request', 'not an ask to the person')
    return this.config.commit(() => this.config.ownerAskFromPeer(peer, ask.data))
  }

  async receiveGroupPost(peer: PeerRow, body: unknown): Promise<PeerMessageResult> {
    const post = PeerGroupPost.safeParse(body)
    if (!post.success) throw new PeerRequestRefused('invalid_request', 'not a group post')
    await this.requireHoldForWork()
    return this.config.commit(() => this.config.groupPostFromPeer(peer, post.data))
  }

  /** A request to a peer, signed by this machine and in the peer's network. Refused here, at once, if this server never
   * contacts it. */
  private async signed(peer: PeerRow, method: string, route: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    const signing = this.signingFor(peer)
    if (signing.kind === 'never') throw new PeerRefused('forbidden', signing.reason)
    return peerRequest(peer.address, method, route, body, { key: this.config.key, machineId: this.config.machineId, network: this.networkSigner(signing, peer.machineId) }, this.config.now(), timeoutMs)
  }

  // Trust and removal

  requirePeer(machineId: string): PeerRow {
    const peer = this.config.store.peerById(machineId)
    if (!peer) throw new CommandRefused('not_found', 'no such computer')
    return peer
  }

  setTrust(machineId: string, trust: ComputerTrust): ComputerEntity {
    if (this.config.store.homeNetwork()) throw new CommandRefused('invalid_request', 'inside a network every server is trusted fully: trust is set by which keys a server holds')
    this.requirePeer(machineId)
    this.config.store.setPeerTrust(machineId, trust)
    return this.entityOf(this.requirePeer(machineId))
  }

  /** Before removing a peer: it is told, if it answers. Either way it is removed here after. */
  async tellOfRemoval(machineId: string): Promise<void> {
    const peer = this.config.store.peerById(machineId)
    if (!peer) return
    try {
      await this.signed(peer, 'POST', '/forget', {})
    } catch (error) {
      this.config.log('peer_not_told_of_removal', { machineId, error: (error as Error).message })
    }
  }

  /**
   * Stops reaching it. Nothing on it is deleted. A computer in a network is kept out of it here from now on: another
   * server's hello doesn't add it back, and it can't introduce itself again, until it is invited again. It still holds the
   * network's key, so it can still reach the others: out of the network for good takes a new key.
   */
  remove(machineId: string): void {
    const peer = this.requirePeer(machineId)
    if (peer.networkId !== null) this.config.store.noteRemovedFromNetwork(peer.networkId, machineId, this.config.now())
    this.forget(machineId)
  }

  /** A network's key let go of: the computers in it are forgotten here, as they can't be reached without it. */
  forgetNetwork(networkId: string): void {
    for (const peer of this.config.store.listPeers()) if (peer.networkId === networkId) this.forget(peer.machineId)
  }

  /** The peer removed this machine. */
  receiveForget(peer: PeerRow): void {
    this.config.commit(() => this.forget(peer.machineId))
  }

  private forget(machineId: string): void {
    for (const copy of this.copies.get(machineId)?.values() ?? []) this.config.store.markDeleted('remote_agent', copy.id)
    this.copies.delete(machineId)
    if (this.claudePlans.delete(machineId)) this.config.peerClaudePlanChanged()
    const peer = this.config.store.peerById(machineId)
    if (peer) this.config.store.abandonPeerOutbox(machineId, `${peer.name} was removed from this computer`, this.config.now())
    // Its agents are out of reach now, so pins of them would stay hidden for good.
    if (peer) for (const { personId, pin } of this.config.store.pinsOfAgentsOn(peer.name)) this.config.store.deletePin(personId, pin.id)
    this.config.store.deletePeer(machineId)
    this.reportedStatus.delete(machineId)
    this.lastHelloSentAt.delete(machineId)
  }
}
