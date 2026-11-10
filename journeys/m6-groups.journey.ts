// Groups across two of the person's computers, each a real server: a group lives on the computer that made it and keeps a
// copy on each computer with members in it. A post reaches every member as one message, waking only those it calls; a
// post on a copy goes home and from there to everyone; and members change at home, which the copies follow.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { ChatEntity, MessageEntity } from '@ouro/contract'
import { OWNER_ADDRESS } from '@ouro/contract'
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

async function readyAgent(phone: AppClient, name: string): Promise<void> {
  await phone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => {
    const agent = await phone.agent(name)
    return agent.state.state === 'idle' && agent.queuedDeliveries === 0
  }, 30_000)
}

const membersOf = (chat: ChatEntity) => chat.members.map((member) => member.address).sort()
const chatAt = async (phone: AppClient, chatId: string) => (await phone.snapshot()).chats.find((chat) => chat.id === chatId)
const postIn = async (phone: AppClient, chatId: string, matches: (message: MessageEntity) => boolean) => (await phone.history(chatId)).messages.find(matches)
const post = (phone: AppClient, chatId: string, text: string) => phone.command('post_to_chat', { chatId, text, attachmentIds: [] })

test('a group with a member on another computer has a copy there, with addresses as that computer writes them', async () => {
  await readyAgent(betaPhone, 'helper')
  await readyAgent(alphaPhone, 'planner')
  const { chat } = await alphaPhone.command('create_chat', { title: 'Across', members: ['helper@beta', 'planner'] })
  assert.equal(chat.homeMachine, 'alpha')
  assert.deepEqual(membersOf(chat), ['helper@beta', OWNER_ADDRESS, 'planner'])
  const copy = await waitFor('the copy at beta', () => chatAt(betaPhone, chat.id))
  assert.equal(copy.homeMachine, 'alpha')
  assert.equal(copy.title, 'Across')
  assert.deepEqual(membersOf(copy), ['helper', OWNER_ADDRESS, 'planner@alpha'])
  await assert.rejects(alphaPhone.command('create_chat', { title: 'nowhere', members: ['someone@gamma'] }), (error: CommandFailed) => error.code === 'not_found' && /no computer called gamma/.test(error.message))
})

test('a post reaches members on both computers as one message, waking only the one it calls', async () => {
  await readyAgent(betaPhone, 'quiet')
  const { chat } = await alphaPhone.command('create_chat', { title: 'Wake Across', members: ['quiet@beta', 'helper@beta'] })
  await waitFor('the copy at beta', () => chatAt(betaPhone, chat.id))

  const { message } = await post(alphaPhone, chat.id, `@helper@beta please answer\n${standInScript({ do: 'run', command: 'ouro reply "answer from beta"' })}`)
  const atBeta = await waitFor('the post at beta', () => postIn(betaPhone, chat.id, (found) => found.id === message.id))
  assert.equal(atBeta.from, OWNER_ADDRESS)
  assert.deepEqual(atBeta.deliveries.map((delivery) => [delivery.recipient, delivery.wake]).sort(), [['helper', 'wake'], ['quiet', 'fyi']])

  const reply = await waitFor('the answer back at alpha', () => postIn(alphaPhone, chat.id, (found) => found.text === 'answer from beta'), 30_000)
  assert.equal(reply.from, 'helper@beta')
  const replyAtBeta = await waitFor("the home gives the answer to the sender's neighbours too", async () => {
    const found = await postIn(betaPhone, chat.id, (candidate) => candidate.id === reply.id)
    return found && found.deliveries.length > 0 ? found : null
  })
  assert.equal(replyAtBeta.from, 'helper', 'one message, with one id, on both computers')
  assert.deepEqual(replyAtBeta.deliveries.map((delivery) => [delivery.recipient, delivery.wake]), [['quiet', 'fyi']])
  const quiet = await betaPhone.agent('quiet')
  assert.equal(quiet.state.state, 'idle', 'not called, not woken')
  assert.equal(quiet.queuedDeliveries, 2)
})

test("a post on a copy goes home, and from there to everyone", async () => {
  const { chat } = await alphaPhone.command('create_chat', { title: 'From Beta', members: ['helper@beta'] })
  await waitFor('the copy at beta', () => chatAt(betaPhone, chat.id))
  const { message, pendingAtHome } = await post(betaPhone, chat.id, 'written on beta')
  assert.equal(pendingAtHome, true)
  await waitFor('accepted by the home', async () => (await postIn(betaPhone, chat.id, (found) => found.id === message.id))?.remoteDeliveries[0]?.state.state === 'accepted')
  const atHome = (await postIn(alphaPhone, chat.id, (found) => found.id === message.id))!
  assert.equal(atHome.from, OWNER_ADDRESS, 'the owner is the same person on both computers')
  const back = await waitFor("beta's member gets it once the home sends it back", async () => {
    const found = await postIn(betaPhone, chat.id, (candidate) => candidate.id === message.id)
    return found && found.deliveries.length > 0 ? found : null
  })
  assert.deepEqual(back.deliveries.map((delivery) => delivery.recipient), ['helper'])
})

test('members change at home, and the copies follow; a copy refuses to change them', async () => {
  await readyAgent(alphaPhone, 'scribe')
  const { chat } = await alphaPhone.command('create_chat', { title: 'Changing', members: ['helper@beta'] })
  await waitFor('the copy at beta', () => chatAt(betaPhone, chat.id))
  await assert.rejects(betaPhone.command('add_chat_member', { chatId: chat.id, address: 'quiet' }), (error: CommandFailed) => error.code === 'forbidden' && /change its members there/.test(error.message))

  await alphaPhone.command('add_chat_member', { chatId: chat.id, address: 'scribe' })
  await waitFor('scribe in the copy', async () => (await chatAt(betaPhone, chat.id))?.members.some((member) => member.address === 'scribe@alpha'))
  await alphaPhone.command('remove_chat_member', { chatId: chat.id, address: 'helper@beta' })
  const copy = await waitFor('helper gone from the copy', async () => {
    const found = await chatAt(betaPhone, chat.id)
    return found && !found.members.some((member) => member.address === 'helper') ? found : null
  })
  assert.deepEqual(membersOf(copy), [OWNER_ADDRESS, 'scribe@alpha'])
})
