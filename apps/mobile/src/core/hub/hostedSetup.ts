// Setting up a hosted server ends with this phone paired with it and connected to it: no code is shown.
import type { HostedServer } from '@ouro/contract'
import type { HostedAccount } from '../accounts/hostedAccount.ts'
import type { AfterPairing } from '../accounts/serverLinks.ts'
import type { AppCore } from '../appCore.ts'
import type { HubApi, HubResult } from './hubApi.ts'
import { primaryOf, SetupFlow } from './setupFlow.ts'

/** Where the server being set up comes from: the hosted hub, or the open server (Servers → New server on AWS or Sprites). */
export type SetupOrigin = 'hub' | 'made_here'

/**
 * How the phone keeps the server once paired. A hosted one keeps its hub id. One made here was just asked for by the
 * person from this app, so it is linked with their other servers; nothing else links by itself (see AfterPairing).
 */
export function pairingDetails(origin: SetupOrigin, server: HostedServer): { label: string; hostedServerId?: string; afterPairing: AfterPairing } {
  switch (origin) {
    case 'hub': return { label: server.label, hostedServerId: server.id, afterPairing: 'nothing' }
    case 'made_here': return { label: server.label, afterPairing: 'link_with_other_servers' }
  }
}

function hostedSetup(core: AppCore, read: () => Promise<HubResult<HostedServer | null>>, onChange: () => void, origin: SetupOrigin): SetupFlow {
  return new SetupFlow({
    clock: core.deps.clock,
    read,
    pair: async (address, code, server) => { await core.pairAndActivate(address, code, pairingDetails(origin, server)) },
    onChange,
  })
}

/** After sign-up: the account's primary server, made with it. */
export function firstServerSetup(core: AppCore, hub: HubApi, account: HostedAccount, onChange: () => void): SetupFlow {
  return hostedSetup(core, async () => {
    const listed = await hub.listServers(account.token)
    return listed.ok ? { ok: true, value: primaryOf(listed.value.servers) } : listed
  }, onChange, 'hub')
}

/** A server made later from Servers, or one made earlier that this phone isn't paired with yet. */
export function hostedServerSetup(core: AppCore, hub: HubApi, account: HostedAccount, serverId: string, onChange: () => void): SetupFlow {
  return hostedSetup(core, () => hub.getServer(account.token, serverId), onChange, 'hub')
}

/**
 * A server the open server makes on a cloud account (Servers → New server → AWS or Sprite), read from the open server as
 * a hosted one is from the hub. Paired, this phone links it with the person's other servers.
 */
export function machineServerSetup(core: AppCore, read: () => Promise<HubResult<HostedServer>>, onChange: () => void): SetupFlow {
  return hostedSetup(core, read, onChange, 'made_here')
}
