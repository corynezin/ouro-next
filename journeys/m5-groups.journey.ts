// Group chats through the real server, runners and command line: making groups, membership, who a post wakes, replies in
// the group, and what agents read.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ChatEntity } from '@ouro/contract'
import { chatHandle, OWNER_ADDRESS } from '@ouro/contract'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const settle = () => new Promise((done) => setTimeout(done, 700))

async function readyAgent(name: string): Promise<string> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  await waitFor(`${name} to go idle`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 })
  return (await phone.agent(name)).folder
}

async function groupMessages(chat: ChatEntity) {
  return (await phone.history(chat.id)).messages
}

const post = (chat: ChatEntity, text: string) => phone.command('post_to_chat', { chatId: chat.id, text, attachmentIds: [] })
/** Idle, holding this many unread FYIs: it hasn't been woken. */
async function holdsFyis(name: string, count: number): Promise<void> {
  const agent = await phone.agent(name)
  assert.equal(agent.state.state, 'idle', `${name} is not woken`)
  assert.equal(agent.queuedDeliveries, count, `${name} holds ${count} FYI(s)`)
}

test('a person makes a group of agents; names are unique by handle; members must exist', async () => {
  await readyAgent('ant')
  await readyAgent('bee')
  const { chat } = await phone.command('create_chat', { title: 'Hive Work', members: ['ant', 'bee'] })
  assert.equal(chat.kind, 'group')
  assert.equal(chatHandle(chat), '#hive-work')
  assert.deepEqual(chat.members.map((member) => member.address).sort(), ['ant', 'bee', OWNER_ADDRESS])
  assert.equal(chat.createdBy, OWNER_ADDRESS)
  assert.ok((await phone.snapshot()).readStates.some((state) => state.chatId === chat.id), 'the person has a read state in it')
  await assert.rejects(phone.command('create_chat', { title: 'hive  work', members: [] }), (error: CommandFailed) => error.code === 'chat_name_taken')
  await assert.rejects(phone.command('create_chat', { title: 'other', members: ['nobody-here'] }), (error: CommandFailed) => error.code === 'not_found')
})

test('only an @mention wakes an agent; other posts reach it as FYIs with its next real message, and it replies in the group', async () => {
  await readyAgent('ant2')
  await readyAgent('bee2')
  const { chat } = await phone.command('create_chat', { title: 'wake test', members: ['ant2', 'bee2'] })
  await post(chat, 'just so you know: the build is green')
  await settle()
  await holdsFyis('ant2', 1)
  await holdsFyis('bee2', 1)

  await post(chat, `@ant2 what next?\n${standInScript({ do: 'run', command: 'ouro reply "ant2 here"' })}`)
  // The stand-in also answers the held FYI on its own; a model would read both together.
  const reply = await waitFor("ant2's reply in the group", async () => (await groupMessages(chat)).find((message) => message.from === 'ant2' && message.text === 'ant2 here'))
  assert.equal(reply.chatId, chat.id, 'the reply is in the group, not a direct chat')
  // The FYI was held until the mention woke ant2, then went to it too.
  const [fyi, mention] = await waitFor('both delivered to ant2', async () => {
    const messages = await groupMessages(chat)
    const toAnt = (index: number) => messages[index]!.deliveries.find((delivery) => delivery.recipient === 'ant2')!
    return toAnt(0).state.state === 'completed' && toAnt(1).state.state === 'completed' && [toAnt(0), toAnt(1)] as const
  })
  assert.equal(fyi.wake, 'fyi')
  assert.equal(mention.wake, 'wake')
  assert.ok(fyi.state.state === 'completed' && fyi.state.at >= (await groupMessages(chat))[1]!.at, 'not before the mention')

  // bee2 holds every post so far as an FYI, and still hasn't been woken.
  await settle()
  await holdsFyis('bee2', (await groupMessages(chat)).length)
  assert.ok(!(await phone.conversation('ant2')).some((message) => message.text === 'ant2 here'), "nothing in ant2's direct chat")
})

test('an agent works a group from the command line: create, post with a mention, read, join, add and remove', async () => {
  const folder = await readyAgent('cli-ant')
  await readyAgent('cli-bee')
  const commands = [
    "ouro chats new Builders cli-bee > out.txt 2>&1",
    "ouro send '#builders' '@cli-bee ping from the cli' >> out.txt 2>&1",
    'ouro chats >> out.txt 2>&1',
    "ouro chats read '#builders' -n 5 >> out.txt 2>&1",
    "ouro chats remove '#builders' cli-ant >> out.txt 2>&1",
    "ouro send '#builders' 'after leaving' >> out.txt 2>&1",
    "ouro chats join '#builders' >> out.txt 2>&1",
    "ouro send '#builders' --fyi 'x' >> out.txt 2>&1",
    'ouro reply "cli done"',
  ]
  await phone.command('send_message', { to: 'cli-ant', text: standInScript({ do: 'run', command: commands.join('; ') }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('cli-ant to finish', async () => (await phone.conversation('cli-ant')).some((message) => message.text === 'cli done'))
    .catch((error: Error) => { throw new Error(`${error.message}\nout.txt:\n${readFileSync(join(folder, 'out.txt'), 'utf8')}\n${JSON.stringify(run.log().slice(-3000))}`) })
  const out = readFileSync(join(folder, 'out.txt'), 'utf8')
  assert.match(out, /\* #builders {2}cli-ant, cli-bee/, 'made, with its maker in it')
  assert.match(out, /posted in #builders/)
  assert.match(out, /\[cli-ant\] @cli-bee ping from the cli/)
  assert.match(out, /only members post in #builders: join it first \(not_a_member\)/)
  assert.match(out, /a group post calls only the members it @mentions/)

  const chat = (await phone.snapshot()).chats.find((candidate) => candidate.title === 'Builders')!
  assert.deepEqual(chat.members.map((member) => member.address).sort(), ['cli-ant', 'cli-bee'], 'left and joined again')
  // The mention woke cli-bee, whose reply went to the group.
  await waitFor("cli-bee's answer in the group", async () => (await groupMessages(chat)).some((message) => message.from === 'cli-bee' && message.text === 'stand-in received: @cli-bee ping from the cli'))
})

test('a person who isn\'t a member can read a group but not post until they join; direct chats have fixed members', async () => {
  await readyAgent('solo')
  await phone.command('send_message', { to: 'solo', text: standInScript({ do: 'run', command: 'ouro chats new solo-room solo > /dev/null; ouro send "#solo-room" "solo says hi"; ouro reply ok' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const chat = await waitFor('the room', async () => (await phone.snapshot()).chats.find((candidate) => candidate.title === 'solo-room'))
  await waitFor('its post', async () => (await groupMessages(chat)).some((message) => message.text === 'solo says hi'))
  await assert.rejects(post(chat, 'hello?'), (error: CommandFailed) => error.code === 'not_a_member')
  await phone.command('add_chat_member', { chatId: chat.id, address: OWNER_ADDRESS })
  await post(chat, '@solo hello')
  await waitFor("solo's answer", async () => (await groupMessages(chat)).some((message) => message.from === 'solo' && message.text === 'stand-in received: @solo hello'))

  const directChatId = await phone.directChatWith('solo')
  await assert.rejects(phone.command('add_chat_member', { chatId: directChatId, address: 'ant' }), (error: CommandFailed) => error.code === 'invalid_request')
  await assert.rejects(phone.command('post_to_chat', { chatId: directChatId, text: 'x', attachmentIds: [] }), (error: CommandFailed) => error.code === 'invalid_request')
})
