// Moving an agent between two of the person's computers, each a real server: it goes whole, with its conversation, goal,
// its project's shared notes and the messages it hadn't taken in, and wakes there; its old address forwards. A move waits for the end of the turn,
// a move that can't reach the other computer leaves it in place and tells it, and only a computer that trusts this one
// fully, with its name free, takes one.
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, MessageEntity, PeerMove } from '@ouro/contract'
import type { z } from 'zod'
import { OWNER_ADDRESS, PEER_API_PREFIX } from '@ouro/contract'
import { signatureHeaders } from '../server/src/adapters/peer-transport.ts'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'
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
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const betaIdAtAlpha = async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
const alphaIdAtBeta = async () => (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
const agentAt = async (phone: AppClient, name: string): Promise<AgentEntity | undefined> => (await phone.snapshot()).agents.find((agent) => agent.name === name && agent.state.state !== 'archived')
const move = async (name: string) => alphaPhone.command('move_agent', { agentId: (await alphaPhone.agent(name)).id, computerId: await betaIdAtAlpha() })
const send = (phone: AppClient, to: string, text: string, wake: 'wake' | 'fyi' = 'wake') => phone.command('send_message', { to, text, attachmentIds: [], wake, answersAskId: null })
const messageIn = async (phone: AppClient, agentName: string, matches: (message: MessageEntity) => boolean) => (await phone.conversation(agentName)).find(matches)
/** A system notice to an agent, which is in its chat with the system. */
const noticeTo = async (phone: AppClient, agentName: string, startsWith: string): Promise<MessageEntity | undefined> => {
  for (const chat of (await phone.snapshot()).chats) {
    if (!chat.members.some((member) => member.address === agentName)) continue
    const found = (await phone.history(chat.id)).messages.find((message) => message.purpose === 'system_notice' && message.text.startsWith(startsWith))
    if (found) return found
  }
  return undefined
}

async function readyAgent(name: string, task = standInScript({ do: 'text', text: 'ready' }), folder: string | null = null): Promise<AgentEntity> {
  await alphaPhone.command('create_agent', { task, name, model: 'stand-in', folder })
  return await waitFor(`${name} idle`, async () => {
    const agent = await alphaPhone.agent(name)
    return agent.state.state === 'idle' && agent.queuedDeliveries === 0 ? agent : null
  }, 30_000)
}

test('an agent moves whole: its conversation, goal and waiting messages go, it wakes there, and its old address forwards', async () => {
  const traveler = await readyAgent('traveler', `remember the word heliotrope\n${standInScript({ do: 'text', text: 'noted' })}`)
  await alphaPhone.command('set_goal', { agentId: traveler.id, text: 'map the coast', kind: { kind: 'finishing' }, intervalSeconds: null })
  await alphaPhone.command('pause_goal', { agentId: traveler.id, reason: null })
  await alphaPhone.command('stop_agent', { agentId: traveler.id })
  await waitFor('traveler stopped', async () => (await alphaPhone.agent('traveler')).state.state === 'stopped')
  const { message: waiting } = await send(alphaPhone, 'traveler', 'read this when you can', 'fyi')

  const { agent: moving } = await move('traveler')
  assert.equal(moving.state.state, 'moving')
  const moved = await waitFor('moved at alpha', async () => {
    const found = (await alphaPhone.snapshot()).agents.find((agent) => agent.id === traveler.id)
    return found?.state.state === 'moved' ? found.state : null
  }, 30_000)
  assert.equal(moved.to, 'traveler@beta')

  const arrived = await waitFor('traveler at beta', () => agentAt(betaPhone, 'traveler'))
  assert.equal(arrived.parent, OWNER_ADDRESS)
  const atBeta = (await betaPhone.conversation('traveler')).find((message) => message.id === waiting.id)
  assert.equal(atBeta?.from, OWNER_ADDRESS, 'the waiting message keeps its id and sender')
  assert.ok(await noticeTo(betaPhone, 'traveler', 'You were moved from alpha to beta. Your conversation came with you'), 'it is told where it is now')
  const goal = (await betaPhone.snapshot()).goals.find((candidate) => candidate.agentId === arrived.id)
  assert.equal(goal?.text, 'map the coast')
  assert.equal(goal?.status.status, 'paused')

  await send(betaPhone, 'traveler', standInScript({ do: 'run', command: 'ouro reply "recalled: $(printf %s "$OURO_STANDIN_HISTORY" | grep -o heliotrope | head -1)"' }))
  await waitFor('it remembers its conversation from alpha', () => messageIn(betaPhone, 'traveler', (message) => message.text === 'recalled: heliotrope'), 30_000)

  const { message: forwarded } = await send(alphaPhone, 'traveler', 'to your old address', 'fyi')
  assert.deepEqual(forwarded.remoteDeliveries.map((delivery) => delivery.recipient), ['traveler@beta'])
  await waitFor('forwarded to beta', () => messageIn(betaPhone, 'traveler', (message) => message.id === forwarded.id))
  await waitFor('alpha lists it as on beta', async () => /^traveler@beta {2}running: idle/m.test(await alpha.cli('list')))
  assert.doesNotMatch(await alpha.cli('list'), /^traveler {2}/m, 'no longer one of its own')
})

test("a move takes its project's shared notes where the other computer lacks them, and not the person's own", async () => {
  const folder = join(alpha.dir, 'harbor')
  mkdirSync(folder)
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'j', GIT_AUTHOR_EMAIL: 'j@j', GIT_COMMITTER_NAME: 'j', GIT_COMMITTER_EMAIL: 'j@j' } })
  git('init', '-q')
  git('remote', 'add', 'origin', 'git@github.com:example/harbor.git')
  git('commit', '-q', '--allow-empty', '-m', 'first')
  const projectMemoryAt = (run: JourneyRun) => join(run.dataDir, 'memory', 'projects', 'github.com+example+harbor')
  const noteText = (name: string, type: string, body: string) => `---\nname: ${name}\ntype: ${type}\n---\n${body}\n`
  mkdirSync(projectMemoryAt(beta), { recursive: true })
  writeFileSync(join(projectMemoryAt(beta), 'deploy.md'), noteText('Deploy', 'project', 'deploy from beta'))

  const write = (file: string, text: string) => `printf %s '${text}' > "$OURO_MEMORY_DIR/${file}"`
  await readyAgent('scribe', standInScript({ do: 'run', command: [
    write('build.md', noteText('Build', 'project', 'run make')),
    write('deploy.md', noteText('Deploy', 'project', 'deploy from alpha')),
    write('tea.md', noteText('Tea', 'user', 'green tea')),
    'ouro memory sync',
    'ouro reply "noted"',
  ].join(' && ') }), folder)
  assert.equal(readFileSync(join(projectMemoryAt(alpha), 'build.md'), 'utf8'), noteText('Build', 'project', 'run make'))

  await move('scribe')
  await waitFor('scribe at beta', () => agentAt(betaPhone, 'scribe'), 30_000)
  assert.equal(readFileSync(join(projectMemoryAt(beta), 'build.md'), 'utf8'), noteText('Build', 'project', 'run make'), 'a shared note beta lacked')
  assert.equal(readFileSync(join(projectMemoryAt(beta), 'deploy.md'), 'utf8'), noteText('Deploy', 'project', 'deploy from beta'), "beta's own stays")
  assert.equal(existsSync(join(projectMemoryAt(beta), 'tea.md')), false, "the person's note isn't carried")

  await send(betaPhone, 'scribe', standInScript({ do: 'run', command: 'ouro reply "recalled: $(tail -n 1 "$OURO_MEMORY_DIR/build.md")"' }))
  await waitFor('it reads the note on beta', () => messageIn(betaPhone, 'scribe', (message) => message.text === 'recalled: run make'), 30_000)
})

test('a moved agent keeps its 1 hour prompt cache lifetime', async () => {
  await alphaPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'warm-mover', model: 'stand-in', folder: null, promptCacheLifetime: '1h' })
  await waitFor('warm-mover idle', async () => (await alphaPhone.agent('warm-mover')).state.state === 'idle', 30_000)
  assert.equal(alpha.promptCacheLifetimeOf('warm-mover'), '1h')
  await move('warm-mover')
  await waitFor('warm-mover at beta', () => agentAt(betaPhone, 'warm-mover'), 30_000)
  assert.equal(beta.promptCacheLifetimeOf('warm-mover'), '1h')
})

test('a move asked mid-turn waits for the turn to end', async () => {
  await readyAgent('busy')
  await send(alphaPhone, 'busy', standInScript({ do: 'barrier', name: 'busy-turn' }, { do: 'run', command: 'ouro reply "turn over"' }))
  await waitFor('busy in its turn', async () => alpha.barrierReached('busy-turn'))
  const { agent } = await move('busy')
  assert.equal(agent.state.state, 'in_turn', 'it keeps working')
  alpha.releaseBarrier('busy-turn')
  await waitFor('busy at beta', () => agentAt(betaPhone, 'busy'), 30_000)
  assert.ok(await messageIn(alphaPhone, 'busy', (message) => message.text === 'turn over'), 'its turn finished first')
})

test("a move that can't reach the other computer leaves the agent in place and tells it; a later one succeeds", async () => {
  await readyAgent('stayer')
  await send(alphaPhone, 'stayer', standInScript({ do: 'barrier', name: 'stayer-turn' }))
  await waitFor('stayer in its turn', async () => alpha.barrierReached('stayer-turn'))
  await move('stayer')
  await beta.killServer()
  alpha.releaseBarrier('stayer-turn')
  const notice = await waitFor('stayer told', () => noticeTo(alphaPhone, 'stayer', 'Your move to beta was called off'), 30_000)
  assert.match(notice.text, /You are still on alpha, as you were\.$/)
  assert.notEqual((await alphaPhone.agent('stayer')).state.state, 'moving')
  await assert.rejects(move('stayer'), (error: CommandFailed) => error.code === 'peer_unreachable')

  await beta.startServer()
  await waitFor('beta online', async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')?.status === 'online', 30_000)
  await waitFor('stayer idle again', async () => (await alphaPhone.agent('stayer')).state.state === 'idle', 30_000)
  await move('stayer')
  await waitFor('stayer at beta', () => agentAt(betaPhone, 'stayer'), 30_000)
})

test('only a computer that trusts this one fully, with the name free, takes an agent', async () => {
  await readyAgent('twin')
  await betaPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'twin', model: 'stand-in', folder: null })
  await assert.rejects(move('twin'), (error: CommandFailed) => error.code === 'forbidden' && /an agent named twin already lives on beta/.test(error.message))

  await betaPhone.command('set_computer_trust', { computerId: await alphaIdAtBeta(), trust: 'limited' })
  try {
    await readyAgent('guarded')
    await assert.rejects(move('guarded'), (error: CommandFailed) => error.code === 'forbidden')
    assert.equal((await alphaPhone.agent('guarded')).state.state, 'idle', 'nothing changed')
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: await alphaIdAtBeta(), trust: 'full' })
  }
})

test('a handoff sent again, its answer lost, is answered as before and taken once, with anything new it carries', async () => {
  const key = createPrivateKey(readFileSync(join(alpha.dataDir, 'identity', 'machine-key.pem')))
  const alphaKey = { privateKey: key, publicKeyPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }
  // As a computer from before cache lifetimes sends it: without one.
  const handoff = (waiting: PeerMove['waiting']): z.input<typeof PeerMove> => ({
    moveId: 'journey-handoff-sent-twice',
    agent: { name: 'echo', task: 'echo things', model: 'stand-in', parent: 'human', createdBy: 'human', createdAt: Date.now(), folder: { kind: 'in_default_folder', relativePath: '' }, ownershipEpoch: 1 },
    goal: null,
    goalNotes: '',
    conversation: null,
    waiting,
    memory: null,
  })
  const path = `${PEER_API_PREFIX}/move`
  const post = async (move: z.input<typeof PeerMove>) => {
    const body = JSON.stringify(move)
    const response = await fetch(`${beta.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(alphaKey, await alphaIdAtBeta(), 'POST', path, body, Date.now()) }, body })
    return await response.json() as unknown
  }
  const first = { messageId: 'journey-waiting-1', from: 'human', text: 'first', wake: 'fyi' as const, purpose: 'message' as const, sentAt: Date.now() }
  assert.deepEqual(await post(handoff([first])), { outcome: 'taken', address: 'echo@beta' })
  const second = { ...first, messageId: 'journey-waiting-2', text: 'second' }
  assert.deepEqual(await post(handoff([first, second])), { outcome: 'taken', address: 'echo@beta' })
  assert.equal((await betaPhone.snapshot()).agents.filter((agent) => agent.name === 'echo').length, 1)
  const texts = (await betaPhone.conversation('echo')).map((message) => message.text)
  assert.deepEqual(texts.filter((text) => text === 'first' || text === 'second'), ['first', 'second'])
  assert.equal(beta.promptCacheLifetimeOf('echo'), '5m', 'a handoff without a cache lifetime, as older computers send, has the 5 minute cache')
})
