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
 * same person on each of their computers. In a shared network it is a person of their own, by the name their server gives
 * them: never this server's `human`, even under the same name, since a name is only what a server says. A name that
 * isn't one (see AGENT_NAME_PATTERN) or that `taken` says is someone else's here is replaced by the server's own name.
 */
export function ownerAddressFrom(peer: PeerPlace, home: HeldNetwork | null, taken: (name: string) => boolean = () => false): string {
  if (home === null || home.kind === 'private') return OWNER_ADDRESS
  const said = peer.ownerName
  return personAddress(said !== null && AGENT_NAME_PATTERN.test(said) && !taken(said) ? said : peer.name)
}

/** Memory is kept the same automatically only between the person's own computers: before networks, as fully trusted
 * peers did, or in a private home network between servers that live in it. */
export function sharesMemoryWith(peer: PeerPlace & { trust: 'full' | 'limited' }, home: HeldNetwork | null): boolean {
  if (home === null) return peer.trust === 'full'
  return home.kind === 'private' && peer.networkId === home.id && !peer.visiting
}

/** Whether this server's agents and their details may be shown to a peer, and it may act on them: before networks, by its
 * trust; inside a network, every server that may reach this one. */
export function fullyTrusted(peer: { trust: 'full' | 'limited' }, home: HeldNetwork | null): boolean {
  return home !== null || peer.trust === 'full'
}
