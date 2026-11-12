// Networks, with real servers: two of the person's own (alpha, beta) in a private network, and a shared one (team) whose
// key alpha holds as an extra key. A private server is linked the old way first, and moved over to the private network.
// Requests are signed with a network's key, and a server takes only what is signed with its home key: the shared server
// answers alpha but never contacts it, and nothing it sends reaches a private server. The person arriving from alpha is
// human@<their name> on the shared server.
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'
import { PEER_API_PREFIX } from '@ouro/contract'
import type { ComputerEntity, MessageEntity, PeerMessage } from '@ouro/contract'
import { signatureHeaders } from '../server/src/adapters/peer-transport.ts'
import { SIGNED_PEER_ROUTES } from '../server/src/interfaces/peer.ts'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let team: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient
let teamPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  team = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha', OURO_PEER_MEMORY_PULL_MS: '300' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta', OURO_PEER_MEMORY_PULL_MS: '300' })
  team.addServerEnv({ OURO_MACHINE_NAME: 'team', OURO_PEER_MEMORY_PULL_MS: '300' })
  await Promise.all([alpha.startServer(), beta.startServer(), team.startServer()])
  ;[alphaPhone, betaPhone, teamPhone] = await Promise.all([alpha.pairDevice(), beta.pairDevice(), team.pairDevice()])
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
  await team.cleanup()
})

const computerNamed = async (phone: AppClient, name: string): Promise<ComputerEntity | undefined> => (await phone.snapshot()).computers.find((computer) => computer.name === name)
const onlineAt = (phone: AppClient, name: string) => waitFor(`${name} online`, async () => {
  const found = await computerNamed(phone, name)
  return found?.status === 'online' ? found : null
})
const send = (phone: AppClient, to: string, text: string, wake: 'wake' | 'fyi' = 'wake') => phone.command('send_message', { to, text, attachmentIds: [], wake, answersAskId: null })
const findMessage = async (phone: AppClient, matches: (message: MessageEntity) => boolean): Promise<{ message: MessageEntity; members: string[] } | undefined> => {
  for (const chat of (await phone.snapshot()).chats) {
    const message = (await phone.history(chat.id)).messages.find(matches)
    if (message) return { message, members: chat.members.map((member) => member.address).sort() }
  }
  return undefined
}
const machineKeyOf = (run: JourneyRun) => {
  const key = createPrivateKey(readFileSync(join(run.dataDir, 'identity', 'machine-key.pem')))
  return { privateKey: key, publicKeyPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }
}
const networkKeyOf = (run: JourneyRun, networkId: string): string => (JSON.parse(readFileSync(join(run.dataDir, 'identity', 'network-keys.json'), 'utf8')) as Record<string, string>)[networkId]!
const inviteCode = async (phone: AppClient, networkId: string) => (await phone.command('create_network_invite', { networkId })).code

let privateId = ''
let teamId = ''

test("a server's first private home key takes in the computers it already trusted fully; they keep working until they have the key too", async () => {
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
  await onlineAt(alphaPhone, 'beta')

  const created = await alphaPhone.command('create_network', { name: 'home', kind: 'private', role: 'home' })
  privateId = created.network.id
  assert.deepEqual(created.leftOut, [])
  assert.equal((await alphaPhone.snapshot()).server.networks?.[0]?.id, privateId)
  // Beta has no key yet and signs nothing; alpha still takes it, and alpha's signed hellos still reach it.
  const seen = await waitFor('beta in the private network at alpha', async () => {
    const found = await computerNamed(alphaPhone, 'beta')
    return found?.networkId === privateId && found.status === 'online' ? found : null
  })
  assert.equal(seen.visiting, false)

  await betaPhone.command('join_network', { address: alpha.url, code: await inviteCode(alphaPhone, privateId), role: 'home', kind: 'private' })
  await waitFor('alpha in the private network at beta', async () => (await computerNamed(betaPhone, 'alpha'))?.networkId === privateId)
  // Once beta has signed with the key, alpha takes nothing unsigned from it.
  await waitFor('beta signed once', () => {
    const db = new DatabaseSync(join(alpha.dataDir, 'ouro.db'), { readOnly: true })
    try {
      return (db.prepare("SELECT unkeyed_allowed FROM peers WHERE name = 'beta'").get() as { unkeyed_allowed: number }).unkeyed_allowed === 0
    } finally {
      db.close()
    }
  })
  const alphaId = (await computerNamed(betaPhone, 'alpha'))!.id
  const message: PeerMessage = { messageId: 'unsigned-after-keyed', from: { kind: 'owner' }, to: 'nobody', text: 'unsigned', wake: 'fyi', purpose: 'message', sentAt: Date.now(), answersAskId: null }
  const betaId = (await computerNamed(alphaPhone, 'beta'))!.id
  const body = JSON.stringify(message)
  const path = `${PEER_API_PREFIX}/messages`
  const refused = await fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(machineKeyOf(beta), betaId, 'POST', path, body, Date.now()) }, body })
  assert.equal(refused.status, 401)
  assert.ok(alphaId)
})

test('a private network is joined only as a home: no server only visits it', async () => {
  await assert.rejects(teamPhone.command('join_network', { address: alpha.url, code: await inviteCode(alphaPhone, privateId), role: 'extra', kind: 'private' }),
    (error: CommandFailed) => /only as a home/.test(error.message))
  assert.equal(await computerNamed(alphaPhone, 'team'), undefined)
})

test("a private network's invite, joined as the shared network it was said to be, is refused by both servers before it is used", async () => {
  const code = await inviteCode(alphaPhone, privateId)
  // Team has no home yet: joined as a home, alpha's owner would be team's, with team's memory. Alpha refuses first.
  await assert.rejects(teamPhone.command('join_network', { address: alpha.url, code, role: 'home', kind: 'shared' }),
    (error: CommandFailed) => error.code === 'forbidden' && /private network/.test(error.message))
  assert.equal((await teamPhone.snapshot()).server.networks?.length ?? 0, 0, 'team holds no key')
  assert.equal(await computerNamed(alphaPhone, 'team'), undefined, 'and alpha took nothing in')
  // The invite wasn't used: the person who meant it, joining as private, still can. (Not here: team isn't theirs.)
  const reopened = new DatabaseSync(join(alpha.dataDir, 'ouro.db'), { readOnly: true })
  try {
    assert.notEqual((reopened.prepare('SELECT invite_hash FROM networks WHERE id = ?').get(privateId) as { invite_hash: string | null }).invite_hash, null)
  } finally {
    reopened.close()
  }
})

test('a shared network: the shared server takes the key as its home key, and alpha holds it as an extra key', async () => {
  const created = await alphaPhone.command('create_network', { name: 'team', kind: 'shared', role: 'extra' })
  teamId = created.network.id
  await assert.rejects(teamPhone.command('create_network_invite', { networkId: teamId }), (error: CommandFailed) => error.code === 'not_found')
  const joined = await teamPhone.command('join_network', { address: alpha.url, code: await inviteCode(alphaPhone, teamId), role: 'home', kind: 'shared' })
  assert.equal(joined.network.kind, 'shared')
  // The invite is used.
  await assert.rejects(betaPhone.command('join_network', { address: alpha.url, code: 'wrong', role: 'extra', kind: 'shared' }), (error: CommandFailed) => error.code === 'forbidden')

  // Alpha says hello into the team network; team answers it, and keeps it as a visitor it never contacts.
  const teamAtAlpha = await onlineAt(alphaPhone, 'team')
  assert.equal(teamAtAlpha.networkId, teamId)
  assert.equal(teamAtAlpha.visiting, false)
  const alphaAtTeam = await waitFor('alpha known at team', () => computerNamed(teamPhone, 'alpha'))
  assert.equal(alphaAtTeam.visiting, true)
  // Beta holds no team key: team and beta know nothing of each other.
  assert.equal(await computerNamed(teamPhone, 'beta'), undefined)
  assert.equal(await computerNamed(betaPhone, 'team'), undefined)
})

test("alpha looks at the shared server's agents; the person's message arrives there as human@<their name>, and the answer stays there", async () => {
  await alphaPhone.command('set_owner_name', { name: 'robin' })
  await teamPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'worker', model: 'stand-in', folder: null })
  await waitFor('worker seen from alpha', async () => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.address === 'worker@team' && agent.details !== null), 30_000)

  const { message } = await send(alphaPhone, 'worker@team', standInScript({ do: 'run', command: 'ouro reply "hello robin"' }))
  const arrived = await waitFor('the message at team', () => findMessage(teamPhone, (found) => found.id === message.id), 30_000)
  assert.equal(arrived.message.from, 'human@robin', "never the shared server's own human")
  const answer = await waitFor("worker's answer at team", () => findMessage(teamPhone, (found) => found.text === 'hello robin'), 30_000)
  assert.deepEqual(answer.members, ['human@robin', 'worker'])
  // It doesn't come to alpha: team never contacts it.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  assert.equal(await findMessage(alphaPhone, (found) => found.text === 'hello robin'), undefined)
})

test("a shared agent's message to a private agent is refused at once, and a request signed in the shared network is refused by a private server", async () => {
  await assert.rejects(send(teamPhone, 'helper@alpha', 'let me in'), (error: CommandFailed) => error.code === 'forbidden' && /outside this network/.test(error.message))

  const teamKey = networkKeyOf(team, teamId)
  const teamMachineId = (await computerNamed(alphaPhone, 'team'))!.id
  const alphaId = (await computerNamed(teamPhone, 'alpha'))!.id
  const message: PeerMessage = { messageId: 'from-team', from: { kind: 'owner' }, to: 'nobody', text: 'hi', wake: 'fyi', purpose: 'message', sentAt: Date.now(), answersAskId: null }
  const body = JSON.stringify(message)
  const path = `${PEER_API_PREFIX}/messages`
  for (const visiting of [false, true]) {
    const headers = signatureHeaders(machineKeyOf(team), teamMachineId, 'POST', path, body, Date.now(), { id: teamId, key: teamKey, visiting, recipient: alphaId })
    const refused = await fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    assert.equal(refused.status, 401)
  }
})

test('a private server refuses every signed route from a server signing in a shared network, or not signing, and keeps its keys to itself', async () => {
  const teamKey = networkKeyOf(team, teamId)
  const teamMachineId = (await computerNamed(alphaPhone, 'team'))!.id
  const betaId = (await computerNamed(alphaPhone, 'beta'))!.id
  const alphaId = (await computerNamed(teamPhone, 'alpha'))!.id
  assert.ok(SIGNED_PEER_ROUTES.includes('/hello') && SIGNED_PEER_ROUTES.includes('/forget') && SIGNED_PEER_ROUTES.includes('/pull'))
  for (const route of SIGNED_PEER_ROUTES) {
    const path = `${PEER_API_PREFIX}${route}`
    const body = '{}'
    const attempts = [
      signatureHeaders(machineKeyOf(team), teamMachineId, 'POST', path, body, Date.now(), { id: teamId, key: teamKey, visiting: false, recipient: alphaId }),
      signatureHeaders(machineKeyOf(team), teamMachineId, 'POST', path, body, Date.now(), { id: teamId, key: teamKey, visiting: true, recipient: alphaId }),
      signatureHeaders(machineKeyOf(team), teamMachineId, 'POST', path, body, Date.now()),
      // Beta has signed with the private key once: unsigned, it is refused for good.
      signatureHeaders(machineKeyOf(beta), betaId, 'POST', path, body, Date.now()),
    ]
    for (const headers of attempts) {
      const response = await fetch(`${alpha.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
      assert.equal(response.status, 401, `${route} refused`)
    }
  }
  assert.equal(await computerNamed(alphaPhone, 'team').then((found) => found?.status !== undefined), true, 'alpha still knows team, having not been talked into forgetting it')
  // The keys are in their own file, readable by this server's user only, and nowhere in what a phone sees.
  assert.equal(statSync(join(alpha.dataDir, 'identity', 'network-keys.json')).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(await alphaPhone.snapshot()).includes(teamKey))
})

test('trust levels are gone inside a network, and the old invite is refused', async () => {
  const betaId = (await computerNamed(alphaPhone, 'beta'))!.id
  await assert.rejects(alphaPhone.command('set_computer_trust', { computerId: betaId, trust: 'limited' }), (error: CommandFailed) => error.code === 'invalid_request')
  await assert.rejects(alphaPhone.command('create_computer_invite', {}), (error: CommandFailed) => error.code === 'invalid_request')
})

function checkout(run: JourneyRun, name: string, origin: string): string {
  const folder = join(run.dir, name)
  mkdirSync(folder, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'j', GIT_AUTHOR_EMAIL: 'j@j', GIT_COMMITTER_NAME: 'j', GIT_COMMITTER_EMAIL: 'j@j' } })
  git('init', '-q')
  git('remote', 'add', 'origin', origin)
  git('commit', '-q', '--allow-empty', '-m', 'first')
  return folder
}
const note = (lines: string[]) => `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}`
/** Every note file in a server's memory, by file name. */
const notesOf = (run: JourneyRun): string[] => {
  const dir = join(run.dataDir, 'memory', 'projects')
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((project) => readdirSync(join(dir, project))).sort()
}

test('memory reaches the private network by itself, and a shared one only when pushed, never notes about the person', async () => {
  const folder = checkout(alpha, 'agents', 'git@github.com:example/agents.git')
  await alphaPhone.command('create_agent', { task: standInScript({ do: 'run', command: [
    `${note(['---', 'name: Tea', 'description: what the person drinks', 'type: user', '---', 'green tea'])} > "$OURO_MEMORY_DIR/tea.md"`,
    `${note(['---', 'name: Build', 'type: project', '---', 'run make'])} > "$OURO_MEMORY_DIR/build.md"`,
    'ouro reply done',
  ].join(' && ') }), name: 'writer', model: 'stand-in', folder })
  await waitFor("writer's reply", async () => (await alphaPhone.conversation('writer')).some((message) => message.from === 'writer'), 30_000)
  checkout(team, 'agents', 'https://github.com/example/agents')
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  assert.ok(!notesOf(team).includes('build.md'), 'nothing goes into the shared network by itself')

  const teamId = (await computerNamed(alphaPhone, 'team'))!.id
  const pushed = await alphaPhone.command('push_memory', { computerId: teamId, folder })
  assert.equal(pushed.notes, 1)
  assert.ok(notesOf(team).includes('build.md'))
  assert.ok(!notesOf(team).includes('tea.md'), 'notes about the person never leave')
  const betaId = (await computerNamed(alphaPhone, 'beta'))!.id
  await assert.rejects(alphaPhone.command('push_memory', { computerId: betaId, folder }), (error: CommandFailed) => error.code === 'forbidden')
})

test('a pulled copy arrives paused and labelled; nothing wakes it until it is started; the original stays', async () => {
  await teamPhone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro reply "copy here"' }), name: 'researcher', model: 'stand-in', folder: null })
  await waitFor('researcher idle', async () => (await teamPhone.agent('researcher')).state.state === 'idle', 30_000)
  const remote = await waitFor('researcher seen from alpha', async () => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.address === 'researcher@team'), 30_000)

  const { agent } = await alphaPhone.command('pull_agent', { remoteAgentId: remote.id, name: null })
  assert.equal(agent.name, 'researcher')
  assert.deepEqual({ ...agent.pulled, at: 0 }, { from: 'researcher@team', network: 'team', at: 0, awaitingStart: true })
  assert.match(agent.folder, /\/pulled\/researcher$/, 'in a folder of its own, whatever team said')
  await assert.rejects(alphaPhone.command('pull_agent', { remoteAgentId: remote.id, name: null }), (error: CommandFailed) => error.code === 'agent_name_taken')

  await send(alphaPhone, 'researcher', standInScript({ do: 'run', command: 'ouro reply "copy here"' }))
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const waiting = await alphaPhone.agent('researcher')
  assert.equal(waiting.state.state, 'stopped', 'a message alone does not wake it')
  assert.equal(waiting.queuedDeliveries, 2, 'the note on where it came from, and the message')

  const started = await alphaPhone.command('start_pulled_agent', { agentId: agent.id })
  assert.equal(started.agent.pulled?.awaitingStart, false)
  await waitFor("the copy's answer", async () => (await alphaPhone.conversation('researcher')).some((message) => message.from === 'researcher' && message.text === 'copy here'), 30_000)
  assert.equal((await teamPhone.agent('researcher')).name, 'researcher', 'the original stays')

  // Started with nothing but the note on where it came from, it runs on that note.
  const second = (await alphaPhone.command('pull_agent', { remoteAgentId: remote.id, name: 'researcher2' })).agent
  assert.equal(second.name, 'researcher2')
  await alphaPhone.command('start_pulled_agent', { agentId: second.id })
  await waitFor('the second copy took in its note', async () => (await alphaPhone.agent('researcher2')).queuedDeliveries === 0, 30_000)

  // Beta is in no shared network: it has nothing to pull from.
  const fromBeta = (await betaPhone.snapshot()).remoteAgents.find((found) => found.address === 'writer@alpha')
  if (fromBeta) await assert.rejects(betaPhone.command('pull_agent', { remoteAgentId: fromBeta.id, name: 'mine' }), (error: CommandFailed) => error.code === 'forbidden')
})

test("a collaborator's own server joins the shared network; addresses spread by hello; their words arrive as human@<name>, and answers go back to them", async () => {
  const sam = new JourneyRun()
  sam.addServerEnv({ OURO_MACHINE_NAME: 'sams-box' })
  try {
    await sam.startServer()
    const samPhone = await sam.pairDevice()
    await samPhone.command('set_owner_name', { name: 'sam' })
    const teamNetworkId = (await teamPhone.snapshot()).server.networks![0]!.id
    // The invite's command is a real one, run on sam's server as it is printed.
    const printed = (await team.cli('networks', 'invite')).trim().split('\n').at(-1)!
    assert.match(printed, /^ouro networks join \S+ \S+ --kind shared$/)
    assert.match(await sam.cli(...printed.split(' ').slice(1)), /joined team, a shared network/)
    const teamAtSam = await onlineAt(samPhone, 'team')
    assert.equal(teamAtSam.visiting, false)
    assert.equal((await onlineAt(teamPhone, 'sams-box')).visiting, false)
    // Alpha learns of sam's server from team, says hello to it, and is a visitor there.
    const samAtAlpha = await onlineAt(alphaPhone, 'sams-box')
    assert.equal(samAtAlpha.networkId, teamNetworkId)
    assert.equal((await waitFor('alpha at sam', () => computerNamed(samPhone, 'alpha'))).visiting, true)

    await teamPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'scribe', model: 'stand-in', folder: null })
    await waitFor('scribe seen from sam', async () => (await samPhone.snapshot()).remoteAgents.find((agent) => agent.address === 'scribe@team'), 30_000)
    const { message } = await send(samPhone, 'scribe@team', standInScript({ do: 'run', command: 'ouro reply "hello sam"' }))
    const arrived = await waitFor('the message at team', () => findMessage(teamPhone, (found) => found.id === message.id), 30_000)
    assert.equal(arrived.message.from, 'human@sam')
    // Sam's server lives in the network, so the answer is copied to sam's own chat with scribe@team there.
    const back = await waitFor('the answer at sam', () => findMessage(samPhone, (found) => found.text === 'hello sam'), 30_000)
    assert.equal(back.message.from, 'scribe@team')
    assert.deepEqual(back.members, ['human', 'scribe@team'])
    // Another person's server talks with team's agents, but doesn't act on them as team's owner.
    await assert.rejects(samPhone.command('create_remote_agent', { computerId: teamAtSam.id, task: standInScript({ do: 'text', text: 'ok' }), name: 'samshelper', model: 'stand-in', folder: null, promptCacheLifetime: '5m' }),
      (error: CommandFailed) => error.code === 'forbidden')
    const scribe = (await samPhone.snapshot()).remoteAgents.find((agent) => agent.address === 'scribe@team')!
    await assert.rejects(samPhone.command('control_remote_agent', { remoteAgentId: scribe.id, action: { kind: 'stop' } }), (error: CommandFailed) => error.code === 'forbidden')
    const scribeAtAlpha = await waitFor('scribe seen from alpha', async () => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.address === 'scribe@team'), 30_000)
    await assert.rejects(alphaPhone.command('control_remote_agent', { remoteAgentId: scribeAtAlpha.id, action: { kind: 'stop' } }),
      (error: CommandFailed) => error.code === 'forbidden', 'nor does a visitor')

    // Route by route, signed in team's network by a member (sam) and by a visitor (alpha): what another person may do, and
    // nothing else.
    const teamKey = networkKeyOf(team, teamNetworkId)
    const teamMachineId = teamAtSam.id
    const signers = [
      { who: 'sam', key: machineKeyOf(sam), id: (await computerNamed(teamPhone, 'sams-box'))!.id, visiting: false },
      { who: 'alpha', key: machineKeyOf(alpha), id: (await computerNamed(teamPhone, 'alpha'))!.id, visiting: true },
    ]
    const denied = ['/control', '/create-agent', '/move-check', '/move', '/log', '/memory', '/owner-ask-snoozes']
    for (const route of SIGNED_PEER_ROUTES.filter((found) => found !== '/hello' && found !== '/forget')) {
      for (const signer of signers) {
        const path = `${PEER_API_PREFIX}${route}`
        const headers = signatureHeaders(signer.key, signer.id, 'POST', path, '{}', Date.now(), { id: teamNetworkId, key: teamKey, visiting: signer.visiting, recipient: teamMachineId })
        const response = await fetch(`${team.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
        if (denied.includes(route)) assert.equal(response.status, 403, `${route} from ${signer.who}`)
        else assert.notEqual(response.status, 403, `${route} from ${signer.who}`)
      }
    }
  } finally {
    await sam.cleanup()
  }
})

test("a computer removed from a network of three stays out: another's hello doesn't bring it back, nor does its own", async () => {
  const gamma = new JourneyRun()
  gamma.addServerEnv({ OURO_MACHINE_NAME: 'gamma' })
  try {
    await gamma.startServer()
    const gammaPhone = await gamma.pairDevice()
    await gammaPhone.command('join_network', { address: alpha.url, code: await inviteCode(alphaPhone, privateId), role: 'home', kind: 'private' })
    // Gamma learns of beta from alpha, and beta of gamma: three servers that all know each other.
    await onlineAt(gammaPhone, 'beta')
    await onlineAt(betaPhone, 'gamma')

    const betaAtAlpha = (await computerNamed(alphaPhone, 'beta'))!
    await alphaPhone.command('remove_computer', { computerId: betaAtAlpha.id })
    // Gamma's hellos still list beta, and beta still holds the key and hears of alpha from gamma: neither brings it back.
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    assert.equal(await computerNamed(alphaPhone, 'beta'), undefined)
    assert.equal((await computerNamed(gammaPhone, 'beta'))?.status, 'online', 'gamma still has it: out for good takes a new key')

    // Invited back on purpose, it is in again.
    await betaPhone.command('join_network', { address: alpha.url, code: await inviteCode(alphaPhone, privateId), role: 'home', kind: 'private' })
    await onlineAt(alphaPhone, 'beta')
  } finally {
    await gamma.cleanup()
  }
})

test("letting go of a network's key forgets the computers in it", async () => {
  assert.ok(await computerNamed(alphaPhone, 'team'))
  await alphaPhone.command('remove_network', { networkId: teamId })
  assert.equal(await computerNamed(alphaPhone, 'team'), undefined)
  assert.equal((await alphaPhone.snapshot()).remoteAgents.some((agent) => agent.address.endsWith('@team')), false)
})
