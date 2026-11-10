// The account's servers as Servers shows them. Whether the hub can make servers is remembered for a while, so the New
// server button doesn't come and go each time the screen opens.
import type { HostedServer } from '@ouro/contract'
import type { HostedAccount } from '../accounts/hostedAccount.ts'
import type { Clock } from '../platform/ports.ts'
import type { HubApi } from './hubApi.ts'

const AVAILABILITY_LIFETIME_MS = 5 * 60_000

export interface HostedServersView {
  /** The hub answered for this account within the last few minutes. */
  available: boolean
  /** As of now; empty when the hub didn't answer this time. */
  servers: readonly HostedServer[]
}

export class HostedServers {
  readonly api: HubApi
  private readonly clock: Clock
  private lastCheck: { accountId: string; at: number; available: boolean } | null = null

  constructor(api: HubApi, clock: Clock) {
    this.api = api
    this.clock = clock
  }

  async load(account: HostedAccount): Promise<HostedServersView> {
    const now = this.clock.now()
    const remembered = this.lastCheck?.accountId === account.accountId && now - this.lastCheck.at < AVAILABILITY_LIFETIME_MS ? this.lastCheck : null
    if (remembered && !remembered.available) return { available: false, servers: [] }
    const listed = await this.api.listServers(account.token)
    if (!remembered) this.lastCheck = { accountId: account.accountId, at: now, available: listed.ok }
    return { available: remembered?.available ?? listed.ok, servers: listed.ok ? listed.value.servers : [] }
  }
}
