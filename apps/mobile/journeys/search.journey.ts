// Search through the real server: a message found in any case, its words marked, and its chat opened at it.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chatItems, directSend, jumpStep } from '../src/features/chat/model.ts'
import { chatSearchModel } from '../src/features/chats/search.ts'
import { directChatOf } from '../src/features/shared/agentFacts.ts'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('search finds a message in any case, lists it under your chats with the word marked, and its chat opens at it', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const created = await session.command('create_agent', { task: 'hello there', name: 'erin', model: null, folder: null })
    assert.ok(created.ok, created.ok ? '' : JSON.stringify(created.failure))
    const agentId = created.value.agent.id
    await waitFor('erin idle', () => session.store.agents.get(agentId)?.state.state === 'idle', 20_000)
    session.outbox.send(directSend(session.store.agents.get(agentId)!, 'Meet at the École at noon', [], null))
    await waitFor('the reply', () => session.store.agents.get(agentId)?.state.state === 'idle' && session.outbox.entriesIn(agentId).length === 0, 20_000)

    const searched = await session.api.search('école NOON', 50)
    assert.ok(searched.ok, searched.ok ? '' : JSON.stringify(searched.failure))
    const model = chatSearchModel(session.store, 'école NOON', { kind: 'found', page: searched.value }, Date.now())
    const mine = model.sections.find((section) => section.key === 'hits_mine')
    const row = mine?.rows.find((candidate) => candidate.kind === 'hit' && candidate.hit.senderText === 'You')
    assert.ok(row?.kind === 'hit', JSON.stringify(model.sections))
    assert.deepEqual(row.hit.excerpt.filter((part) => part.marked).map((part) => part.text), ['École', 'noon'])

    const chat = directChatOf(session.store, session.store.agents.get(agentId)!)!
    assert.equal(row.hit.chatId, chat.id)
    const close = session.openChat(chat.id)
    await waitFor('the chat loaded', () => session.store.timeline(chat.id) !== undefined)
    const timeline = session.store.timeline(chat.id)!
    const items = chatItems({ messages: timeline.messages, outbox: [], viewerAddress: session.store.viewer?.address, recipientLastOutputAt: null })
    const step = jumpStep(items, { messageId: row.hit.messageId, seq: row.hit.seq }, timeline.hasOlder, 0)
    assert.equal(step.kind === 'scroll' && step.messageId, row.hit.messageId)
    close()
  } finally {
    phone.activeSession?.dispose()
  }
})
