// Faults in the network between two running computers (journeys/network-faults.ts), not a computer stopped: messages
// sent from both sides during a partition wait and then arrive in order, once each; an acknowledgement lost in transit
// makes the sender try again, and the message is still taken once; a replayed request is refused and changes nothing; a
// move whose answer is lost is unconfirmed, sent again and taken once; a move cut off before its handoff leaves the
// agent where it was, and a later one succeeds.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { MessageEntity } from '@ouro/contract'
import { PEER_API_PREFIX } from '@ouro/contract'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { NetworkLink } from './network-faults.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient
/** In front of each computer's peer address: what the other computer sends it goes through here. */
const toAlpha = new NetworkLink()
const toBeta = new NetworkLink()

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha', OURO_PEER_ADDRESS: await toAlpha.start() })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta', OURO_PEER_ADDRESS: await toBeta.start() })
  await Promise.all([alpha.startServer(), beta.startServer()])
  toAlpha.forwardTo(alpha.url)
  toBeta.forwardTo(beta.url)
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: toAlpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await toAlpha.stop()
  await toBeta.stop()
  await alpha.cleanup()
  await beta.cleanup()
})

const send = (phone: AppClient, to: string, text: string, wake: 'wake' | 'fyi' = 'fyi') => phone.command('send_message', { to, text, attachmentIds: [], wake, answersAskId: null })
/** The texts starting with `prefix` in the phone's direct chat with an agent; none before there is a chat. */
async function textsIn(phone: AppClient, agentName: string, prefix: string): Promise<string[]> {
  const snapshot = await phone.snapshot()
  const exists = snapshot.chats.some((chat) => chat.kind === 'direct' && chat.members.some((member) => member.address === agentName) && chat.members.some((member) => member.address === snapshot.viewer.address))
  if (!exists) return []
  return (await phone.conversation(agentName)).filter((message) => message.text.startsWith(prefix)).map((message) => message.text)
}
const sentTo = async (phone: AppClient, address: string, id: string): Promise<MessageEntity | undefined> => (await phone.conversation(address)).find((message) => message.id === id)
const accepted = async (phone: AppClient, address: string, id: string) => (await sentTo(phone, address, id))?.remoteDeliveries[0]?.state.state === 'accepted'

async function readyAgent(phone: AppClient, name: string): Promise<void> {
  await phone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => {
    const agent = await phone.agent(name)
    return agent.state.state === 'idle' && agent.queuedDeliveries === 0
  }, 30_000)
}

const betaIdAtAlpha = async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
const move = async (name: string) => alphaPhone.command('move_agent', { agentId: (await alphaPhone.agent(name)).id, computerId: await betaIdAtAlpha() })
const agentsNamed = async (phone: AppClient, name: string) => (await phone.snapshot()).agents.filter((agent) => agent.name === name && agent.state.state !== 'archived')

test('messages sent from both sides during a partition wait, then arrive in order, once each', async () => {
  await readyAgent(betaPhone, 'listener')
  await readyAgent(alphaPhone, 'echo')
  await toAlpha.cut()
  await toBeta.cut()
  const toListener: string[] = []
  for (const n of [1, 2, 3]) toListener.push((await send(alphaPhone, 'listener@beta', `cut a${n}`)).message.id)
  for (const n of [1, 2, 3]) await send(betaPhone, 'echo@alpha', `cut b${n}`)
  await waitFor('the first tried and still queued', async () => {
    const state = (await sentTo(alphaPhone, 'listener@beta', toListener[0]!))?.remoteDeliveries[0]?.state
    return state?.state === 'queued' && state.attempts > 0
  }, 30_000)
  assert.deepEqual(await textsIn(betaPhone, 'listener', 'cut '), [], 'nothing crossed the partition')

  await toAlpha.heal()
  await toBeta.heal()
  await waitFor('all three at beta', async () => (await textsIn(betaPhone, 'listener', 'cut ')).length === 3, 60_000)
  await waitFor('all three at alpha', async () => (await textsIn(alphaPhone, 'echo', 'cut ')).length === 3, 60_000)
  assert.deepEqual(await textsIn(betaPhone, 'listener', 'cut '), ['cut a1', 'cut a2', 'cut a3'])
  assert.deepEqual(await textsIn(alphaPhone, 'echo', 'cut '), ['cut b1', 'cut b2', 'cut b3'])
  for (const id of toListener) await waitFor('accepted at alpha', () => accepted(alphaPhone, 'listener@beta', id), 30_000)
})

test('an acknowledgement lost in transit: the sender tries again, and the message is taken once', async () => {
  toBeta.loseAnswers(`${PEER_API_PREFIX}/messages`)
  const { message } = await send(alphaPhone, 'listener@beta', 'ack lost')
  await waitFor('accepted at alpha after another try', () => accepted(alphaPhone, 'listener@beta', message.id), 60_000)
  const lost = toBeta.events.filter((event) => event.path === `${PEER_API_PREFIX}/messages` && event.outcome === 'answer_lost')
  assert.equal(lost.length, 1)
  assert.equal(lost[0]!.statuses[0], 200, 'beta had taken it')
  assert.deepEqual(await textsIn(betaPhone, 'listener', 'ack lost'), ['ack lost'], 'once')
})

test('a replayed request is refused, and changes nothing', async () => {
  toBeta.replay(`${PEER_API_PREFIX}/messages`)
  const { message } = await send(alphaPhone, 'listener@beta', 'replayed')
  await waitFor('accepted at alpha', () => accepted(alphaPhone, 'listener@beta', message.id), 30_000)
  const replayed = toBeta.events.find((event) => event.outcome === 'replayed')
  assert.deepEqual(replayed?.statuses, [200, 401], 'the copy is refused as a replay')
  assert.deepEqual(await textsIn(betaPhone, 'listener', 'replayed'), ['replayed'])
})

test('a move whose answer is lost is unconfirmed, sent again, and taken once', async () => {
  await readyAgent(alphaPhone, 'mover')
  toBeta.loseAnswers(`${PEER_API_PREFIX}/move`)
  await move('mover')
  await waitFor('mover at beta', async () => (await agentsNamed(betaPhone, 'mover')).length > 0, 60_000)
  await waitFor('moved at alpha', async () => (await alphaPhone.snapshot()).agents.some((agent) => agent.name === 'mover' && agent.state.state === 'moved'), 60_000)
  const handoffs = toBeta.events.filter((event) => event.path === `${PEER_API_PREFIX}/move`)
  assert.equal(handoffs[0]?.outcome, 'answer_lost')
  assert.ok(handoffs.length >= 2, 'sent again after the lost answer')
  assert.equal((await agentsNamed(betaPhone, 'mover')).length, 1, 'taken once')
  // Its old address forwards to beta.
  await send(alphaPhone, 'mover', 'to the old address')
  await waitFor('forwarded to beta', async () => (await textsIn(betaPhone, 'mover', 'to the old address')).length === 1, 30_000)
})

test('a move cut off before its handoff leaves the agent where it was and tells it; once healed, a later one succeeds', async () => {
  await readyAgent(alphaPhone, 'stayer')
  await send(alphaPhone, 'stayer', standInScript({ do: 'barrier', name: 'stayer-turn' }), 'wake')
  await waitFor('stayer in its turn', async () => alpha.barrierReached('stayer-turn'), 30_000)
  await move('stayer')
  await toBeta.cut()
  alpha.releaseBarrier('stayer-turn')
  await waitFor('stayer told', async () => {
    for (const chat of (await alphaPhone.snapshot()).chats) {
      if (!chat.members.some((member) => member.address === 'stayer')) continue
      if ((await alphaPhone.history(chat.id)).messages.some((message) => message.purpose === 'system_notice' && message.text.startsWith('Your move to beta was called off'))) return true
    }
    return false
  }, 30_000)
  assert.notEqual((await alphaPhone.agent('stayer')).state.state, 'moving')
  assert.deepEqual(await agentsNamed(betaPhone, 'stayer'), [], 'nothing arrived')
  await assert.rejects(move('stayer'), (error: CommandFailed) => error.code === 'peer_unreachable')

  await toBeta.heal()
  await waitFor('stayer idle again', async () => (await alphaPhone.agent('stayer')).state.state === 'idle', 30_000)
  await move('stayer')
  await waitFor('stayer at beta', async () => (await agentsNamed(betaPhone, 'stayer')).length === 1, 60_000)
})
