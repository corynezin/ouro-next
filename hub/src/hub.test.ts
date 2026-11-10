import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HostedServer, HostedServerList, HubError, SignupResult } from '@ouro/contract'
import type { ProvisioningStep } from '@ouro/contract'
import { HubBases } from './bases.ts'
import { DistributionRepository } from './distribution.ts'
import { Hub, HubRefusal, newInviteCode } from './hub.ts'
import type { HubEvent } from './hub.ts'
import { hubHttpServer } from './http.ts'
import { failureWhy, Provisioning } from './provisioning.ts'
import type { ComputerOrder, Provisioner } from './provisioning.ts'
import { HubStore } from './store.ts'
import type { PairingRecord } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

let stores = 0
const newStore = (): HubStore => new HubStore(join(dir, `hub-${++stores}.db`))

/** Records every call; a step can be made to fail, or to wait until released. */
class FakeProvisioner implements Provisioner {
  readonly calls: string[] = []
  failAt: ProvisioningStep | null = null
  holdAt: ProvisioningStep | null = null
  private releaseHold: (() => void) | null = null
  private held: Promise<void> | null = null
  pairedPhone = false
  pairings = 0
  now = (): number => 1_000_000

  private async step(step: ProvisioningStep, order: ComputerOrder): Promise<void> {
    this.calls.push(`${step}:${order.serverId}`)
    if (this.holdAt === step) {
      this.held ??= new Promise((release) => { this.releaseHold = release })
      await this.held
    }
    if (this.failAt === step) throw new Error(`no room left\nstack detail`)
  }

  release(): void {
    this.holdAt = null
    this.releaseHold?.()
  }

  create = (order: ComputerOrder) => this.step('create', order)
  upload = (order: ComputerOrder) => this.step('upload', order)
  install = (order: ComputerOrder) => this.step('install', order)
  setup = (order: ComputerOrder) => this.step('setup', order)
  service = (order: ComputerOrder) => this.step('service', order)
  async address(order: ComputerOrder): Promise<string> {
    return `http://computers.test/${order.serverId}`
  }
  async startPairing(order: ComputerOrder): Promise<PairingRecord> {
    this.calls.push(`pair:${order.serverId}`)
    this.pairings += 1
    return { code: `code-${this.pairings}`, expiresAt: this.now() + 10 * 60_000 }
  }
  async hasPairedPhone(): Promise<boolean> {
    return this.pairedPhone
  }
  destroyFails = false
  async destroy(order: ComputerOrder): Promise<void> {
    this.calls.push(`destroy:${order.serverId}`)
    if (this.destroyFails) throw new Error('the Sprites API is down')
  }
}

function newHub(store = newStore(), provisioner = new FakeProvisioner(), serverLimit: number | null = null) {
  const events: HubEvent[] = []
  const log = (event: HubEvent) => events.push(event)
  const provisioning = new Provisioning(store, provisioner, log)
  let clock = 1_000_000
  provisioner.now = () => clock
  const hub = new Hub({ store, provisioner, provisioning, serverLimit, distributionCommit: async () => 'c0ffee', now: () => clock, log })
  return { hub, store, provisioner, provisioning, events, advanceClock: (ms: number) => { clock += ms } }
}

const STEPS = ['create', 'upload', 'install', 'setup', 'service', 'pair']

test('an invite opens one account; a used or unknown invite is refused', async () => {
  const { hub, store, provisioning } = newHub()
  const invite = newInviteCode()
  assert.match(invite, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  store.addInvite(invite, 1)
  const signedUp = await hub.signUp(` ${invite.toUpperCase()} `, 'Ada')
  assert.equal(signedUp.name, 'Ada')
  assert.equal(hub.accountOf(signedUp.token).id, signedUp.accountId)
  await assert.rejects(hub.signUp(invite, 'Eve'), (error: HubRefusal) => error.code === 'invite_invalid')
  await assert.rejects(hub.signUp('nope-nope-nope', 'Eve'), (error: HubRefusal) => error.code === 'invite_invalid')
  assert.throws(() => hub.accountOf('not-a-token'), (error: HubRefusal) => error.code === 'unauthenticated')
  assert.throws(() => hub.accountOf(null), (error: HubRefusal) => error.code === 'unauthenticated')
  await provisioning.settled()
  const servers = await hub.listServers(hub.accountOf(signedUp.token))
  assert.equal(servers.length, 1)
  assert.equal(servers[0]!.label, "Ada's computer")
  assert.equal(servers[0]!.primary, true)
})

test('a full hub refuses sign-up, leaving the invite unused, and refuses another server; failed servers count', async () => {
  const provisioner = new FakeProvisioner()
  const { hub, store, provisioning } = newHub(newStore(), provisioner, 2)
  const [first, second, third] = [newInviteCode(), newInviteCode(), newInviteCode()]
  for (const invite of [first, second, third]) store.addInvite(invite, 1)
  provisioner.failAt = 'create'
  const ada = await hub.signUp(first, 'Ada')
  await provisioning.settled()
  assert.equal((await hub.listServers(hub.accountOf(ada.token)))[0]!.status.state, 'failed')
  provisioner.failAt = null
  await hub.signUp(second, 'Bo')
  await assert.rejects(hub.signUp(third, 'Cy'), (error: HubRefusal) => error.code === 'hub_full' && /invite code still works/.test(error.message))
  await assert.rejects(hub.createServer(hub.accountOf(ada.token), 'Lab'), (error: HubRefusal) => error.code === 'hub_full')
  assert.equal((await hub.listServers(hub.accountOf(ada.token))).length, 1, 'nothing added')

  const roomier = new Hub({ store, provisioner, provisioning, serverLimit: 3, distributionCommit: async () => 'c0ffee', now: () => 1, log: () => {} })
  assert.equal((await roomier.signUp(third, 'Cy')).name, 'Cy', 'the invite was left unused')
  await provisioning.settled()
})

test('an account deletes its own failed or ready non-primary servers, which frees room; nothing else', async () => {
  const provisioner = new FakeProvisioner()
  const { hub, store, provisioning } = newHub(newStore(), provisioner, 3)
  for (const invite of ['inv-ada', 'inv-bo']) store.addInvite(invite, 1)
  const ada = hub.accountOf((await hub.signUp('inv-ada', 'Ada')).token)
  const bo = hub.accountOf((await hub.signUp('inv-bo', 'Bo')).token)
  await provisioning.settled()
  provisioner.failAt = 'upload'
  const failed = await hub.createServer(ada, 'Broken')
  await provisioning.settled()
  assert.equal((await hub.getServer(ada, failed.id)).status.state, 'failed')
  await assert.rejects(hub.createServer(ada, 'Lab'), (error: HubRefusal) => error.code === 'hub_full', 'the failed one fills the hub')

  const primary = (await hub.listServers(ada))[0]!
  await assert.rejects(hub.deleteServer(ada, primary.id), (error: HubRefusal) => error.code === 'server_not_deletable')
  await assert.rejects(hub.deleteServer(bo, failed.id), (error: HubRefusal) => error.code === 'not_found', "another account's server isn't there")
  await assert.rejects(hub.deleteServer(ada, 'srv-missing'), (error: HubRefusal) => error.code === 'not_found')
  assert.equal(provisioner.calls.some((call) => call.startsWith('destroy:')), false)

  provisioner.destroyFails = true
  await assert.rejects(hub.deleteServer(ada, failed.id), /Sprites API is down/)
  assert.equal(store.server(failed.id) !== null, true, 'a machine that is still there keeps its record')
  provisioner.destroyFails = false
  await hub.deleteServer(ada, failed.id)
  assert.deepEqual(provisioner.calls.filter((call) => call.startsWith('destroy:')), [`destroy:${failed.id}`, `destroy:${failed.id}`])
  assert.equal(store.server(failed.id), null)

  provisioner.failAt = null
  provisioner.holdAt = 'create'
  const underWay = await hub.createServer(ada, 'Lab')
  await assert.rejects(hub.deleteServer(ada, underWay.id), (error: HubRefusal) => error.code === 'server_not_deletable' && /still being made/.test(error.message))
  provisioner.release()
  await provisioning.settled()
  await hub.deleteServer(ada, underWay.id)
  assert.equal((await hub.listServers(ada)).length, 1)
})

test('DELETE /servers/:id answers 204 for the account\'s own server and refuses the rest in the contract shape', async (t) => {
  const store = newStore()
  const provisioner = new FakeProvisioner()
  const provisioning = new Provisioning(store, provisioner, () => {})
  const hub = new Hub({ store, provisioner, provisioning, serverLimit: null, distributionCommit: async () => 'c0ffee', now: () => 1, log: () => {} })
  const repository = new DistributionRepository(join(dir, `distribution-${stores}.git`), { source: join(dir, 'no-distribution'), reference: 'main' })
  const server = hubHttpServer({ hub, bases: new HubBases({ store, repository, dir: join(dir, `bases-${stores}`), now: () => 1 }) }, () => {})
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1`
  const remove = (id: string, token: string) => fetch(`${base}/servers/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })

  store.addInvite('inv-ada', 1)
  const ada = await hub.signUp('inv-ada', 'Ada')
  await provisioning.settled()
  const extra = await hub.createServer(hub.accountOf(ada.token), 'Extra')
  await provisioning.settled()
  const [primary] = await hub.listServers(hub.accountOf(ada.token))
  assert.equal((await remove(extra.id, 'wrong')).status, 401)
  const refused = await remove(primary!.id, ada.token)
  assert.equal(refused.status, 409)
  assert.equal(HubError.parse(await refused.json()).error.code, 'server_not_deletable')
  assert.equal((await remove(extra.id, ada.token)).status, 204)
  assert.equal((await remove(extra.id, ada.token)).status, 404)
})

test('a server is made step by step and ends ready with a pairing code', async () => {
  const { hub, store, provisioner, provisioning, events } = newHub()
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await provisioning.settled()
  const [server] = await hub.listServers(hub.accountOf(token))
  assert.deepEqual(provisioner.calls, STEPS.map((step) => `${step}:${server!.id}`))
  assert.deepEqual(events.filter((event) => event.event === 'step_started').map((event) => (event as { step: string }).step), STEPS)
  assert.deepEqual(server!.status, { state: 'ready', address: `http://computers.test/${server!.id}`, pairing: { code: 'code-1', expiresAt: 1_000_000 + 10 * 60_000 } })
  assert.equal(HostedServer.safeParse(server).success, true)
})

test('while it is being made, the server shows the step it is at', async () => {
  const { hub, store, provisioner, provisioning } = newHub()
  provisioner.holdAt = 'install'
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const [server] = await hub.listServers(hub.accountOf(token))
  assert.deepEqual(server!.status, { state: 'provisioning', step: 'install' })
  provisioner.release()
  await provisioning.settled()
})

test('a failed step leaves the server failed, with a reason fit to show', async () => {
  const { hub, store, provisioner, provisioning, events } = newHub()
  provisioner.failAt = 'setup'
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await provisioning.settled()
  const [server] = await hub.listServers(hub.accountOf(token))
  assert.deepEqual(server!.status, { state: 'failed', why: 'Setting up your computer failed at the setup step: no room left' })
  assert.equal(provisioner.calls.some((call) => call.startsWith('service:')), false)
  const failed = events.find((event) => event.event === 'server_failed')
  assert.ok(failed && 'detail' in failed && failed.detail.includes('stack detail'))
  assert.equal(failureWhy('create', new Error('')), 'Setting up your computer failed at the create step: no detail')
})

test('a hub that stopped mid-way carries on from the step it was at, without running earlier ones again', async () => {
  const store = newStore()
  const first = newHub(store)
  first.provisioner.holdAt = 'install'
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await first.hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await new Promise((resolve) => setTimeout(resolve, 10))
  // The first hub is gone; its held step never finishes.
  const second = newHub(store)
  second.provisioning.resumeAll()
  await second.provisioning.settled()
  const [server] = await second.hub.listServers(second.hub.accountOf(token))
  assert.deepEqual(second.provisioner.calls, ['install', 'setup', 'service', 'pair'].map((step) => `${step}:${server!.id}`))
  assert.equal(server!.status.state, 'ready')
  // The old hub's step finishing late can't move a ready server.
  first.provisioner.release()
  await first.provisioning.settled()
  assert.equal(store.server(server!.id)!.progress.state, 'ready')
})

test('a server starts once however often it is asked', async () => {
  const { hub, store, provisioner, provisioning } = newHub()
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  const [server] = store.serversOf(hub.accountOf(token).id)
  provisioning.start(server!.id)
  provisioning.resumeAll()
  await provisioning.settled()
  assert.equal(provisioner.calls.filter((call) => call.startsWith('create:')).length, 1)
})

test('the pairing code is renewed near expiry and hidden once a phone has paired', async () => {
  const { hub, store, provisioner, provisioning, advanceClock } = newHub()
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await provisioning.settled()
  const account = hub.accountOf(token)
  const [server] = await hub.listServers(account)
  const pairingOf = async () => {
    const shown = await hub.getServer(account, server!.id)
    return shown.status.state === 'ready' ? shown.status.pairing : undefined
  }
  assert.equal((await pairingOf())?.code, 'code-1')
  advanceClock(7 * 60_000)
  assert.equal((await pairingOf())?.code, 'code-1')
  advanceClock(2 * 60_000)
  assert.equal((await pairingOf())?.code, 'code-2')
  provisioner.pairedPhone = true
  assert.equal(await pairingOf(), null)
  provisioner.pairedPhone = false
  assert.equal(await pairingOf(), null, 'no code is made again once a phone has paired')
  assert.equal(provisioner.pairings, 2)
})

test('an unreachable computer keeps its code, and never shows an expired one', async () => {
  const { hub, store, provisioner, provisioning, events, advanceClock } = newHub()
  store.addInvite('aaaa-bbbb-cccc', 1)
  const { token } = await hub.signUp('aaaa-bbbb-cccc', 'Ada')
  await provisioning.settled()
  const account = hub.accountOf(token)
  const [server] = await hub.listServers(account)
  provisioner.hasPairedPhone = async () => { throw new Error('connect ECONNREFUSED') }
  advanceClock(11 * 60_000)
  const shown = await hub.getServer(account, server!.id)
  assert.deepEqual(shown.status, { state: 'ready', address: `http://computers.test/${server!.id}`, pairing: null })
  assert.ok(events.some((event) => event.event === 'pairing_check_failed'))
})

test("another account's server is not found", async () => {
  const { hub, store, provisioning } = newHub()
  store.addInvite('aaaa-bbbb-cccc', 1)
  store.addInvite('dddd-eeee-ffff', 1)
  const ada = hub.accountOf((await hub.signUp('aaaa-bbbb-cccc', 'Ada')).token)
  const eve = hub.accountOf((await hub.signUp('dddd-eeee-ffff', 'Eve')).token)
  await provisioning.settled()
  const [adas] = await hub.listServers(ada)
  await assert.rejects(hub.getServer(eve, adas!.id), (error: HubRefusal) => error.code === 'not_found')
  await assert.rejects(hub.getServer(ada, 'srv-missing'), (error: HubRefusal) => error.code === 'not_found')
})

test('over HTTP: sign-up, servers listed primary first, a second server made, and refusals in the contract shape', async (t) => {
  const { hub, store, provisioning } = newHub(newStore(), new FakeProvisioner(), 2)
  const internal: Error[] = []
  const repository = new DistributionRepository(join(dir, `distribution-${stores}.git`), { source: join(dir, 'no-distribution'), reference: 'main' })
  const bases = new HubBases({ store, repository, dir: join(dir, `bases-${stores}`), now: () => 1 })
  const server = hubHttpServer({ hub, bases }, (error) => internal.push(error))
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1`
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as unknown }
  }

  store.addInvite('aaaa-bbbb-cccc', 1)
  const refused = await call('POST', '/signup', { invite: 'wrong', name: 'Ada' })
  assert.equal(refused.status, 403)
  assert.equal(HubError.parse(refused.body).error.code, 'invite_invalid')
  assert.equal((await call('POST', '/signup', { invite: 'aaaa-bbbb-cccc' })).status, 400)
  const signedUp = await call('POST', '/signup', { invite: 'aaaa-bbbb-cccc', name: 'Ada' })
  assert.equal(signedUp.status, 200)
  const { token } = SignupResult.parse(signedUp.body)

  assert.equal((await call('GET', '/servers')).status, 401)
  assert.equal((await call('GET', '/servers', undefined, 'wrong')).status, 401)
  assert.equal((await call('POST', '/servers', { label: '' }, token)).status, 400)
  const made = await call('POST', '/servers', { label: 'Work' }, token)
  assert.equal(made.status, 200)
  const second = HostedServer.parse(made.body)
  assert.equal(second.primary, false)
  await provisioning.settled()
  const listed = HostedServerList.parse((await call('GET', '/servers', undefined, token)).body)
  assert.deepEqual(listed.servers.map((one) => [one.label, one.primary, one.status.state]), [["Ada's computer", true, 'ready'], ['Work', false, 'ready']])
  assert.equal(HostedServer.parse((await call('GET', `/servers/${second.id}`, undefined, token)).body).id, second.id)
  assert.equal((await call('GET', '/servers/srv-missing', undefined, token)).status, 404)
  assert.equal((await call('GET', '/nowhere', undefined, token)).status, 404)
  const full = await call('POST', '/servers', { label: 'Third' }, token)
  assert.equal(full.status, 503)
  assert.deepEqual({ ...HubError.parse(full.body).error, message: '' }, { code: 'hub_full', message: '', retryable: true }, 'the same request may work later')
  assert.deepEqual(internal, [])
})
