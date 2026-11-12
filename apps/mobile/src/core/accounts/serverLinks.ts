// Linking two saved servers as each other's computers, decided here; appCore does the asking.
import type { ComputerEntity, ComputerInvite } from '@ouro/contract'
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
