// Linking two saved servers as each other's computers, decided here; appCore does the asking.
import type { ComputerEntity, ComputerInvite, NetworkEntity } from '@ouro/contract'
import { sameServerUrl } from './savedServers.ts'
import type { SavedServer } from './savedServers.ts'

/**
 * Where a join goes, from an invite. A server sends its address beside the code; one from before that sends only the
 * command for people (`ouro computers join <address> <code>`), which is read only then. Null when neither says.
 */
export function inviteTarget(invite: ComputerInvite): { address: string; code: string } | null {
  if (invite.address) return { address: invite.address, code: invite.code }
  const [address, code] = invite.command.trim().split(/\s+/).slice(-2)
  return address?.startsWith('https://') || address?.startsWith('http://') ? { address, code: code ?? invite.code } : null
}

/**
 * What happens once this phone pairs with a server. Only a server the person just made from this app is linked with the
 * other saved servers: a join grants full trust both ways, so any other pairing leaves that to the person (Servers shows
 * Not linked, with Link).
 */
export type AfterPairing = 'link_with_other_servers' | 'nothing'

/** The saved servers `added` isn't linked with yet, by the addresses of the computers it has. */
export function serversToLink(added: SavedServer, saved: readonly SavedServer[], addedComputers: readonly ComputerEntity[]): SavedServer[] {
  const linked = addedComputers.flatMap((computer) => (computer.address ? [computer.address] : []))
  return saved.filter((server) => server.id !== added.id && !linked.some((address) => sameServerUrl(address, server.url)))
}

/**
 * Whether a server just made may link itself with the others by itself: never once the person uses networks, on any
 * saved server, since a link is full trust outside them and a server that goes on to join a shared network would keep a
 * way into the private one. A saved server that can't be read (null) might be in one, so it stops the linking too: it is
 * left to the person, in Servers.
 */
export function mayLinkOutsideNetworks(addedNetworks: readonly NetworkEntity[], othersNetworks: readonly (readonly NetworkEntity[] | null)[]): boolean {
  return addedNetworks.length === 0 && othersNetworks.every((networks) => networks !== null && networks.length === 0)
}
