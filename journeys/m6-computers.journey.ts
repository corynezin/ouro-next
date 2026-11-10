// Two of the person's computers, each a real server: one invites, the other joins with the command it was given, and
// each then lists the other with its status. Requests between them are signed, and a replayed, forged or stale one is
// refused. An invite works once and for 30 minutes. Removing tells the other side. A computer that stops answering reads
// as reconnecting, then offline, and comes back by itself. A computer whose protocol this one can't speak is flagged,
// and nothing but hellos passes between them until one is updated.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { PEER_API_PREFIX, PEER_MIN_PROTOCOL, PEER_PROTOCOL } from '@ouro/contract'
import type { ComputerEntity, PeerError, PeerHello, PeerIdentity, PeerJoinRequest } from '@ouro/contract'
import { signatureHeaders } from '../server/src/adapters/peer-transport.ts'
import { CommandFailed, JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const computerNamed = async (phone: AppClient, name: string): Promise<ComputerEntity | undefined> => (await phone.snapshot()).computers.find((computer) => computer.name === name)

/** Beta joins alpha with a fresh invite, through the command line as a person would. */
async function joinBetaToAlpha(): Promise<void> {
  const invite = await alphaPhone.command('create_computer_invite', {})
  const [, , , address, code] = invite.command.split(' ')
  assert.equal(invite.command, `ouro computers join ${alpha.url} ${code}`)
  const joined = await beta.cli('computers', 'join', address!, code!)
  assert.match(joined, /^joined: alpha: /)
}

/** Beta is a peer of alpha, online, whatever earlier tests did. */
async function ensureJoined(): Promise<string> {
  if (!(await computerNamed(alphaPhone, 'beta'))) await joinBetaToAlpha()
  return (await waitFor('beta online at alpha', async () => {
    const found = await computerNamed(alphaPhone, 'beta')
    return found?.status === 'online' ? found : null
  })).id
}

test('a computer joins with the invite command, and each lists the other online with what it runs', async () => {
  await joinBetaToAlpha()
  const seenFromAlpha = await waitFor('beta online at alpha', async () => {
    const beta = await computerNamed(alphaPhone, 'beta')
    return beta?.status === 'online' && beta.agentCount !== null ? beta : null
  })
  assert.equal(seenFromAlpha.trust, 'full')
  assert.equal(seenFromAlpha.incompatibility, null)
  assert.equal(seenFromAlpha.agentCount, 1, "beta's master agent")
  const seenFromBeta = await waitFor('alpha online at beta', async () => {
    const alpha = await computerNamed(betaPhone, 'alpha')
    return alpha?.status === 'online' ? alpha : null
  })
  assert.equal(seenFromBeta.trust, 'full')
  assert.match(await alpha.cli('computers'), /^beta: online, full trust, \d+ of 1 agents running\n$/)
})

test('an invite works once, and not after 30 minutes', async () => {
  const invite = await alphaPhone.command('create_computer_invite', {})
  const code = invite.command.split(' ').at(-1)!
  const intruder = new JourneyRun()
  intruder.addServerEnv({ OURO_MACHINE_NAME: 'gamma' })
  try {
    await intruder.startServer()
    const intruderPhone = await intruder.pairDevice()
    await intruderPhone.command('join_computer', { address: alpha.url, code })
    await assert.rejects(intruderPhone.command('join_computer', { address: alpha.url, code }), (error: CommandFailed) => error.code === 'forbidden')
    await intruderPhone.command('remove_computer', { computerId: (await computerNamed(intruderPhone, 'alpha'))!.id })

    const late = (await alphaPhone.command('create_computer_invite', {})).command.split(' ').at(-1)!
    alpha.advanceClock(31 * 60_000)
    await assert.rejects(intruderPhone.command('join_computer', { address: alpha.url, code: late }), (error: CommandFailed) => error.code === 'forbidden' && /expired/.test(error.message))
  } finally {
    alpha.advanceClock(-31 * 60_000)
    await intruder.cleanup()
  }
  assert.equal(await computerNamed(alphaPhone, 'gamma'), undefined, 'removed from both sides')
})

test("only a known computer's fresh signature is believed: unsigned, forged, stale and replayed requests are refused", async () => {
  const betaId = await ensureJoined()
  const hello = JSON.stringify({ protocol: 1, minProtocol: 1, release: 'r', agentsRunning: 0, agentCount: 0, sleeps: false, heldAwake: false, ownerPushTokenHashes: [] } satisfies PeerHello)
  const path = `${PEER_API_PREFIX}/hello`
  const post = (headers: Record<string, string>) => fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: hello })
  const betaPrivate = createPrivateKey(readFileSync(join(beta.dataDir, 'identity', 'machine-key.pem')))
  const betaKey = { privateKey: betaPrivate, publicKeyPem: createPublicKey(betaPrivate).export({ type: 'spki', format: 'pem' }).toString() }

  assert.equal((await post({})).status, 401, 'unsigned')
  const forger = generateKeyPairSync('ed25519').privateKey
  assert.equal((await post(signatureHeaders({ privateKey: forger, publicKeyPem: '' }, betaId, 'POST', path, hello, Date.now()))).status, 401, "signed with another key, claiming to be beta")
  assert.equal((await post(signatureHeaders(betaKey, betaId, 'POST', path, hello, Date.now() - 5 * 60_000))).status, 401, 'five minutes old')
  const genuine = signatureHeaders(betaKey, betaId, 'POST', path, hello, Date.now())
  assert.equal((await post(genuine)).status, 200, "beta's own")
  assert.equal((await post(genuine)).status, 401, 'the same request again')
  const tampered = await fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(betaKey, betaId, 'POST', path, hello, Date.now()) }, body: hello.replace('"r"', '"x"') })
  assert.equal(tampered.status, 401, 'a body changed after signing')
})

test('a computer that stops answering reads as reconnecting, then offline, and comes back by itself', async () => {
  await ensureJoined()
  await beta.killServer()
  alpha.advanceClock(15_000)
  await waitFor('beta reconnecting', async () => (await computerNamed(alphaPhone, 'beta'))?.status === 'reconnecting')
  alpha.advanceClock(40_000)
  await waitFor('beta offline', async () => (await computerNamed(alphaPhone, 'beta'))?.status === 'offline')
  alpha.advanceClock(-55_000)
  await beta.startServer()
  await waitFor('beta online again', async () => (await computerNamed(alphaPhone, 'beta'))?.status === 'online', 30_000)
})

test("a computer this one can't work with is refused at joining, flagged once it says so, and sent nothing but hellos", async () => {
  // Delta is played here, so it can speak protocols no release speaks yet. Nothing listens at its address.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const deltaKey = { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const delta: PeerIdentity = { machineId: 'delta-machine', name: 'delta', address: 'http://127.0.0.1:9', publicKey: deltaKey.publicKeyPem, protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL }
  const join = async (joiner: PeerIdentity): Promise<Response> => {
    const code = (await alphaPhone.command('create_computer_invite', {})).command.split(' ').at(-1)!
    return await fetch(`${alpha.url}${PEER_API_PREFIX}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, joiner } satisfies PeerJoinRequest) })
  }
  const fromDelta = async (route: string, body: unknown): Promise<Response> => {
    const path = `${PEER_API_PREFIX}${route}`
    const text = JSON.stringify(body)
    return await fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(deltaKey, delta.machineId, 'POST', path, text, Date.now()) }, body: text })
  }
  const helloSpeaking = (protocol: number, minProtocol: number): PeerHello => ({ protocol, minProtocol, release: `delta speaking ${protocol}`, agentsRunning: 0, agentCount: 0, sleeps: false, heldAwake: false, ownerPushTokenHashes: [] })
  const deltaAtAlpha = (release: string) => waitFor(`delta at alpha, ${release}`, async () => {
    const found = await computerNamed(alphaPhone, 'delta')
    return found?.release === release ? found : null
  })

  const tooOld = await join({ ...delta, protocol: PEER_MIN_PROTOCOL - 1, minProtocol: PEER_MIN_PROTOCOL - 1 })
  assert.equal(tooOld.status, 409)
  const tooOldRefusal = (await tooOld.json()) as PeerError
  assert.equal(tooOldRefusal.error.code, 'incompatible')
  assert.match(tooOldRefusal.error.message, /update it/)
  assert.equal(await computerNamed(alphaPhone, 'delta'), undefined, 'not kept')

  assert.equal((await join(delta)).status, 200)
  assert.equal((await fromDelta('/hello', helloSpeaking(PEER_PROTOCOL, PEER_MIN_PROTOCOL))).status, 200)
  assert.equal((await deltaAtAlpha(`delta speaking ${PEER_PROTOCOL}`)).incompatibility, null)
  assert.equal((await fromDelta('/agents', {})).status, 200)

  // Delta is updated to a protocol this release doesn't speak.
  const newer = PEER_PROTOCOL + 1
  assert.equal((await fromDelta('/hello', helloSpeaking(newer, newer))).status, 200, 'a hello is answered whatever the versions')
  const flagged = await deltaAtAlpha(`delta speaking ${newer}`)
  assert.equal(flagged.incompatibility, `It needs protocol ${newer} or newer and this server speaks ${PEER_PROTOCOL}: update this server.`)
  assert.match(await alpha.cli('computers'), new RegExp(`^delta: online, full trust, 0 of 0 agents running \\(It needs protocol ${newer} or newer and this server speaks ${PEER_PROTOCOL}: update this server\\.\\)$`, 'm'))
  const refused = await fromDelta('/agents', {})
  assert.equal(refused.status, 409)
  assert.equal(((await refused.json()) as PeerError).error.code, 'incompatible')
  const someAgent = (await alphaPhone.snapshot()).agents[0]!
  await assert.rejects(alphaPhone.command('move_agent', { agentId: someAgent.id, computerId: flagged.id }), (error: CommandFailed) => error.code === 'peer_incompatible' && /update this server/.test(error.message))

  // And back on a protocol both speak, they work together again.
  assert.equal((await fromDelta('/hello', helloSpeaking(PEER_PROTOCOL, PEER_MIN_PROTOCOL))).status, 200)
  assert.equal((await deltaAtAlpha(`delta speaking ${PEER_PROTOCOL}`)).incompatibility, null)
  assert.equal((await fromDelta('/agents', {})).status, 200)
  await alphaPhone.command('remove_computer', { computerId: flagged.id })
  assert.equal(await computerNamed(alphaPhone, 'delta'), undefined)
})

test('trust can be limited, and removing a computer takes it off both sides', async () => {
  const betaId = await ensureJoined()
  const limited = await alphaPhone.command('set_computer_trust', { computerId: betaId, trust: 'limited' })
  assert.equal(limited.computer.trust, 'limited')
  assert.match(await alpha.cli('computers', 'remove', 'beta'), /^beta removed\. Nothing on it was deleted\.\n$/)
  assert.equal(await computerNamed(alphaPhone, 'beta'), undefined)
  await waitFor('alpha gone at beta', async () => (await computerNamed(betaPhone, 'alpha')) === undefined)
})

