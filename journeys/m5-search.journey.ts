// Message search through the real server: every word anywhere in any case, across direct chats and groups, newest
// first, with an excerpt, and a limit that says when there is more.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
  await phone.command('create_agent', { task: 'ready', name: 'finder', model: null, folder: join(run.dir, 'finder') })
  await waitFor('finder to go idle', async () => (await phone.agent('finder')).state.state === 'idle')
})
after(() => run.cleanup())

const send = (text: string) => phone.command('send_message', { to: 'finder', text, attachmentIds: [], wake: 'fyi', answersAskId: null })

test('every word, anywhere, in any case, across direct chats and groups, newest first', async () => {
  const older = (await send('The Deploy to staging went fine')).message
  const newer = (await send('deploy again? staging looks stale')).message
  await send('nothing to see here')
  const { chat } = await phone.command('create_chat', { title: 'search room', members: ['finder'] })
  const { message: inGroup } = await phone.command('post_to_chat', { chatId: chat.id, text: 'Staging DEPLOY from the room', attachmentIds: [] })
  await send('Une école à Zürich')

  const page = await phone.search('staging deploy')
  assert.deepEqual(page.hits.map((hit) => hit.messageId), [inGroup.id, newer.id, older.id])
  assert.equal(page.more, false)
  assert.equal(page.hits[0]!.chatId, chat.id)
  assert.equal(page.hits[2]!.match, 'Deploy', 'the first matched word in the text, as written')
  assert.equal(page.hits[0]!.match, 'Staging')
  assert.equal(page.hits[0]!.from, 'human')

  assert.deepEqual((await phone.search('ÉCOLE zürich')).hits.map((hit) => hit.excerpt), ['Une école à Zürich'], 'beyond ASCII too')
  assert.deepEqual(await phone.search('   '), { hits: [], more: false })
  assert.deepEqual((await phone.search('staging production')).hits, [])
})

test('a limit cuts newest first and says there is more; the excerpt is one line', async () => {
  for (let index = 0; index < 4; index++) await send(`limit-word number ${index}\nsecond line`)
  const page = await phone.search('LIMIT-WORD', 3)
  assert.equal(page.hits.length, 3)
  assert.equal(page.more, true)
  assert.deepEqual(page.hits.map((hit) => hit.excerpt), ['limit-word number 3 second line', 'limit-word number 2 second line', 'limit-word number 1 second line'])
})

test("an archived agent's direct messages aren't found, and are again once it is back", async () => {
  await phone.command('create_agent', { task: 'ready', name: 'shelved', model: null, folder: join(run.dir, 'shelved') })
  await waitFor('shelved to go idle', async () => (await phone.agent('shelved')).state.state === 'idle')
  const shelved = await phone.agent('shelved')
  await phone.command('send_message', { to: 'shelved', text: 'shelf-word in a direct chat', attachmentIds: [], wake: 'fyi', answersAskId: null })
  const { chat } = await phone.command('create_chat', { title: 'shelf room', members: ['shelved'] })
  await phone.command('post_to_chat', { chatId: chat.id, text: 'shelf-word in a group', attachmentIds: [] })
  assert.equal((await phone.search('shelf-word')).hits.length, 2)

  await phone.command('archive_agent', { agentId: shelved.id })
  await waitFor('archived', async () => (await phone.snapshot()).agents.find((agent) => agent.id === shelved.id)?.state.state === 'archived')
  assert.deepEqual((await phone.search('shelf-word')).hits.map((hit) => hit.chatId), [chat.id], 'groups keep what was said')

  await phone.command('unarchive_agent', { agentId: shelved.id })
  await waitFor('back', async () => (await phone.snapshot()).agents.find((agent) => agent.id === shelved.id)?.state.state !== 'archived')
  assert.equal((await phone.search('shelf-word')).hits.length, 2)
})
