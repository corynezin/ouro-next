// The hub's service: sign-up, an account's servers, and a ready server's pairing code. HTTP is in http.ts.
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { HostedServer, HubErrorCode, SignupResult } from '@ouro/contract'
import { orderOf } from './provisioning.ts'
import type { Provisioner, Provisioning, ProvisioningEvent } from './provisioning.ts'
import { hashOf, hostedServerOf } from './store.ts'
import type { Account, HubStore, ServerRecord } from './store.ts'

/** A refusal the app can show as it is. */
export class HubRefusal extends Error {
  readonly code: HubErrorCode

  constructor(code: HubErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** A code is replaced this long before it expires, so the one handed out has time to be typed. */
const PAIRING_RENEW_BEFORE_MS = 2 * 60_000

export interface HubDependencies {
  store: HubStore
  provisioner: Provisioner
  provisioning: Provisioning
  /** The most servers this hub makes, all accounts together; null: no limit. */
  serverLimit: number | null
  /** The commit new servers are made from, looked up when one is asked for. */
  distributionCommit: () => Promise<string>
  now: () => number
  log: (event: HubEvent) => void
}

export type HubEvent = ProvisioningEvent | { event: 'pairing_check_failed'; serverId: string; detail: string }

export class Hub {
  /** One look at a server's pairing at a time, so two polls don't both make a code. */
  private readonly pairingChecks = new Map<string, Promise<void>>()

  private readonly deps: HubDependencies

  constructor(deps: HubDependencies) {
    this.deps = deps
  }

  async signUp(invite: string, name: string): Promise<SignupResult> {
    const { store, now } = this.deps
    const distributionCommit = await this.deps.distributionCommit()
    const account: Account = { id: randomUUID(), name, createdAt: now() }
    const token = randomBytes(32).toString('base64url')
    const primary = { id: newServerId(), accountId: account.id, label: `${name}'s computer`, primary: true, createdAt: account.createdAt, distributionCommit }
    const outcome = store.signUp(normalisedInvite(invite), account, hashOf(token), primary, this.deps.serverLimit)
    if (outcome === 'invite_invalid') throw new HubRefusal('invite_invalid', 'That invite code is not valid, or was used already.')
    if (outcome === 'hub_full') throw new HubRefusal('hub_full', 'This hub has no room for another computer right now. Your invite code still works: try it again later.')
    void this.deps.provisioning.start(primary.id)
    return { accountId: account.id, token, name }
  }

  /** The account a bearer token stands for. */
  accountOf(token: string | null): Account {
    const account = token ? this.deps.store.accountByTokenHash(hashOf(token)) : null
    if (!account) throw new HubRefusal('unauthenticated', 'This sign-up is no longer valid. Start over with your invite code.')
    return account
  }

  async listServers(account: Account): Promise<HostedServer[]> {
    const servers = this.deps.store.serversOf(account.id)
    return await Promise.all(servers.map((server) => this.shown(server)))
  }

  async createServer(account: Account, label: string): Promise<HostedServer> {
    const { store, now } = this.deps
    const server = { id: newServerId(), accountId: account.id, label, primary: false, createdAt: now(), distributionCommit: await this.deps.distributionCommit() }
    if (!store.addServer(server, this.deps.serverLimit)) throw new HubRefusal('hub_full', 'This hub has no room for another computer right now. Try again later.')
    void this.deps.provisioning.start(server.id)
    return hostedServerOf(store.server(server.id)!, now())
  }

  async getServer(account: Account, serverId: string): Promise<HostedServer> {
    const server = this.deps.store.server(serverId)
    if (!server || server.accountId !== account.id) throw new HubRefusal('not_found', 'No such server.')
    return await this.shown(server)
  }

  /**
   * Destroys the account's own non-primary server's machine, then forgets it, so it stops counting against the hub's limit.
   * One still being made is refused: its steps would go on making the machine. If the machine can't be destroyed the
   * record stays, and deleting again retries.
   */
  async deleteServer(account: Account, serverId: string): Promise<void> {
    const { store, provisioner } = this.deps
    const server = store.server(serverId)
    if (!server || server.accountId !== account.id) throw new HubRefusal('not_found', 'No such server.')
    if (server.primary) throw new HubRefusal('server_not_deletable', "Your primary computer can't be deleted.")
    if (server.progress.state === 'provisioning') throw new HubRefusal('server_not_deletable', 'This computer is still being made. Delete it once it is ready or has failed.')
    await provisioner.destroy(orderOf(server))
    store.deleteServer(serverId)
  }

  /** A ready server as shown now: once a phone has paired, no code; otherwise a code with time left on it. */
  private async shown(server: ServerRecord): Promise<HostedServer> {
    if (server.progress.state === 'ready' && !server.progress.phonePaired) await this.checkPairing(server.id)
    return hostedServerOf(this.deps.store.server(server.id)!, this.deps.now())
  }

  private checkPairing(serverId: string): Promise<void> {
    const underWay = this.pairingChecks.get(serverId)
    if (underWay) return underWay
    const checking = this.refreshPairing(serverId).finally(() => this.pairingChecks.delete(serverId))
    this.pairingChecks.set(serverId, checking)
    return checking
  }

  /** The computer may be briefly unreachable; then what is known stays as it is. */
  private async refreshPairing(serverId: string): Promise<void> {
    const { store, provisioner, now } = this.deps
    const server = store.server(serverId)
    if (!server || server.progress.state !== 'ready' || server.progress.phonePaired) return
    const order = orderOf(server)
    try {
      if (await provisioner.hasPairedPhone(order)) return store.markPhonePaired(serverId)
      const { pairing } = server.progress
      if (pairing === null || pairing.expiresAt - PAIRING_RENEW_BEFORE_MS <= now()) store.replacePairing(serverId, await provisioner.startPairing(order))
    } catch (error) {
      // Shown as last known: an expired code isn't shown at all.
      this.deps.log({ event: 'pairing_check_failed', serverId, detail: (error as Error).message.slice(0, 1000) })
    }
  }
}

/** Easy to read out and type: no letters that look like digits. */
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export const newInviteCode = (): string =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('')).join('-')

/** Codes are made lowercase; a phone's keyboard may capitalise them. */
const normalisedInvite = (invite: string): string => invite.trim().toLowerCase()

const newServerId = (): string => `srv-${randomBytes(4).toString('hex')}`
