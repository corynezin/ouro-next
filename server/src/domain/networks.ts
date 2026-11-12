// Networks: which requests a server accepts, which network it signs each request in, and who a person arriving from
// another server is. A network is a secret key. A server accepts only what is signed with its home key, and signs into
// another network only with an extra key it holds; a server with no home key works as before networks. Pure.
import { AGENT_NAME_PATTERN, OWNER_ADDRESS, personAddress } from '@ouro/contract'
import type { NetworkKind, NetworkRole } from '@ouro/contract'

/** A network this server holds a key for, without the key. */
export interface HeldNetwork { id: string; kind: NetworkKind; role: NetworkRole }

/** What this server keeps about another, as far as networks go. */
export interface PeerPlace {
  name: string
  /** The network it lives in, of this server's; null: none of them. */
  networkId: string | null
  visiting: boolean
  /** A full trust link from before networks that hasn't yet signed with a network's key. */
  unkeyedAllowed: boolean
  ownerName: string | null
}

/** What a request says about its network, and whether its network signature checks out with this server's home key. */
export interface ClaimedNetwork { networkId: string; visiting: boolean; signatureValid: boolean }

export type Acceptance =
  | { kind: 'accepted'; network: { id: string; visiting: boolean } | null }
  | { kind: 'refused'; reason: string }

/**
 * Whether a request whose machine signature checks out is accepted. Without a home key, everything is, as before networks.
 * With one, only what is signed with it, except, in a private network, a link from before networks that has never signed
 * with a key: it is how the person's computers that run older releases keep working until they have the key too. Once it
 * has signed, it can't go back.
 */
export function acceptance(home: HeldNetwork | null, claimed: ClaimedNetwork | null, peer: PeerPlace | null): Acceptance {
  if (home === null) return { kind: 'accepted', network: null }
  if (claimed !== null) {
    if (claimed.networkId !== home.id) return { kind: 'refused', reason: "the request isn't signed in this server's network" }
    if (!claimed.signatureValid) return { kind: 'refused', reason: "the network signature doesn't match" }
    return { kind: 'accepted', network: { id: home.id, visiting: claimed.visiting } }
  }
  if (home.kind === 'private' && peer !== null && peer.unkeyedAllowed && peer.networkId === home.id) return { kind: 'accepted', network: null }
  return { kind: 'refused', reason: "this server takes only requests signed with its network's key" }
}

export type Signing =
  /** Signed in that network. `visiting`: with an extra key. */
  | { kind: 'keyed'; networkId: string; visiting: boolean }
  /** As before networks: this server has no home key. */
  | { kind: 'unkeyed' }
  /** Not contacted at all, for this reason, fit to show. */
  | { kind: 'never'; reason: string }

/** How this server signs what it sends to a peer, if it sends it anything. A visitor is answered, never contacted. */
export function signingFor(peer: PeerPlace, networks: readonly HeldNetwork[]): Signing {
  const home = networks.find((network) => network.role === 'home') ?? null
  if (home === null) return { kind: 'unkeyed' }
  if (peer.visiting) return { kind: 'never', reason: `${peer.name} is outside this network: it can reach this server, but nothing is sent to it from here` }
  if (peer.networkId === home.id) return { kind: 'keyed', networkId: home.id, visiting: false }
  const extra = peer.networkId === null ? undefined : networks.find((network) => network.id === peer.networkId && network.role === 'extra')
  if (extra) return { kind: 'keyed', networkId: extra.id, visiting: true }
  return { kind: 'never', reason: `${peer.name} is outside this server's networks` }
}

/**
 * Who the owner of another server is here. In a private network, and before networks, it is this server's own owner, the
 * same person on each of their computers. In a shared network it is a person of their own, never this server's `human`,
 * and who they are is their server, by its machine id: `kept` is the address already kept for that machine, which stays
 * theirs whatever their server says later. A first time, the name their server gives them is only a label: one that isn't
 * a name (see AGENT_NAME_PATTERN), or that `taken` says is someone's here (this server's owner, a person invited here, or
 * another server's owner), gives way to the server's own name, and then to that name with part of its machine id.
 */
export function ownerAddressFrom(peer: PeerPlace & { machineId: string }, home: HeldNetwork | null, kept: string | null, taken: (name: string) => boolean): string {
  if (home === null || home.kind === 'private') return OWNER_ADDRESS
  if (kept !== null) return kept
  const machine = peer.machineId.replace(/[^A-Za-z0-9]/g, '').slice(0, MACHINE_ID_LABEL_LENGTH)
  const candidates = [peer.ownerName, peer.name, `${peer.name}-${machine}`, `server-${machine}`]
  const free = candidates.find((name): name is string => name !== null && AGENT_NAME_PATTERN.test(name) && !taken(name))
  return personAddress(free ?? `server-${peer.machineId}`)
}

/** Enough of a machine id to tell two servers of the same name apart in a person's label. */
const MACHINE_ID_LABEL_LENGTH = 8

/**
 * Why this server can't hold a network's key as `role`, or null. A private network has no visitors: its servers share
 * memory, so each holds its key as its home. An extra key is for reaching out from a home, so it needs one.
 */
export function holdingRefusal(network: { kind: NetworkKind; role: NetworkRole }, home: HeldNetwork | null): string | null {
  if (network.kind === 'private' && network.role === 'extra') return 'a private network is joined only as a home: its servers share memory, so none of them only visits'
  if (network.role === 'extra' && home === null) return 'a server needs a home network before it holds extra keys'
  return null
}

/**
 * Why a join is refused because the network isn't the kind the person expects, or null. The inviting server says what
 * its network is; an invite described as "our team's" that is really a private network would make the joiner's owner and
 * the inviter's one person, with each other's memory. Checked by the inviter before its invite is used, and by the joiner.
 */
export function joinedKindRefusal(expected: NetworkKind, actual: NetworkKind): string | null {
  if (expected === actual) return null
  return expected === 'shared'
    ? 'that invite is into a private network: joining it would make you and its owner one person, with each other\'s memory. Join it only if it is your own, as a private network'
    : 'that invite is into a shared network, not a private one'
}

/** Memory is kept the same automatically only between the person's own computers: before networks, as fully trusted
 * peers did, or in a private home network between servers that live in it. The same rule as pulling it (see peerMay). */
export function sharesMemoryWith(peer: { trust: 'full' | 'limited'; networkId: string | null; visiting: boolean }, home: HeldNetwork | null): boolean {
  return peerMay('pull_memory', peer, home).kind === 'allowed'
}

/**
 * What another server may ask of this one, one action per signed peer route (see WORKING_ROUTES in interfaces/peer.ts):
 * - `see_agents`: list this server's agents (/agents).
 * - `message`: messages to its agents, and the person's chats with them copied both ways (/messages, /owner-messages,
 *   /owner-asks).
 * - `group`: group posts and updates (/group-posts, /group-updates).
 * - `snooze_ask`: snooze a question one of its agents asked this server's owner (/owner-ask-snoozes).
 * - `pull_memory`: read this server's memory, notes about the person included (/memory).
 * - `pull`: a copy of one of its agents, which arrives paused elsewhere (/pull).
 * - `push_memory`: add a project's shared notes to its memory (/memory-push).
 * - `control`: stop, interrupt, archive or change the model of its agents, as its owner would (/control).
 * - `create_agent`: start an agent on it (/create-agent).
 * - `move`: hand it an agent to run, or ask whether it would take one (/move-check, /move).
 * - `read_log`: read its agents' logs (/log).
 */
export type PeerAction =
  | 'see_agents'
  | 'message'
  | 'group'
  | 'snooze_ask'
  | 'pull_memory'
  | 'pull'
  | 'push_memory'
  | 'control'
  | 'create_agent'
  | 'move'
  | 'read_log'

export type PeerPermission = { kind: 'allowed' } | { kind: 'refused'; reason: string }

const ALLOWED: PeerPermission = { kind: 'allowed' }

/**
 * Whether a peer, whose request was accepted (see acceptance), may do `action` here. Deny by default: every action is
 * named, and a new one must be placed below before any route can carry it.
 *
 * Before networks, a peer is trusted fully (everything a local person may do) or only to message. In a private home
 * network every server is the person's own, and may do everything; only a private network's members share memory. In a
 * shared network the others are other people: they and visitors may see agents, talk with them, pull copies and push
 * project notes, but never act on this server's agents as its owner, start or move agents onto it, read its logs or its
 * memory, or touch its owner's questions.
 */
export function peerMay(action: PeerAction, peer: { trust: 'full' | 'limited'; networkId: string | null; visiting: boolean }, home: HeldNetwork | null): PeerPermission {
  const ownersOnly = (what: string): PeerPermission => ({ kind: 'refused', reason: `${what} only for its owner's own computers` })
  if (home === null) {
    switch (action) {
      case 'see_agents':
      case 'message':
      case 'group':
      case 'snooze_ask':
        return ALLOWED
      case 'pull':
      case 'push_memory':
        return { kind: 'refused', reason: 'copies and pushed notes go only within a shared network' }
      case 'pull_memory':
      case 'control':
      case 'create_agent':
      case 'move':
      case 'read_log':
        return peer.trust === 'full' ? ALLOWED : { kind: 'refused', reason: 'this computer is trusted only to message its agents' }
    }
  }
  if (home.kind === 'private') {
    switch (action) {
      case 'pull':
      case 'push_memory':
        return { kind: 'refused', reason: 'a private server gives no copies and takes no pushed notes: only a shared server does' }
      case 'see_agents':
      case 'message':
      case 'group':
      case 'snooze_ask':
      case 'pull_memory':
      case 'control':
      case 'create_agent':
      case 'move':
      case 'read_log':
        // A private network has no visitors (see holdingRefusal); one saying it visits is not one of the person's own.
        return peer.networkId === home.id && !peer.visiting ? ALLOWED : ownersOnly('this is done')
    }
  }
  switch (action) {
    case 'see_agents':
    case 'message':
    case 'group':
    case 'pull':
    case 'push_memory':
      return peer.networkId === home.id ? ALLOWED : { kind: 'refused', reason: "the computer is outside this server's network" }
    case 'snooze_ask':
      return { kind: 'refused', reason: "another person can't snooze this server owner's questions" }
    case 'pull_memory':
      return ownersOnly('memory is shared')
    case 'control':
      return ownersOnly("agents are controlled from another computer")
    case 'create_agent':
      return ownersOnly('agents are started from another computer')
    case 'move':
      return ownersOnly('agents are moved in')
    case 'read_log':
      return ownersOnly("agents' logs are shown")
  }
}

/** Whether this server's agents are shown to a peer with their details (task, model, state, summary), or only by name
 * and running or not: before networks, by its trust; inside a network, to every server that may see them at all. */
export function showsAgentDetailsTo(peer: { trust: 'full' | 'limited' }, home: HeldNetwork | null): boolean {
  return home !== null || peer.trust === 'full'
}
