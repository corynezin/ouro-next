// The app as a whole, under the UI: saved setup, and the single `activeSession` reference. Nothing else in the app has a
// notion of "the current server". Outboxes live here, one per server, because a send outlives its session.
import type { CommandInput, CommandName, NetworkInvite, NetworkKind, NetworkRole } from '@ouro/contract'
import { HostedAccountStore } from './accounts/hostedAccount.ts'
import type { HostedAccount } from './accounts/hostedAccount.ts'
import { pairWithServer } from './accounts/pairing.ts'
import { PreferencesStore } from './accounts/preferences.ts'
import { SavedServers, SERVER_LIST_DAMAGED_PAIRING, ServerListDamaged } from './accounts/savedServers.ts'
import type { SavedServer, ServerWithToken } from './accounts/savedServers.ts'
import { inviteTarget, mayLinkOutsideNetworks, serversToLink } from './accounts/serverLinks.ts'
import type { AfterPairing } from './accounts/serverLinks.ts'
import type { AppLifecycle, Clock, DurableStore, IdSource, Network, SecureStorage } from './platform/ports.ts'
import { ServerDrafts } from './session/drafts.ts'
import { ServerOutbox } from './session/outbox.ts'
import type { NewSend } from './session/outbox.ts'
import { failureText, ServerApi } from './session/serverApi.ts'
import { ServerSession } from './session/serverSession.ts'
import { joinMadeNetwork, NetworkPlans, PendingNetworks } from './servers/networkPlans.ts'
import type { NetworkPlan } from './servers/networkPlans.ts'

export interface AppCoreDeps {
  network: Network
  clock: Clock
  lifecycle: AppLifecycle
  ids: IdSource
  secureStorage: SecureStorage
  durableStore: DurableStore
}

export type StartupState =
  | { stage: 'loading' }
  | { stage: 'failed'; message: string }
  | { stage: 'ready' }

export const STARTUP_FAILED_MESSAGE = 'Could not read saved setup. Your stored connections have been retained. Please retry.'
export const NO_TOKEN_MESSAGE = 'This phone has no saved key for that server. Pair with it again.'
export const RECOVERY_FAILED_MESSAGE = 'Recovery could not finish. Stored credentials have been retained. Please retry.'

type PlacedOrNot = { ok: true; networkId: string } | { ok: false; why: string }

interface RunningOutbox { outbox: ServerOutbox; api: ServerApi; lifetime: AbortController; loaded: Promise<void> }

/**
 * A saved server still to be put in the network picked for it when it was made (see networkPlans.ts):
 * - `placing`: under way now.
 * - `failed`: it didn't go in, for this reason, fit to show; Servers offers Retry. After a restart the reason is gone, and
 *   the plan alone says it is still to do.
 */
export type Placement =
  | { kind: 'placing'; plan: NetworkPlan }
  | { kind: 'failed'; plan: NetworkPlan; why: string }

export const PLACEMENT_INTERRUPTED = "it didn't finish"

export class AppCore {
  readonly deps: AppCoreDeps
  readonly servers: SavedServers
  readonly preferences: PreferencesStore
  readonly hostedAccounts: HostedAccountStore
  readonly networkPlans: NetworkPlans
  readonly pendingNetworks: PendingNetworks
  private session: ServerSession | null = null
  private account: HostedAccount | null = null
  private startupState: StartupState = { stage: 'loading' }
  /** Each selection of a server moves this on, so a slow startup can't undo a pairing that finished during it. */
  private selectionGeneration = 0
  private readonly outboxes = new Map<string, RunningOutbox>()
  /** How each placement under way or failed since the app started went: the plan itself is kept durably. */
  private readonly placementOutcomes = new Map<string, { kind: 'placing' } | { kind: 'failed'; why: string }>()
  /** Placements run one at a time, so a second server made into the same new network joins the first's, not a twin. */
  private placingQueue: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()

  constructor(deps: AppCoreDeps) {
    this.deps = deps
    this.servers = new SavedServers(deps.secureStorage, deps.ids)
    this.preferences = new PreferencesStore(deps.secureStorage, deps.ids)
    this.hostedAccounts = new HostedAccountStore(deps.secureStorage)
    this.networkPlans = new NetworkPlans(deps.durableStore)
    this.pendingNetworks = new PendingNetworks(deps.durableStore)
  }

  get activeSession() { return this.session }
  get hostedAccount() { return this.account }
  get startup() { return this.startupState }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed() { for (const listener of this.listeners) listener() }

  /** After sign-up. The account is the phone's way back to its hub servers, so it is kept before it is used. */
  async saveHostedAccount(account: HostedAccount) {
    await this.hostedAccounts.save(account)
    this.account = account
    this.changed()
  }

  /** Also the Retry after a failed start. */
  async start() {
    const generationAtStart = this.selectionGeneration
    this.startupState = { stage: 'loading' }
    this.changed()
    try {
      const [usable, , account] = await Promise.all([this.servers.firstUsable(), this.preferences.load(), this.hostedAccounts.load()])
      this.account = account
      await this.resumeOtherServersSends()
      if (generationAtStart === this.selectionGeneration && usable) await this.activate(usable)
      this.startupState = { stage: 'ready' }
    } catch {
      this.startupState = generationAtStart === this.selectionGeneration ? { stage: 'failed', message: STARTUP_FAILED_MESSAGE } : { stage: 'ready' }
    }
    this.changed()
  }

  /** Sends left unfinished by a kill go out whichever server is active, each to its own server. */
  private async resumeOtherServersSends() {
    for (const usable of await this.usableServers()) await this.outboxFor(usable).loaded
  }

  private async usableServers(): Promise<ServerWithToken[]> {
    const usable: ServerWithToken[] = []
    for (const server of await this.servers.list()) {
      const withToken = await this.servers.withToken(server)
      if (withToken) usable.push(withToken)
    }
    return usable
  }

  private outboxFor({ server, token }: ServerWithToken): RunningOutbox {
    const running = this.outboxes.get(server.id)
    if (running) return running
    const { durableStore: store, clock, ids } = this.deps
    const lifetime = new AbortController()
    const api = new ServerApi(this.deps, { url: server.url, token }, lifetime.signal)
    const outbox = new ServerOutbox({ store, clock, ids, api }, server.id)
    const created: RunningOutbox = { outbox, api, lifetime, loaded: outbox.load() }
    this.outboxes.set(server.id, created)
    return created
  }

  // ---- any saved server, active or not: what a notification's buttons act on ----

  /** The saved server a push came from: each server knows this phone by its own device id. */
  async serverOfDevice(deviceId: string): Promise<SavedServer | null> {
    const servers = await this.servers.list()
    return servers.find((server) => server.deviceId === deviceId) ?? null
  }

  /** Queues a send in that server's outbox. False if it has no usable token. */
  async sendFrom(server: SavedServer, newSend: NewSend): Promise<boolean> {
    const usable = await this.servers.withToken(server)
    if (!usable) return false
    const { outbox, loaded } = this.outboxFor(usable)
    await loaded
    outbox.send(newSend)
    return true
  }

  /** One read of everything on that server, active or not. Null if it has no usable token. */
  async snapshotOf(server: SavedServer) {
    const usable = await this.servers.withToken(server)
    return usable ? this.outboxFor(usable).api.snapshot() : null
  }

  /** Words for the failure, or null if it worked. */
  async commandErrorOn<N extends CommandName>(server: SavedServer, name: N, input: CommandInput<N>): Promise<string | null> {
    const usable = await this.servers.withToken(server)
    if (!usable) return NO_TOKEN_MESSAGE
    const result = await this.outboxFor(usable).api.command(name, input, this.deps.ids.newId())
    return result.ok ? null : failureText(result.failure)
  }

  /**
   * Links two saved servers as each other's computers: `host` makes a one-use invite and `joiner` joins with it, so the
   * person never copies a command. Words for the failure, or null if it worked. Only a server's owner may do either.
   */
  async linkServers(joiner: SavedServer, host: SavedServer): Promise<string | null> {
    const [joining, hosting] = await Promise.all([this.servers.withToken(joiner), this.servers.withToken(host)])
    if (!joining || !hosting) return NO_TOKEN_MESSAGE
    const invite = await this.outboxFor(hosting).api.command('create_computer_invite', {}, this.deps.ids.newId())
    if (!invite.ok) return failureText(invite.failure)
    const target = inviteTarget(invite.value)
    if (!target) return 'The invite had no address.'
    const joined = await this.outboxFor(joining).api.command('join_computer', target, this.deps.ids.newId())
    return joined.ok ? null : failureText(joined.failure)
  }

  /** A one-use invite into a network `holder` holds a key for, made there: whichever server is open. */
  async networkInviteOn(holder: SavedServer, networkId: string): Promise<{ ok: true; value: NetworkInvite } | { ok: false; why: string }> {
    const usable = await this.servers.withToken(holder)
    if (!usable) return { ok: false, why: NO_TOKEN_MESSAGE }
    const made = await this.outboxFor(usable).api.command('create_network_invite', { networkId }, this.deps.ids.newId())
    return made.ok ? { ok: true, value: made.value } : { ok: false, why: failureText(made.failure) }
  }

  /** `joiner` takes a network `host` holds a key for, as `join.role`: an invite made on the host, traded on the joiner,
   * which holds the host to the network being of `join.kind`. Answers why not, or null. */
  async addToNetwork(joiner: SavedServer, host: SavedServer, join: { networkId: string; kind: NetworkKind; role: NetworkRole }): Promise<string | null> {
    const [joining, hosting] = await Promise.all([this.servers.withToken(joiner), this.servers.withToken(host)])
    if (!joining || !hosting) return NO_TOKEN_MESSAGE
    const invite = await this.outboxFor(hosting).api.command('create_network_invite', { networkId: join.networkId }, this.deps.ids.newId())
    if (!invite.ok) return failureText(invite.failure)
    const joined = await this.outboxFor(joining).api.command('join_network', { address: invite.value.address, code: invite.value.code, role: join.role, kind: join.kind }, this.deps.ids.newId())
    return joined.ok ? null : failureText(joined.failure)
  }

  /** A server the person just made links itself with every other saved server it isn't linked with yet. Quietly
   * best-effort: a server they don't own, or can't be reached, stays unlinked and shows Link in Servers. Never once the person uses
   * networks, on any saved server: a link is full trust outside them, so a server that goes on to join a shared network
   * would keep a way into the private one. Then the person picks each server's network in Servers. */
  private async linkWithOtherServers(added: SavedServer) {
    const saved = await this.servers.list()
    if (saved.length < 2) return
    const snapshot = await this.snapshotOf(added).catch(() => null)
    if (!snapshot?.ok) return
    const others = saved.filter((server) => server.id !== added.id)
    const theirs = await Promise.all(others.map(async (other) => {
      const read = await this.snapshotOf(other).catch(() => null)
      return read?.ok ? read.value.server.networks ?? [] : null
    }))
    if (!mayLinkOutsideNetworks(snapshot.value.server.networks ?? [], theirs)) return
    for (const other of serversToLink(added, saved, snapshot.value.computers)) await this.linkServers(added, other).catch(() => null)
  }

  /**
   * Asks a server this phone is leaving to stop pushing to it. Not waited on and not retried: an unreachable server is
   * forgotten all the same, and its pushes then name a device this phone no longer has, so they open nothing.
   */
  private async stopPushesFrom(usable: ServerWithToken) {
    const api = new ServerApi(this.deps, { url: usable.server.url, token: usable.token }, new AbortController().signal)
    void api.command('clear_push_token', {}, this.deps.ids.newId()).catch(() => {})
  }

  private async activate(usable: ServerWithToken) {
    const generation = ++this.selectionGeneration
    this.session?.dispose()
    this.session = null
    this.changed()
    const { outbox, loaded } = this.outboxFor(usable)
    const drafts = new ServerDrafts(this.deps.durableStore, usable.server.id)
    await Promise.all([loaded, drafts.load()])
    if (generation !== this.selectionGeneration) return
    const session = new ServerSession(this.deps, usable.server.id, { url: usable.server.url, token: usable.token }, { outbox, drafts })
    this.session = session
    session.start()
    this.changed()
  }

  /** Throws a readable error if the pairing or saving fails. */
  /** `setupId`: a server made from Servers, whose network was picked when it was named (see networkPlans.ts): once paired,
   * it goes into that network instead of being linked with the others. */
  async pairAndActivate(url: string, code: string, details: { label?: string; hostedServerId?: string; setupId?: string; afterPairing?: AfterPairing } = {}): Promise<SavedServer> {
    // Before the code is spent: a pairing code works once, and a damaged list would refuse to keep what it gave.
    if (this.servers.needsRecovery) throw new ServerListDamaged(SERVER_LIST_DAMAGED_PAIRING)
    const result = await pairWithServer(this.deps.network, url, code)
    if (!result.ok) throw new Error(result.reason)
    const { deviceToken, deviceId, personId: _personId, machineName } = result.paired
    const { afterPairing = 'nothing', setupId, ...saving } = details
    const server = await this.servers.add(
      { url, token: deviceToken, deviceName: machineName, deviceId, personName: null },
      saving,
    )
    await this.discardOutbox(server.id) // its token just changed
    // The first server paired gives this phone its updates, until the person picks another.
    if (this.preferences.current.updateHomeServerId === null) this.preferences.set('updateHomeServerId', server.id)
    await this.activate({ server, token: deviceToken })
    const plan = setupId ? await this.networkPlans.get(setupId) : null
    if (plan === null) {
      if (afterPairing === 'link_with_other_servers') void this.linkWithOtherServers(server).catch(() => {})
      return server
    }
    // Kept under the saved server first: activating remounts every screen, so how it went is state here, shown in
    // Servers, rather than an error thrown at a screen that is gone.
    await this.networkPlans.movePlanToServer(setupId!, server.id, plan)
    await this.placeServer(server.id)
    return server
  }

  /** The saved servers still to be put in their network, and how that went. */
  async placements(): Promise<Map<string, Placement>> {
    const placements = new Map<string, Placement>()
    for (const [serverId, plan] of await this.networkPlans.placements()) {
      const outcome = this.placementOutcomes.get(serverId)
      placements.set(serverId, outcome?.kind === 'placing' ? { kind: 'placing', plan } : { kind: 'failed', plan, why: outcome?.why ?? PLACEMENT_INTERRUPTED })
    }
    return placements
  }

  /** Servers' Retry: tries the placement again. */
  retryPlacement(serverId: string): Promise<void> {
    return this.placeServer(serverId)
  }

  private placeServer(serverId: string): Promise<void> {
    const run = this.placingQueue.then(async () => {
      // Read again in the queue: one placed before this one may have changed it (see joinMadeNetwork).
      const plan = await this.networkPlans.placementOf(serverId)
      const server = (await this.servers.list()).find((saved) => saved.id === serverId)
      if (!plan || !server) return
      this.placementOutcomes.set(serverId, { kind: 'placing' })
      this.changed()
      const placed = await this.placeInNetwork(server, plan).catch((failure: unknown): PlacedOrNot => ({ ok: false, why: failure instanceof Error ? failure.message : String(failure) }))
      if (placed.ok) {
        this.placementOutcomes.delete(serverId)
        await this.networkPlans.clearPlacement(serverId)
        if (plan.kind === 'new_private') {
          await this.pendingNetworks.remove(plan.name)
          await this.networkPlans.rewriteAll((other) => joinMadeNetwork(other, { name: plan.name, networkId: placed.networkId, hostServerId: serverId }))
        }
      } else {
        this.placementOutcomes.set(serverId, { kind: 'failed', why: placed.why })
      }
      this.changed()
    })
    this.placingQueue = run.catch(() => {})
    return run
  }

  /** Puts a saved server into the network planned for it: the network's id, or words for the failure. */
  private async placeInNetwork(server: SavedServer, plan: NetworkPlan): Promise<PlacedOrNot> {
    if (plan.kind === 'new_private') {
      const usable = await this.servers.withToken(server)
      if (!usable) return { ok: false, why: NO_TOKEN_MESSAGE }
      const made = await this.outboxFor(usable).api.command('create_network', { name: plan.name, kind: 'private', role: 'home' }, this.deps.ids.newId())
      return made.ok ? { ok: true, networkId: made.value.network.id } : { ok: false, why: failureText(made.failure) }
    }
    const host = (await this.servers.list()).find((saved) => saved.id === plan.hostServerId)
    if (!host) return { ok: false, why: 'the server that holds its key is no longer on this phone' }
    const why = await this.addToNetwork(server, host, { networkId: plan.networkId, kind: plan.networkKind, role: 'home' })
    return why === null ? { ok: true, networkId: plan.networkId } : { ok: false, why }
  }

  /** Forgets what was planned for a server this phone no longer has, or a machine that is gone. */
  private async forgetPlacement(serverId: string) {
    this.placementOutcomes.delete(serverId)
    await this.networkPlans.clearPlacement(serverId)
  }

  /** A machine the open server made is destroyed before this phone paired with it: its plan goes with it. */
  async machineDestroyed(machineId: string) {
    await this.networkPlans.clear(machineId)
  }

  /** The saved server updates come from. Switching servers never changes it. */
  async updateHome(): Promise<SavedServer | null> {
    const homeId = this.preferences.current.updateHomeServerId
    if (homeId === null) return null
    const servers = await this.servers.list().catch(() => [])
    return servers.find((server) => server.id === homeId) ?? null
  }

  setUpdateHome(serverId: string | null) {
    this.preferences.set('updateHomeServerId', serverId)
  }

  /** Returns false if the server has no usable token. */
  async switchTo(server: SavedServer): Promise<boolean> {
    const usable = await this.servers.withToken(server)
    if (!usable) return false
    await this.servers.setActiveId(server.id)
    await this.activate(usable)
    return true
  }

  /** Forgets a server on this phone and connects to the next one, or to nothing. */
  async removeServer(id: string) {
    const leaving = (await this.servers.list().catch(() => [])).find((server) => server.id === id)
    const usable = leaving ? await this.servers.withToken(leaving).catch(() => null) : null
    await this.servers.remove(id)
    await this.forgetPlacement(id)
    if (usable) void this.stopPushesFrom(usable)
    if (this.preferences.current.updateHomeServerId === id) this.preferences.set('updateHomeServerId', null)
    const outbox = this.outboxes.get(id)
    if (outbox) {
      outbox.lifetime.abort()
      await outbox.outbox.forgetAll()
      this.outboxes.delete(id)
    }
    if (this.session?.serverId === id) await this.activateNextOrNone()
  }

  private async activateNextOrNone() {
    const next = await this.servers.firstUsable()
    if (next) await this.activate(next)
    else this.deactivate()
  }

  private deactivate() {
    this.selectionGeneration++
    this.session?.dispose()
    this.session = null
    this.changed()
  }

  /** Stops the outbox built on an old token. A saved entry resumes under the new one. */
  private async discardOutbox(serverId: string) {
    this.outboxes.get(serverId)?.lifetime.abort()
    this.outboxes.delete(serverId)
  }

  async signOut() {
    const leaving = await this.usableServers().catch(() => [])
    await this.servers.removeAll()
    for (const usable of leaving) void this.stopPushesFrom(usable)
    await this.hostedAccounts.save(null)
    this.account = null
    this.placementOutcomes.clear()
    await this.networkPlans.clearAll()
    await this.pendingNetworks.clear()
    this.preferences.set('updateHomeServerId', null)
    for (const { outbox, lifetime } of this.outboxes.values()) {
      lifetime.abort()
      await outbox.forgetAll()
    }
    this.outboxes.clear()
    this.deactivate()
  }

  async resetDamagedPreferences() {
    await this.preferences.resetDamaged()
    await this.start()
  }

  /** After this the Pair form opens: the person asked to pair again. */
  async resetDamagedServerList() {
    await this.servers.resetDamagedList()
    this.deactivate()
    await this.start()
  }
}
