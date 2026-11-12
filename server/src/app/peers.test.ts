import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { PEER_API_PREFIX, PEER_CLAUDE_TOKEN_PROTOCOL, PEER_PROTOCOL, PEER_MIN_PROTOCOL } from '@ouro/contract'
import type { PeerHello, PeerIdentity, PeerMove, PeerNetworkJoinRequest } from '@ouro/contract'
import { loadOrCreateMachineKey, NetworkKeyFile, networkIdOf, newNetworkKey, signatureHeaders } from '../adapters/peer-transport.ts'
import type { MachineKey } from '../adapters/peer-transport.ts'
import { COMPUTER_INVITE_LIFETIME_MS } from '../domain/peers.ts'
import { PEER_ROUTE_ACTIONS, SIGNED_PEER_ROUTES } from '../interfaces/peer.ts'
import { CommandRefused } from './failure.ts'
import { Peers, PeerRequestRefused, privateTransport } from './peers.ts'
import type { PeersConfig } from './peers.ts'
import { Store } from '../store/store.ts'

const dir = mkdtempSync(join(tmpdir(), 'ouro-peers-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test("a network's key travels only over HTTPS, Tailscale or this machine itself", () => {
  for (const address of ['https://a.example', 'http://100.64.0.1:7777', 'http://100.127.255.254', 'http://mac.tail1234.ts.net:7777', 'http://localhost:7777', 'http://127.0.0.1', 'http://[::1]:7777']) {
    assert.equal(privateTransport(address), true, address)
  }
  for (const address of ['http://a.example', 'http://100.128.0.1', 'http://100.63.255.255', 'http://100.64.0.1.evil.example', 'http://192.168.1.2', 'http://ts.net.evil.example', 'not a url', '']) {
    assert.equal(privateTransport(address), false, address)
  }
})

test('every working peer route names what it does, so none is taken without a decision', () => {
  const working = SIGNED_PEER_ROUTES.filter((route) => route !== '/hello' && route !== '/forget')
  assert.deepEqual(Object.keys(PEER_ROUTE_ACTIONS).sort(), [...working].sort())
})

let made = 0
/** A server's Peers over a store of its own, with a clock the test moves. */
function server(name: string, address = 'http://127.0.0.1:1') {
  made++
  const store = new Store(':memory:')
  const key = loadOrCreateMachineKey(join(dir, `${made}`, 'machine-key.pem'))
  const networkKeys = new NetworkKeyFile(join(dir, `${made}`, 'network-keys.json'))
  const clock = { now: 1_000_000 }
  const nothing = () => { throw new Error('not in this test') }
  const config: PeersConfig = {
    store, machineId: `id-${name}`, machineName: name, ownerName: () => `owner-${name}`, address, key, networkKeys, release: 'test',
    now: () => clock.now, commit: (body) => body(), agentCounts: () => ({ running: 0, total: 0 }), ownerPushTokenHashes: () => [],
    agentCards: () => [], claudePlan: nothing, peerClaudePlanChanged: () => {}, controlFromPeer: nothing, claudeTokenFromPeer: nothing, createAgentFromPeer: nothing,
    deliverFromPeer: nothing, groupUpdateFromPeer: nothing, groupPostFromPeer: nothing, ownerMessageFromPeer: nothing, ownerAskFromPeer: nothing,
    askSnoozeFromPeer: nothing, memoryPullIntervalMs: 60_000, memoryProjectKeys: () => [], memoryForPeer: nothing, memoryFromPeer: nothing,
    logForPeer: nothing, moveCheckFromPeer: nothing, moveFromPeer: nothing, pullForPeer: nothing, memoryPushFromPeer: nothing,
    hostSleeps: false, heldAwake: () => false, inUse: () => false, holdForWork: async () => true, log: () => {},
  }
  const holdNetwork = (kind: 'private' | 'shared', role: 'home' | 'extra', networkKey = newNetworkKey()) => {
    const id = networkIdOf(networkKey)
    networkKeys.set(id, networkKey)
    store.saveNetwork({ id, name: kind, kind, role, addedAt: 1 })
    return { id, key: networkKey }
  }
  return { peers: new Peers(config), store, key, clock, holdNetwork, name, machineId: `id-${name}` }
}

const identityOf = (name: string, key: MachineKey, address = 'http://127.0.0.1:2'): PeerIdentity =>
  ({ machineId: `id-${name}`, name, address, publicKey: key.publicKeyPem, protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL })
const joinRequest = (code: string, name: string, key: MachineKey, kind: 'private' | 'shared', role: 'home' | 'extra' = 'home'): PeerNetworkJoinRequest =>
  ({ code, joiner: identityOf(name, key), ownerName: `owner-${name}`, role, kind })

test("an invite into a network works once, for its lifetime only, and a join of the wrong kind leaves it open", () => {
  const host = server('host')
  const shared = host.holdNetwork('shared', 'home')
  const joiner = loadOrCreateMachineKey(join(dir, 'joiner.pem'))

  const invite = host.peers.createNetworkInvite(shared.id)
  assert.match(invite.command, /^ouro networks join http:\/\/127\.0\.0\.1:1 [0-9a-f]+ --kind shared$/)
  assert.throws(() => host.peers.acceptNetworkJoin(joinRequest(invite.code, 'joiner', joiner, 'private')), (error: PeerRequestRefused) => error.code === 'forbidden')
  assert.equal(host.store.peerById('id-joiner'), null, 'taken in by nothing')
  const joined = host.peers.acceptNetworkJoin(joinRequest(invite.code, 'joiner', joiner, 'shared'))
  assert.equal(joined.network.kind, 'shared')
  assert.equal(host.store.peerById('id-joiner')?.networkId, shared.id)
  assert.throws(() => host.peers.acceptNetworkJoin(joinRequest(invite.code, 'again', joiner, 'shared')), (error: PeerRequestRefused) => error.code === 'invite_invalid', 'used')

  const late = host.peers.createNetworkInvite(shared.id)
  host.clock.now += COMPUTER_INVITE_LIFETIME_MS + 1
  assert.throws(() => host.peers.acceptNetworkJoin(joinRequest(late.code, 'late', joiner, 'shared')), (error: PeerRequestRefused) => error.code === 'invite_invalid', 'expired')
})

test('a private network is never given as an extra key, and that refusal leaves the invite open too', () => {
  const host = server('home')
  const own = host.holdNetwork('private', 'home')
  const joiner = loadOrCreateMachineKey(join(dir, 'visitor.pem'))
  const invite = host.peers.createNetworkInvite(own.id)
  assert.throws(() => host.peers.acceptNetworkJoin(joinRequest(invite.code, 'visitor', joiner, 'private', 'extra')), (error: PeerRequestRefused) => error.code === 'forbidden')
  assert.equal(host.peers.acceptNetworkJoin(joinRequest(invite.code, 'visitor', joiner, 'private')).network.kind, 'private')
})

test('a server this one made is invited into its home network, as a home of the same kind, or else to be one of its computers', () => {
  const alone = server('alone')
  const computerInvite = alone.peers.inviteForMadeServer()
  assert.equal(computerInvite.kind, 'computer')
  const made = loadOrCreateMachineKey(join(dir, 'made.pem'))
  alone.peers.acceptJoin({ code: computerInvite.code, joiner: identityOf('made', made) })
  assert.equal(alone.store.peerById('id-made')?.trust, 'full')

  const host = server('networked')
  const own = host.holdNetwork('shared', 'home')
  const invite = host.peers.inviteForMadeServer()
  assert.deepEqual(invite.kind === 'network' && [invite.networkKind, invite.address], ['shared', 'http://127.0.0.1:1'])
  host.peers.acceptNetworkJoin(joinRequest(invite.code, 'made', made, invite.kind === 'network' ? invite.networkKind : 'private'))
  assert.equal(host.store.peerById('id-made')?.networkId, own.id)
})

/** A signed request from `from` to `to`, in `network`, as peer-transport sends it. */
function signedRequest(from: { key: MachineKey; machineId: string }, to: { machineId: string }, route: string, body: unknown, now: number, network: { id: string; key: string; visiting: boolean } | null) {
  const path = `${PEER_API_PREFIX}${route}`
  const text = JSON.stringify(body)
  const headers = signatureHeaders(from.key, from.machineId, 'POST', path, text, now, network && { ...network, recipient: to.machineId })
  return { method: 'POST', path, body: text, header: (name: string) => headers[name] }
}
const helloFrom = (name: string, key: MachineKey): PeerHello => ({
  protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL, release: 'test', agentsRunning: 0, agentCount: 0, sleeps: false, heldAwake: false, ownerPushTokenHashes: [],
  identity: identityOf(name, key), ownerName: `owner-${name}`, addresses: [],
})

test('a server unknown here introduces itself with a hello in the network, and then is known by that key only', () => {
  const here = server('here')
  const home = here.holdNetwork('shared', 'home')
  const stranger = { key: loadOrCreateMachineKey(join(dir, 'stranger.pem')), machineId: 'id-stranger' }
  const network = { id: home.id, key: home.key, visiting: false }

  assert.throws(() => here.peers.verify(signedRequest(stranger, here, '/agents', {}, here.clock.now, network)), (error: PeerRequestRefused) => error.code === 'unauthenticated', 'only a hello introduces')
  assert.throws(() => here.peers.verify(signedRequest(stranger, here, '/hello', helloFrom('stranger', stranger.key), here.clock.now, { ...network, key: newNetworkKey() })),
    (error: PeerRequestRefused) => error.code === 'unauthenticated', 'not with another key')
  const known = here.peers.verify(signedRequest(stranger, here, '/hello', helloFrom('stranger', stranger.key), here.clock.now, network))
  assert.equal(known.publicKey, stranger.key.publicKeyPem)

  // Once known, another key under its id is refused, even introducing itself again.
  const impostor = { key: loadOrCreateMachineKey(join(dir, 'impostor.pem')), machineId: 'id-stranger' }
  assert.throws(() => here.peers.verify(signedRequest(impostor, here, '/hello', helloFrom('stranger', impostor.key), here.clock.now, network)), (error: PeerRequestRefused) => error.code === 'unauthenticated')
})

test('a server known only from an address book introduces itself the same way, and a visitor stays a visitor', () => {
  const here = server('there')
  const home = here.holdNetwork('shared', 'home')
  const listed = { key: loadOrCreateMachineKey(join(dir, 'listed.pem')), machineId: 'id-listed' }
  here.store.savePeerInNetwork({ machineId: 'id-listed', name: 'listed', address: 'http://127.0.0.1:3', publicKey: '', networkId: home.id, visiting: false, ownerName: null, joinedAt: 1 })
  const visiting = { id: home.id, key: home.key, visiting: true }
  assert.equal(here.peers.verify(signedRequest(listed, here, '/hello', helloFrom('listed', listed.key), here.clock.now, visiting)).visiting, true)
  assert.equal(here.peers.verify(signedRequest(listed, here, '/agents', {}, here.clock.now, { ...visiting, visiting: false })).visiting, true, 'saying otherwise later changes nothing')
})

test('a computer removed from the network stays out: not learned from a hello, and refused when it introduces itself', () => {
  const here = server('alpha')
  const home = here.holdNetwork('private', 'home')
  const beta = { key: loadOrCreateMachineKey(join(dir, 'beta.pem')), machineId: 'id-beta' }
  const network = { id: home.id, key: home.key, visiting: false }
  here.peers.verify(signedRequest(beta, here, '/hello', helloFrom('beta', beta.key), here.clock.now, network))
  here.peers.remove('id-beta')
  assert.equal(here.store.peerById('id-beta'), null)

  // Gamma, a member, still lists beta in its hello.
  const gamma = { key: loadOrCreateMachineKey(join(dir, 'gamma.pem')), machineId: 'id-gamma' }
  const gammaHello = { ...helloFrom('gamma', gamma.key), addresses: [{ machineId: 'id-beta', name: 'beta', address: 'http://127.0.0.1:4' }] }
  const gammaRow = here.peers.verify(signedRequest(gamma, here, '/hello', gammaHello, here.clock.now, network))
  here.peers.receiveHello(gammaRow, gammaHello)
  assert.equal(here.store.peerById('id-beta'), null, "gamma's word doesn't bring it back")
  assert.throws(() => here.peers.verify(signedRequest(beta, here, '/hello', helloFrom('beta', beta.key), here.clock.now + 1, network)), (error: PeerRequestRefused) => error.code === 'unauthenticated', 'nor its own')

  // Letting go of a network's key forgets the computers in it.
  const team = here.holdNetwork('shared', 'extra')
  here.store.savePeerInNetwork({ machineId: 'id-team', name: 'team', address: 'http://127.0.0.1:5', publicKey: 'k', networkId: team.id, visiting: false, ownerName: null, joinedAt: 1 })
  here.peers.forgetNetwork(team.id)
  assert.equal(here.store.peerById('id-team'), null)
  assert.ok(here.store.peerById('id-gamma'))
})

test('a pulled copy is taken only when it is the agent asked for', async () => {
  let answer: unknown = null
  const shared = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(answer))
  })
  await new Promise<void>((resolve) => shared.listen(0, '127.0.0.1', resolve))
  try {
    const here = server('mine')
    here.holdNetwork('private', 'home')
    const team = here.holdNetwork('shared', 'extra')
    const address = `http://127.0.0.1:${(shared.address() as AddressInfo).port}`
    here.store.savePeerInNetwork({ machineId: 'id-team', name: 'team', address, publicKey: 'k', networkId: team.id, visiting: false, ownerName: null, joinedAt: 1 })
    here.store.notePeerHello('id-team', here.clock.now, { protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL, release: 'test', agentsRunning: 0, agentCount: 1, sleeps: false, heldAwake: false, ownerPushTokenHashes: [] })
    const remote = here.peers.noteAnswered('id-team', { name: 'researcher', activity: 'waiting', details: null })
    const copyOf = (name: string): PeerMove => ({
      moveId: 'pull:1', agent: { name, task: 't', model: 'stand-in', parent: 'human', createdBy: 'human', createdAt: 1, folder: { kind: 'absolute', path: '/etc' }, ownershipEpoch: 1, promptCacheLifetime: '5m', instructions: null },
      goal: null, goalNotes: '', conversation: null, waiting: [], memory: null,
    })

    answer = copyOf('somebody-else')
    await assert.rejects(here.peers.pull(remote.id), (error: CommandRefused) => error.code === 'forbidden' && /another agent/.test(error.message))
    answer = { agent: 'not one' }
    await assert.rejects(here.peers.pull(remote.id), (error: CommandRefused) => error.code === 'invalid_request')
    answer = copyOf('researcher')
    assert.equal((await here.peers.pull(remote.id)).copy.agent.name, 'researcher')
  } finally {
    shared.close()
  }
})

test("a Claude plan token goes only to the person's own computers, and only where it travels encrypted", async () => {
  const received: string[] = []
  const own = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      received.push(`${request.url} ${body}`)
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve))
  try {
    const here = server('sharer')
    const home = here.holdNetwork('private', 'home')
    const team = here.holdNetwork('shared', 'extra')
    const hello = (protocol: number) => ({ protocol, minProtocol: PEER_MIN_PROTOCOL, release: 'test', agentsRunning: 0, agentCount: 0, sleeps: false, heldAwake: false, ownerPushTokenHashes: [] })
    const peer = (name: string, address: string, networkId: string, protocol = PEER_PROTOCOL) => {
      here.store.savePeerInNetwork({ machineId: `id-${name}`, name, address, publicKey: 'k', networkId, visiting: false, ownerName: null, joinedAt: 1 })
      here.store.notePeerHello(`id-${name}`, here.clock.now, hello(protocol))
    }
    peer('own', `http://127.0.0.1:${(own.address() as AddressInfo).port}`, home.id)
    peer('cleartext', 'http://192.168.1.2:7777', home.id)
    peer('old', 'http://100.64.0.9:7777', home.id, PEER_CLAUDE_TOKEN_PROTOCOL - 1)
    peer('teammate', `http://127.0.0.1:${(own.address() as AddressInfo).port}`, team.id)

    const token = `sk-ant-oat01-${'a'.repeat(40)}`
    const sent = await here.peers.shareClaudeToken(token)
    assert.deepEqual(sent.map((computer) => [computer.name, computer.shared]).sort(), [['cleartext', false], ['old', false], ['own', true]], "another person's computer isn't sent it at all")
    assert.match(sent.find((computer) => computer.name === 'cleartext')!.why ?? '', /in the clear/)
    assert.match(sent.find((computer) => computer.name === 'old')!.why ?? '', /update/)
    assert.deepEqual(received, [`${PEER_API_PREFIX}/claude-token ${JSON.stringify({ token })}`])
  } finally {
    own.close()
  }
})

test('a Claude plan token is taken only in its own shape', async () => {
  const here = server('taker')
  const row = { machineId: 'id-x' } as never
  await assert.rejects(here.peers.receiveClaudeToken(row, { token: 'sk-ant-api03-not-a-plan-token-xxxxxxxxxx' }), (error: PeerRequestRefused) => error.code === 'invalid_request')
})
