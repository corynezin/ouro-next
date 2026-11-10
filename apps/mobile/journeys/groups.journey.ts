// Group chats through the real server: created with an agent, posted to, left and joined again.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chatInfoModel } from '../src/features/chatInfo/model.ts'
import { groupSend, roomFooter } from '../src/features/room/model.ts'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('a group: created with an agent, posted to, left, and joined again', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const agent = await session.command('create_agent', { task: 'hello there', name: 'carol', model: null, folder: null })
    assert.ok(agent.ok, agent.ok ? '' : JSON.stringify(agent.failure))
    const created = await session.command('create_chat', { title: 'Launch plan', members: ['carol'] })
    assert.ok(created.ok, created.ok ? '' : JSON.stringify(created.failure))
    const chatId = created.value.chat.id
    const viewer = session.store.viewer!.address

    const chat = () => session.store.chats.get(chatId)!
    await waitFor('the group in the store', () => session.store.chats.has(chatId))
    assert.deepEqual(chatInfoModel(session.store, chat()).members.map((member) => member.address).sort(), ['carol', viewer].sort())
    assert.equal(roomFooter(session.store, chat()).kind, 'composer')

    const close = session.openChat(chatId)
    session.outbox.send(groupSend(chat(), 'hello room'))
    await waitFor('the post in the room', () => session.store.timeline(chatId)?.messages.some((message) => message.text === 'hello room') === true)

    const left = await session.command('remove_chat_member', { chatId, address: viewer })
    assert.ok(left.ok, left.ok ? '' : JSON.stringify(left.failure))
    await waitFor('only members can post', () => roomFooter(session.store, chat()).kind === 'members_only')

    const joined = await session.command('add_chat_member', { chatId, address: viewer })
    assert.ok(joined.ok, joined.ok ? '' : JSON.stringify(joined.failure))
    await waitFor('the composer back', () => roomFooter(session.store, chat()).kind === 'composer')
    close()
  } finally {
    phone.activeSession?.dispose()
  }
})
