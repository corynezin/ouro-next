// Direct messages between two of the person's computers, each a real server: the owner's words reach an agent on the
// other computer as the owner's, agents reach each other as name@machine both ways, messages wait while the other side
// is down and then arrive in order, once each, and a refusal comes back as undeliverable with its reason.
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PEER_API_PREFIX } from '@ouro/contract'
import type { MessageEntity, PeerMessage } from '@ouro/contract'
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
  await betaPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'helper', model: 'stand-in', folder: null })
  await waitFor('helper idle', async () => (await betaPhone.agent('helper')).state.state === 'idle', 30_000)
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const send = (phone: AppClient, to: string, text: string, wake: 'wake' | 'fyi' = 'wake') => phone.command('send_message', { to, text, attachmentIds: [], wake, answersAskId: null })
const messageIn = async (phone: AppClient, agentName: string, text: string): Promise<MessageEntity | undefined> => (await phone.conversation(agentName)).find((message) => message.text === text)
/** A message in any chat on that server, with the chat's members. */
const findMessage = async (phone: AppClient, matches: (message: MessageEntity) => boolean): Promise<{ message: MessageEntity; members: string[] } | undefined> => {
  for (const chat of (await phone.snapshot()).chats) {
    const message = (await phone.history(chat.id)).messages.find(matches)
    if (message) return { message, members: chat.members.map((member) => member.address).sort() }
  }
  return undefined
}
const remoteStateOf = async (phone: AppClient, id: string) => (await findMessage(phone, (message) => message.id === id))?.message.remoteDeliveries[0]?.state

test("the owner's message reaches an agent on the other computer as the owner's, and its answer comes back to the owner", async () => {
  const { message } = await send(alphaPhone, 'helper@beta', standInScript({ do: 'run', command: 'ouro reply "pong from beta"' }))
  assert.deepEqual(message.remoteDeliveries.map((delivery) => delivery.recipient), ['helper@beta'])
  await waitFor('accepted by beta', async () => (await remoteStateOf(alphaPhone, message.id))?.state === 'accepted')
  const arrived = await waitFor('the message at beta', () => messageIn(betaPhone, 'helper', message.text))
  assert.equal(arrived.id, message.id, 'one identity on both machines')
  assert.equal(arrived.from, 'human', 'the owner is the same person on each of their computers')
  await waitFor("helper's answer to the owner", async () => (await messageIn(betaPhone, 'helper', 'pong from beta'))?.from === 'helper', 30_000)
})

test('agents reach each other across computers as name@machine, both ways', async () => {
  await alphaPhone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro send helper@beta --fyi "hello from asker"' }), name: 'asker', model: 'stand-in', folder: null })
  const atBeta = await waitFor("asker's message at beta", () => findMessage(betaPhone, (message) => message.text === 'hello from asker'), 30_000)
  assert.equal(atBeta.message.from, 'asker@alpha')
  assert.equal(atBeta.message.deliveries[0]?.wake, 'fyi')
  assert.deepEqual(atBeta.members, ['asker@alpha', 'helper'], 'in their own direct chat')

  await send(betaPhone, 'helper', standInScript({ do: 'run', command: 'ouro send asker@alpha --fyi "hello back"' }))
  const atAlpha = await waitFor("helper's message at alpha", () => findMessage(alphaPhone, (message) => message.text === 'hello back'), 30_000)
  assert.equal(atAlpha.message.from, 'helper@beta')
  assert.deepEqual(atAlpha.members, ['asker', 'helper@beta'])
})

test('while the other computer is down, messages wait; then they arrive in order, once each', async () => {
  await beta.killServer()
  const sent: string[] = []
  for (const n of [1, 2, 3]) sent.push((await send(alphaPhone, 'helper@beta', `queued ${n}`, 'fyi')).message.id)
  await waitFor('a retry counted', async () => {
    const state = await remoteStateOf(alphaPhone, sent[0]!)
    return state?.state === 'queued' && state.attempts >= 1
  })
  assert.equal((await remoteStateOf(alphaPhone, sent[2]!))?.state, 'queued')
  await beta.startServer()
  await waitFor('all three accepted', async () => (await Promise.all(sent.map((id) => remoteStateOf(alphaPhone, id)))).every((state) => state?.state === 'accepted'), 60_000)
  const arrived = (await betaPhone.conversation('helper')).filter((message) => message.text.startsWith('queued '))
  assert.deepEqual(arrived.map((message) => message.text), ['queued 1', 'queued 2', 'queued 3'])
  assert.deepEqual(arrived.map((message) => message.id), sent)
})

test('the same message sent again is taken once', async () => {
  const alphaId = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  const key = createPrivateKey(readFileSync(join(alpha.dataDir, 'identity', 'machine-key.pem')))
  const alphaKey = { privateKey: key, publicKeyPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }
  const message: PeerMessage = { messageId: 'msg-sent-twice', from: { kind: 'owner' }, to: 'helper', text: 'only once', wake: 'fyi', purpose: 'message', sentAt: Date.now(), answersAskId: null }
  const body = JSON.stringify(message)
  const path = `${PEER_API_PREFIX}/messages`
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${beta.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureHeaders(alphaKey, alphaId, 'POST', path, body, Date.now()) }, body })
    assert.deepEqual(await response.json(), { outcome: 'accepted' })
  }
  assert.equal((await betaPhone.conversation('helper')).filter((found) => found.text === 'only once').length, 1)
})

test('a message for nobody there comes back undeliverable with the reason; an unknown computer is refused at once', async () => {
  const { message } = await send(alphaPhone, 'nobody@beta', 'anyone?')
  const state = await waitFor('the refusal', async () => {
    const found = await remoteStateOf(alphaPhone, message.id)
    return found?.state === 'undeliverable' ? found : null
  })
  assert.equal(state.reason, 'no agent named nobody on beta')
  await assert.rejects(send(alphaPhone, 'helper@gamma', 'hello?'), (error: CommandFailed) => error.code === 'not_found' && /no computer called gamma/.test(error.message))
})

test('removing the computer makes what still waits for it undeliverable', async () => {
  await beta.killServer()
  const { message } = await send(alphaPhone, 'helper@beta', 'never arrives', 'fyi')
  const betaId = (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
  await alphaPhone.command('remove_computer', { computerId: betaId })
  const state = await waitFor('given up', async () => {
    const found = await remoteStateOf(alphaPhone, message.id)
    return found?.state === 'undeliverable' ? found : null
  })
  assert.equal(state.reason, 'beta was removed from this computer')
})
