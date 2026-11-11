// Setting up a hosted server ends with this phone paired with it and connected to it: no code is shown.
import type { HostedServer } from '@ouro/contract'
import type { HostedAccount } from '../accounts/hostedAccount.ts'
import type { AppCore } from '../appCore.ts'
import type { HubApi, HubResult } from './hubApi.ts'
import { primaryOf, SetupFlow } from './setupFlow.ts'

function hostedSetup(core: AppCore, read: () => Promise<HubResult<HostedServer | null>>, onChange: () => void, fromHub = true): SetupFlow {
  return new SetupFlow({
    clock: core.deps.clock,
    read,
    pair: async (address, code, server) => { await core.pairAndActivate(address, code, fromHub ? { label: server.label, hostedServerId: server.id } : { label: server.label }) },
    onChange,
  })
}

/** After sign-up: the account's primary server, made with it. */
export function firstServerSetup(core: AppCore, hub: HubApi, account: HostedAccount, onChange: () => void): SetupFlow {
  return hostedSetup(core, async () => {
    const listed = await hub.listServers(account.token)
    return listed.ok ? { ok: true, value: primaryOf(listed.value.servers) } : listed
  }, onChange)
}

/** A server made later from Servers, or one made earlier that this phone isn't paired with yet. */
export function hostedServerSetup(core: AppCore, hub: HubApi, account: HostedAccount, serverId: string, onChange: () => void): SetupFlow {
  return hostedSetup(core, () => hub.getServer(account.token, serverId), onChange)
}

/**
 * A server the open server makes on a cloud account (Servers → New server → AWS or Sprite), read from the open server as
 * a hosted one is from the hub. Paired, this phone links it with its other servers as any server added is.
 */
export function machineServerSetup(core: AppCore, read: () => Promise<HubResult<HostedServer>>, onChange: () => void): SetupFlow {
  return hostedSetup(core, read, onChange, false)
}
