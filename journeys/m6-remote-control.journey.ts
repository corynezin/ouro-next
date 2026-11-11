// Acting on another of the person's computers, through two real servers: stop, interrupt, a new model and archive are done
// on an agent there at once and show here at once, and a new agent can be started there, by the person or by an agent;
// a computer that can't be reached refuses at once, safe to retry; and only a fully trusted computer may act at all, which
// the other computer checks. An agent's log there is read from here, by a fully trusted computer only. What such an
// agent says to the person, and its asks, reach the computer the person talks to it from, where the asks are answered.
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { LogPage, PEER_API_PREFIX } from '@ouro/contract'
import type { MessageEntity, PeerControl, PeerLogRequest, PeerCreateAgent, RemoteAgentEntity } from '@ouro/contract'
import type { z } from 'zod'
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

/** An idle agent on beta, and its copy at alpha with details. */
async function betaAgent(name: string): Promise<RemoteAgentEntity> {
  await betaPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => (await betaPhone.agent(name)).state.state === 'idle', 30_000)
  return await waitFor(`${name}@beta at alpha`, async () => {
    const copy = (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.address === `${name}@beta`)
    return copy?.details ? copy : null
  })
}

test("stop, a new model and archive are done on the agent's own computer at once, and show here at once", async () => {
  const copy = await betaAgent('target')
  assert.match(await alpha.cli('stop', 'target@beta'), /^target@beta: (running: stopping|stopped: deliberate)\n$/)
  await waitFor('target stopped at beta', async () => (await betaPhone.agent('target')).state.state === 'stopped')

  const { remoteAgent } = await alphaPhone.command('control_remote_agent', { remoteAgentId: copy.id, action: { kind: 'set_model', model: 'haiku' } })
  assert.equal(remoteAgent.details?.model, 'haiku')
  assert.equal((await betaPhone.agent('target')).model, 'haiku')

  await alpha.cli('archive', 'target@beta')
  assert.equal((await betaPhone.snapshot()).agents.find((agent) => agent.name === 'target')?.state.state, 'archived')
  await waitFor('the copy gone at alpha', async () => !(await alphaPhone.snapshot()).remoteAgents.some((agent) => agent.address === 'target@beta'))
})

test('a refusal there is the same refusal here', async () => {
  const copy = await betaAgent('refuser')
  await assert.rejects(
    alphaPhone.command('control_remote_agent', { remoteAgentId: copy.id, action: { kind: 'interrupt' } }),
    (error: CommandFailed) => error.code === 'agent_state_conflict' && error.message.endsWith(": beta: can't do that now: it is not in a turn"),
  )
})

test("a computer that can't be reached refuses at once, and the same command goes through once it is back", async () => {
  const copy = await betaAgent('patient')
  await beta.killServer()
  const startedAt = Date.now()
  const key = 'journey-retry-key-patient-stop'
  const stop = () => alphaPhone.command('control_remote_agent', { remoteAgentId: copy.id, action: { kind: 'stop' } }, key)
  await assert.rejects(stop(), (error: CommandFailed) => error.code === 'peer_unreachable')
  assert.ok(Date.now() - startedAt < 3_000, 'at once, not after waiting')
  await beta.startServer()
  await waitFor('beta online', async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')?.status === 'online', 30_000)
  const { remoteAgent } = await stop()
  assert.ok(['stopping', 'stopped'].includes(remoteAgent.details!.state.state), remoteAgent.details!.state.state)
  await waitFor('patient stopped at beta', async () => (await betaPhone.agent('patient')).state.state === 'stopped')
})

/** Sends a request to beta signed as alpha, past alpha's own checks. */
async function signedAsAlpha(alphaIdAtBeta: string, route: string, body: string): Promise<Response> {
  const key = createPrivateKey(readFileSync(join(alpha.dataDir, 'identity', 'machine-key.pem')))
  const alphaKey = { privateKey: key, publicKeyPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }
  const path = `${PEER_API_PREFIX}${route}`
  return await fetch(`${beta.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(alphaKey, alphaIdAtBeta, 'POST', path, body, Date.now()) }, body })
}

test("an agent's log is read from its computer, page by page, and only by a computer it trusts fully", async () => {
  const copy = await betaAgent('logged')
  const latest = await alphaPhone.remoteLog(copy.id)
  assert.equal(latest.status, 200)
  const page = LogPage.parse(latest.body)
  assert.ok(page.records.some((record) => record.kind === 'text' && record.text.includes('ready')), JSON.stringify(page.records))
  const since = LogPage.parse((await alphaPhone.remoteLog(copy.id, { after: page.endCursor })).body)
  assert.deepEqual(since.records, [], 'nothing new since')

  const alphaIdAtBeta = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'limited' })
  try {
    await waitFor('details withheld at alpha', async () => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.id === copy.id)?.details === null)
    assert.equal((await alphaPhone.remoteLog(copy.id)).status, 403)
    const direct = await signedAsAlpha(alphaIdAtBeta, '/log', JSON.stringify({ agentName: 'logged', after: null, before: null } satisfies PeerLogRequest))
    assert.equal(direct.status, 403, 'beta checks too')
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'full' })
    // Out of the way, so the tests after this one stay under beta's agent limit.
    await betaPhone.command('archive_agent', { agentId: (await betaPhone.agent('logged')).id })
  }
})

test("only a fully trusted computer may act, and the other computer checks", async () => {
  const copy = await betaAgent('guarded')
  const alphaIdAtBeta = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  const betaIdAtAlpha = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'limited' })
  try {
    await waitFor('details withheld at alpha', async () => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.id === copy.id)?.details === null)
    await assert.rejects(alphaPhone.command('control_remote_agent', { remoteAgentId: copy.id, action: { kind: 'stop' } }), (error: CommandFailed) => error.code === 'forbidden')
    await assert.rejects(
      alphaPhone.command('create_remote_agent', { computerId: betaIdAtAlpha, task: 'not here', name: 'uninvited', model: 'stand-in', folder: null }),
      (error: CommandFailed) => error.code === 'forbidden',
    )

    // Past alpha's own check: beta refuses a signed request from a computer it trusts only limitedly.
    const control = await signedAsAlpha(alphaIdAtBeta, '/control', JSON.stringify({ idempotencyKey: 'direct-control-1', agentName: 'guarded', action: { kind: 'stop' } } satisfies PeerControl))
    assert.equal(control.status, 403)
    assert.equal((await betaPhone.agent('guarded')).state.state, 'idle', 'nothing was done')
    const create = await signedAsAlpha(alphaIdAtBeta, '/create-agent', JSON.stringify({ idempotencyKey: 'direct-create-1', from: { kind: 'owner' }, task: 'not here', name: 'uninvited', model: 'stand-in', folder: null } satisfies z.input<typeof PeerCreateAgent>))
    assert.equal(create.status, 403)
    assert.ok(!(await betaPhone.snapshot()).agents.some((agent) => agent.name === 'uninvited'), 'nothing was made')
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'full' })
  }
})

test('the person starts an agent on another computer: it is theirs there, and shows here at once', async () => {
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  const { remoteAgent } = await alphaPhone.command('create_remote_agent', { computerId: betaId, task: standInScript({ do: 'text', text: 'made there' }), name: 'made-there', model: 'stand-in', folder: null })
  assert.equal(remoteAgent.address, 'made-there@beta')
  assert.ok((await alphaPhone.snapshot()).remoteAgents.some((agent) => agent.address === 'made-there@beta'), 'in the snapshot at once')
  const there = await betaPhone.agent('made-there')
  assert.equal(there.parent, 'human')
  assert.equal(there.createdBy, 'human')
  assert.equal(there.model, 'stand-in')
  const task = standInScript({ do: 'text', text: 'made there' })
  assert.ok((await betaPhone.conversation('made-there')).some((message) => message.text === task), "the task is in the person's chat with it there")
  await waitFor('it works its task there', async () => (await betaPhone.agent('made-there')).state.state === 'idle', 30_000)

  await assert.rejects(
    alphaPhone.command('create_remote_agent', { computerId: betaId, task: 'again', name: 'made-there', model: 'stand-in', folder: null }),
    (error: CommandFailed) => error.code === 'agent_name_taken' && error.message.endsWith(': beta: an agent named "made-there" already exists'),
  )
})

test('an agent started on another computer gets the prompt cache lifetime asked for', async () => {
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  await alphaPhone.command('create_remote_agent', { computerId: betaId, task: standInScript({ do: 'text', text: 'warm there' }), name: 'warm-there', model: 'stand-in', folder: null, promptCacheLifetime: '1h' })
  assert.equal(beta.promptCacheLifetimeOf('warm-there'), '1h')
  await alphaPhone.command('create_remote_agent', { computerId: betaId, task: standInScript({ do: 'text', text: 'default there' }), name: 'default-there', model: 'stand-in', folder: null })
  assert.equal(beta.promptCacheLifetimeOf('default-there'), '5m', 'left out, it is the 5 minute cache')
  // Out of the way, so the tests after this one stay under beta's agent limit.
  for (const name of ['warm-there', 'default-there']) await betaPhone.command('archive_agent', { agentId: (await betaPhone.agent(name)).id })
})

test('an unnamed agent started on another computer is named there by the model, cut to three words', async () => {
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  const { remoteAgent } = await alphaPhone.command('create_remote_agent', { computerId: betaId, task: 'Watch the herons from up there.\nstandin-name: Heron Watcher Up There', name: null, model: 'stand-in', folder: null })
  assert.equal(remoteAgent.address, 'heron-watcher-up@beta')
  await betaPhone.command('archive_agent', { agentId: (await betaPhone.agent('heron-watcher-up')).id })
})

test("an agent starts a helper on another computer, and the helper's parent is that agent there", async () => {
  await alphaPhone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro spawn helper@beta --model stand-in helping > spawn.txt 2>&1; ouro reply "$(cat spawn.txt)"' }), name: 'lead', model: 'stand-in', folder: null })
  await waitFor('helper at beta', async () => (await betaPhone.snapshot()).agents.find((agent) => agent.name === 'helper') ?? null, 30_000)
  const helper = await betaPhone.agent('helper')
  assert.equal(helper.parent, 'lead@alpha')
  assert.equal(helper.createdBy, 'human', 'its questions go to the person')
  await waitFor('the spawn printed at alpha', async () => (await alphaPhone.conversation('lead')).some((message) => message.text === 'started helper@beta'), 30_000)
})

test("starting an agent on a computer that can't be reached refuses at once, and the same command then makes one agent", async () => {
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  await beta.killServer()
  const key = 'journey-retry-key-create-later'
  const create = () => alphaPhone.command('create_remote_agent', { computerId: betaId, task: standInScript({ do: 'text', text: 'ready' }), name: 'later', model: 'stand-in', folder: null }, key)
  const startedAt = Date.now()
  await assert.rejects(create(), (error: CommandFailed) => error.code === 'peer_unreachable')
  assert.ok(Date.now() - startedAt < 3_000, 'at once, not after waiting')
  await beta.startServer()
  await waitFor('beta online', async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')?.status === 'online', 30_000)
  const first = await create()
  const again = await create()
  assert.equal(again.remoteAgent.id, first.remoteAgent.id)
  assert.equal((await betaPhone.snapshot()).agents.filter((agent) => agent.name === 'later').length, 1)
})

/** The phone's direct chat with `address`, or nothing before there is one. */
async function chatWith(phone: AppClient, address: string): Promise<MessageEntity[]> {
  const exists = (await phone.snapshot()).chats.some((chat) => chat.kind === 'direct' && chat.members.some((member) => member.address === address))
  return exists ? await phone.conversation(address) : []
}

test("what an agent says to the person shows on the computer the person talks to it from, as well as its own", async () => {
  await betaAgent('replier')
  await alphaPhone.command('send_message', { to: 'replier@beta', text: standInScript({ do: 'run', command: 'ouro reply "back to you"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const atAlpha = await waitFor('the reply at alpha', async () => (await chatWith(alphaPhone, 'replier@beta')).find((message) => message.text === 'back to you') ?? null, 30_000)
  assert.equal(atAlpha.from, 'replier@beta')
  const atBeta = (await betaPhone.conversation('replier')).find((message) => message.text === 'back to you')
  assert.equal(atBeta?.id, atAlpha.id, 'the same message on both')
  assert.deepEqual(atBeta?.remoteDeliveries, [], "the copy isn't a delivery to anyone")
  assert.equal((await alphaPhone.conversation('replier@beta')).filter((message) => message.text === 'back to you').length, 1)

  // Started from here: its report comes here too, though the person never wrote to it.
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  await alphaPhone.command('create_remote_agent', { computerId: betaId, task: standInScript({ do: 'run', command: 'ouro done "finished there"' }), name: 'reporter', model: 'stand-in', folder: null })
  const report = await waitFor('the report at alpha', async () => (await chatWith(alphaPhone, 'reporter@beta')).find((message) => message.text === 'finished there') ?? null, 30_000)
  assert.equal(report.purpose, 'done_report')

  // An agent the person talks to only on its own computer stays there.
  await betaAgent('homebody')
  await betaPhone.command('send_message', { to: 'homebody', text: standInScript({ do: 'run', command: 'ouro reply "only here"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the reply at beta', async () => (await betaPhone.conversation('homebody')).some((message) => message.text === 'only here'), 30_000)
  await alphaPhone.command('send_message', { to: 'replier@beta', text: 'after', attachmentIds: [], wake: 'fyi', answersAskId: null })
  await waitFor('a later message reached beta', async () => (await betaPhone.conversation('replier')).some((message) => message.text === 'after'), 30_000)
  assert.ok(!(await alphaPhone.snapshot()).chats.some((chat) => chat.members.some((member) => member.address === 'homebody@beta')))
})

test("an agent's ask reaches the computer the person talks to it from, is answered there, and closes on both", async () => {
  await betaAgent('asker')
  const ask = async (question: string) => await alphaPhone.command('send_message', { to: 'asker@beta', text: standInScript({ do: 'run', command: `ouro ask human --blocked --choice Yes --choice No "${question}"` }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await ask('Ship it?')
  const copy = await waitFor('the ask at alpha', async () => (await alphaPhone.snapshot()).remoteAsks.find((found) => found.text === 'Ship it?') ?? null, 30_000)
  const original = (await betaPhone.snapshot()).asks.find((found) => found.text === 'Ship it?')
  assert.equal(copy.id, original?.id, 'the same ask on both')
  assert.equal(copy.address, 'asker@beta')
  assert.equal(copy.level, 'blocked')
  assert.deepEqual(copy.choices, ['Yes', 'No'])
  const posing = (await chatWith(alphaPhone, 'asker@beta')).find((message) => message.text === 'Ship it?')
  assert.equal(posing?.posesAskId, copy.id)
  assert.equal(posing?.from, 'asker@beta')

  // Answered here: the copy goes at once, and the answer reaches the agent as the answer to it, which closes it there.
  await alphaPhone.command('send_message', { to: 'asker@beta', text: 'Yes', attachmentIds: [], wake: 'wake', answersAskId: copy.id })
  assert.ok(!(await alphaPhone.snapshot()).remoteAsks.some((found) => found.id === copy.id), 'gone here at once')
  const answer = await waitFor('the answer at beta', async () => (await betaPhone.conversation('asker')).find((message) => message.text === 'Yes') ?? null, 30_000)
  assert.equal(answer.answersAskId, copy.id)
  assert.ok(!(await betaPhone.snapshot()).asks.some((found) => found.id === copy.id), 'closed there')
  await assert.rejects(
    alphaPhone.command('send_message', { to: 'asker@beta', text: 'Yes again', attachmentIds: [], wake: 'wake', answersAskId: copy.id }),
    (error: CommandFailed) => error.code === 'ask_closed',
  )

  // Answered on its own computer: the copy here goes too.
  await waitFor('asker idle', async () => (await betaPhone.agent('asker')).state.state === 'idle', 30_000)
  await ask('Deploy now?')
  const second = await waitFor('the second ask at alpha', async () => (await alphaPhone.snapshot()).remoteAsks.find((found) => found.text === 'Deploy now?') ?? null, 30_000)
  await betaPhone.command('send_message', { to: 'asker', text: 'No', attachmentIds: [], wake: 'wake', answersAskId: second.id })
  await waitFor('the second copy gone at alpha', async () => !(await alphaPhone.snapshot()).remoteAsks.some((found) => found.id === second.id), 30_000)
})
