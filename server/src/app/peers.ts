// The person's other computers: inviting one, joining one, proving each request between them, saying hello, and letting
// go. Each machine keeps the other as a peer, with the key it signs with. Requests between peers are signed; the invite's
// code is the only credential for the one request that isn't, joining.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PEER_ASK_SNOOZE_PROTOCOL, PEER_MEMORY_PROTOCOL, PEER_MIN_PROTOCOL, PeerAskSnooze, PeerAskSnoozeResult, PEER_PROTOCOL, PeerMemory, PeerMemoryRequest, PEER_SIGNATURE_HEADERS, PeerAgentList, PeerControl, PeerControlResult, PeerCreateAgent, PeerCreateAgentResult, PeerGroupPost, PeerGroupUpdate, PeerHello, PeerJoinResult, PeerMessage, PeerMessageResult, PeerMove, PeerOwnerAsk, PeerOwnerMessage, PeerMoveCheck, PeerMoveCheckResult, PeerMoveResult } from '@ouro/contract'
import type { ComputerEntity, ComputerInvite, ComputerStatus, ComputerTrust, PeerAgentCard, PeerClaudePlan, PeerIdentity, PeerJoinRequest, PeerSender, RemoteAgentAction, RemoteAgentEntity } from '@ouro/contract'
import { PeerRefused, PeerUnreachable, peerRequest, sha256Hex, signatureValid } from '../adapters/peer-transport.ts'
import type { MachineKey } from '../adapters/peer-transport.ts'
import { helloToSleeperDue } from '../domain/host-hold.ts'
import { COMPUTER_INVITE_LIFETIME_MS, computerStatusOf, PEER_CLOCK_SKEW_MS, PEER_HELLO_INTERVAL_MS, peerRetryDelayMs, protocolProblem, signedPayload, withinClockSkew } from '../domain/peers.ts'
import { CommandRefused } from './failure.ts'
import type { PeerRow, Store } from '../store/store.ts'

export interface PeersConfig {
  store: Store
  machineId: string
  machineName: string
  /** Where other machines reach this one's API; null: nobody can, so it can't invite or join. */
  address: string | null
  key: MachineKey
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
  /** Whether an agent of this name could move here now. Changes nothing. */
  moveCheckFromPeer: (peer: PeerRow, check: PeerMoveCheck) => PeerMoveCheckResult
  /** A fully trusted peer hands an agent over. Runs its own transaction. */
  moveFromPeer: (peer: PeerRow, move: PeerMove) => PeerMoveResult
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

  private hello(): PeerHello {
    const { running, total } = this.config.agentCounts()
    return { protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL, release: this.config.release, agentsRunning: running, agentCount: total, sleeps: this.config.hostSleeps, heldAwake: this.config.heldAwake(), ownerPushTokenHashes: this.config.ownerPushTokenHashes() }
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
    }
  }

  list(): ComputerEntity[] {
    return this.config.store.listPeers().map((peer) => this.entityOf(peer))
  }

  // Inviting and joining

  createInvite(): ComputerInvite {
    const address = this.requireAddress()
    const code = randomBytes(16).toString('hex')
    const expiresAt = this.config.now() + COMPUTER_INVITE_LIFETIME_MS
    this.config.store.setMeta(INVITE_HASH_KEY, hashCode(code).toString('hex'))
    this.config.store.setMeta(INVITE_EXPIRES_KEY, String(expiresAt))
    return { code, expiresAt, command: `ouro computers join ${address} ${code}` }
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
      if (!this.takeInvite(request.code)) throw new PeerRequestRefused('invite_invalid', 'That invite is not valid: it was used, replaced, or it expired.')
      this.admit(joiner)
      return { host }
    })
  }

  /** Asks the machine at `address` to take this one in, with an invite it made; answers who it is. Nothing is kept here
   * until `admitHost`. */
  async askToJoin(address: string, code: string): Promise<PeerIdentity> {
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
    if (peer.machineId === this.config.machineId) throw new PeerRequestRefused('invalid_request', 'A computer cannot join itself.')
    if (peer.name === this.config.machineName) throw new PeerRequestRefused('invalid_request', `This computer is called "${peer.name}" too: rename one of them first.`)
    const sameName = this.config.store.peerByName(peer.name)
    if (sameName && sameName.machineId !== peer.machineId) throw new PeerRequestRefused('invalid_request', `Another computer here is called "${peer.name}" already.`)
    const problem = protocolProblem(peer)
    if (problem) throw new PeerRequestRefused('incompatible', problem)
    this.config.store.savePeer({ machineId: peer.machineId, name: peer.name, address: peer.address, publicKey: peer.publicKey, trust: 'full', joinedAt: this.config.now() })
  }

  // Signed requests

  /** The peer a signed request is from, once its signature, time and nonce check out. */
  verify(request: { method: string; path: string; body: string; header: (name: string) => string | undefined }): PeerRow {
    const machineId = request.header(PEER_SIGNATURE_HEADERS.machine)
    const time = request.header(PEER_SIGNATURE_HEADERS.time)
    const nonce = request.header(PEER_SIGNATURE_HEADERS.nonce)
    const signature = request.header(PEER_SIGNATURE_HEADERS.signature)
    if (!machineId || !time || !nonce || !signature) throw new PeerRequestRefused('unauthenticated', 'the request is not signed')
    const peer = this.config.store.peerById(machineId)
    if (!peer) throw new PeerRequestRefused('unauthenticated', 'this server does not know that computer')
    const now = this.config.now()
    if (!withinClockSkew(Number(time), now)) throw new PeerRequestRefused('unauthenticated', 'the request is too far from this server\'s clock')
    let payload: string
    try {
      payload = signedPayload({ method: request.method, path: request.path, bodySha256: sha256Hex(request.body), machineId, time, nonce })
    } catch {
      throw new PeerRequestRefused('unauthenticated', 'the request is not signed')
    }
    if (!signatureValid(peer.publicKey, payload, signature)) throw new PeerRequestRefused('unauthenticated', 'the signature does not match')
    if (!this.freshNonce(machineId, nonce, now)) throw new PeerRequestRefused('unauthenticated', 'the request was replayed')
    return peer
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
    const peer = this.requirePeer(machineId)
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
    this.config.commit(() => this.noteHello(peer.machineId, hello.data))
    return this.hello()
  }

  private noteHello(machineId: string, hello: PeerHello): void {
    const before = this.config.store.peerById(machineId)
    if (!before) return
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
      this.sendNextQueued(peer, now)
      if (this.helloInFlight.has(peer.machineId) || now - (this.lastHelloSentAt.get(peer.machineId) ?? 0) < PEER_HELLO_INTERVAL_MS) continue
      if (!this.helloDue(peer, now)) continue
      this.lastHelloSentAt.set(peer.machineId, now)
      this.helloInFlight.add(peer.machineId)
      this.signed(peer, 'POST', '/hello', this.hello())
        .then((answer) => this.config.commit(() => this.noteHello(peer.machineId, PeerHello.parse(answer))))
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
    if (!peer || peer.trust !== 'full' || (peer.hello?.protocol ?? 0) < PEER_MEMORY_PROTOCOL) return
    if (now - (this.lastMemoryPullAt.get(machineId) ?? 0) < this.config.memoryPullIntervalMs) return
    this.lastMemoryPullAt.set(machineId, now)
    const request: PeerMemoryRequest = { projectKeys: this.config.memoryProjectKeys() }
    const answer = PeerMemory.parse(await this.signed(peer, 'POST', '/memory', request))
    this.config.memoryFromPeer(peer, answer)
  }

  receiveMemoryRequest(peer: PeerRow, body: unknown): PeerMemory {
    if (peer.trust !== 'full') throw new PeerRequestRefused('forbidden', `${this.config.machineName} shares memory only with computers it trusts fully`)
    const request = PeerMemoryRequest.safeParse(body)
    if (!request.success) throw new PeerRequestRefused('invalid_request', 'not a memory request')
    return this.config.memoryForPeer(peer, request.data.projectKeys)
  }

  /** Work a peer brings must not be taken while this host could pause under it. */
  private async requireHoldForWork(): Promise<void> {
    if (!(await this.config.holdForWork())) throw new PeerRequestRefused('host_hold_refused', `${this.config.machineName} couldn't stay awake for it; try again`)
  }

  // Its agents, both ways

  receiveAgentsRequest(peer: PeerRow): PeerAgentList {
    return { agents: this.config.agentCards(peer.trust), claudePlan: peer.trust === 'full' ? this.config.claudePlan() : null }
  }

  /** Only a computer this one trusts fully is believed about the plan. */
  private refreshClaudePlan(peer: PeerRow, told: PeerClaudePlan | null): void {
    const counted = peer.trust === 'full' ? told : null
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
    if (peer.trust !== 'full') throw new PeerRequestRefused('forbidden', `${this.config.machineName} trusts this computer only to message its agents`)
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

  /** Any peer the person talks to the agent from may snooze its asks, as it may answer them. */
  receiveAskSnooze(peer: PeerRow, body: unknown): PeerAskSnoozeResult {
    const snooze = PeerAskSnooze.safeParse(body)
    if (!snooze.success) throw new PeerRequestRefused('invalid_request', 'not an ask snooze')
    return this.config.askSnoozeFromPeer(peer, snooze.data)
  }

  receiveControl(peer: PeerRow, body: unknown): PeerControlResult {
    if (peer.trust !== 'full') throw new PeerRequestRefused('forbidden', `${this.config.machineName} trusts this computer only to message its agents`)
    const control = PeerControl.safeParse(body)
    if (!control.success) throw new PeerRequestRefused('invalid_request', 'not a control')
    return this.config.controlFromPeer(peer, control.data)
  }

  // Moves

  /** Whether that computer would take an agent of this name now: refused here at once if it can't be asked. */
  async checkMove(machineId: string, name: string): Promise<void> {
    const peer = this.requireWorkingPeer(machineId)
    if (peer.trust !== 'full') throw new CommandRefused('forbidden', `agents move only to computers this one trusts fully, and it trusts ${peer.name} only to message`)
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
      const result = PeerMoveResult.parse(await peerRequest(peer.address, 'POST', '/move', move, { key: this.config.key, machineId: this.config.machineId }, this.config.now(), MOVE_TIMEOUT_MS))
      return result.outcome === 'taken' ? { kind: 'taken', address: result.address } : { kind: 'not_taken', why: `${peer.name} refused: ${result.reason}` }
    } catch (error) {
      if (error instanceof PeerUnreachable) return error.mayHaveArrived ? { kind: 'unknown', why: error.message } : { kind: 'not_taken', why: `${peer.name} can't be reached: ${error.message}` }
      // An internal failure there may have come after it was taken.
      if (error instanceof PeerRefused) return error.code === 'internal' ? { kind: 'unknown', why: error.message } : { kind: 'not_taken', why: `${peer.name} refused: ${error.message}` }
      return { kind: 'unknown', why: (error as Error).message }
    }
  }

  receiveMoveCheck(peer: PeerRow, body: unknown): PeerMoveCheckResult {
    if (peer.trust !== 'full') throw new PeerRequestRefused('forbidden', `${this.config.machineName} trusts this computer only to message its agents`)
    const check = PeerMoveCheck.safeParse(body)
    if (!check.success) throw new PeerRequestRefused('invalid_request', 'not a move check')
    return this.config.moveCheckFromPeer(peer, check.data)
  }

  async receiveMove(peer: PeerRow, body: unknown): Promise<PeerMoveResult> {
    if (peer.trust !== 'full') throw new PeerRequestRefused('forbidden', `${this.config.machineName} trusts this computer only to message its agents`)
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
  private sendNextQueued(peer: PeerRow, now: number): void {
    // Waiting messages stay queued, in order, until one of the two is updated.
    if (this.sendInFlight.has(peer.machineId) || incompatibilityOf(peer) !== null) return
    const head = this.config.store.headOfPeerOutbox(peer.machineId)
    if (!head || head.nextAttemptAt > now) return
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

  private signed(peer: PeerRow, method: string, route: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return peerRequest(peer.address, method, route, body, { key: this.config.key, machineId: this.config.machineId }, this.config.now(), timeoutMs)
  }

  // Trust and removal

  requirePeer(machineId: string): PeerRow {
    const peer = this.config.store.peerById(machineId)
    if (!peer) throw new CommandRefused('not_found', 'no such computer')
    return peer
  }

  setTrust(machineId: string, trust: ComputerTrust): ComputerEntity {
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

  /** Stops reaching it. Nothing on it is deleted. */
  remove(machineId: string): void {
    this.requirePeer(machineId)
    this.forget(machineId)
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
    this.config.store.deletePeer(machineId)
    this.reportedStatus.delete(machineId)
    this.lastHelloSentAt.delete(machineId)
  }
}
