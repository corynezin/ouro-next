// Automatic compaction, through the real server and runners: an idle agent with a large context on a warm 1 hour cache
// stays up past its idle exit, is compacted just before the cache expires, once, then exits, and is told where its full
// history is. One on a 5 minute cache just exits.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const MINUTE = 60_000
const IDLE_EXIT_MS = 30 * MINUTE
/** After its turn: within 5 minutes of its 1 hour cache expiring, when an idle agent is compacted. */
const COMPACTION_DUE_AFTER = 56 * MINUTE
const LARGE = standInScript({ do: 'context', tokens: 120_000 }, { do: 'text', text: 'read the whole codebase' })

async function startedWith(name: string, promptCacheLifetime: '5m' | '1h'): Promise<AgentEntity> {
  await phone.command('create_agent', { task: LARGE, name, model: null, folder: null, promptCacheLifetime })
  return await waitFor(`${name} to go idle with its context known`, async () => {
    const agent = await phone.agent(name)
    return agent.state.state === 'idle' && agent.cache !== null ? agent : null
  })
}

const stateOf = async (name: string) => (await phone.agent(name)).state

test('a large context on a warm 1 hour cache stays up past idle exit, is compacted just before expiry, once; then the agent exits', async () => {
  const started = await startedWith('scribe', '1h')
  assert.equal(started.cache?.tokens, 120_000)
  assert.equal(started.cache?.compacted, false)
  assert.ok(started.cache.expiresAt - Date.now() > 55 * MINUTE, 'a 1 hour cache')

  // At its idle exit the whole context is still cached: a message now would find it warm, so it stays up as it is.
  run.advanceClock(IDLE_EXIT_MS)
  await new Promise((done) => setTimeout(done, 1_500)) // many server ticks at the new time
  const atIdleExit = await phone.agent('scribe')
  assert.equal(atIdleExit.state.state, 'idle')
  assert.equal(atIdleExit.cache?.compacted, false)

  // Shortly before the cache expires it is compacted, and then has nothing left to wait for: it exits.
  run.advanceClock(COMPACTION_DUE_AFTER - IDLE_EXIT_MS)
  const stopped = await waitFor('scribe to compact and exit idle', async () => {
    const state = await stateOf('scribe')
    return state.state === 'stopped' ? state : null
  })
  assert.deepEqual(stopped.state === 'stopped' && stopped.stopped, { reason: 'idle' })
  const compacted = await phone.agent('scribe')
  assert.deepEqual(compacted.cache && { tokens: compacted.cache.tokens, compacted: compacted.cache.compacted }, { tokens: 5_000, compacted: true })

  // Its compacted context says where the full history is.
  await phone.command('send_message', { to: 'scribe', text: standInScript({ do: 'run', command: 'ouro reply "$(printf %s "$OURO_STANDIN_HISTORY" | grep compacted)"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const chatId = await phone.directChatWith('scribe')
  const note = await waitFor('scribe to show its compaction note', async () => (await phone.history(chatId)).messages.find((message) => message.from === 'scribe' && message.text.startsWith('compacted:'))?.text ?? null)
  assert.match(note, /Earlier details \(exact messages, tool output\) are in my full history: ouro log scribe, or ouro search <words>\./)
})

test('on a 5 minute cache, cold long before idle exit, the agent exits without compacting', async () => {
  await startedWith('jotter', '5m')
  run.advanceClock(IDLE_EXIT_MS)
  const stopped = await waitFor('jotter to exit idle', async () => {
    const state = await stateOf('jotter')
    return state.state === 'stopped' ? state : null
  })
  assert.deepEqual(stopped.state === 'stopped' && stopped.stopped, { reason: 'idle' })
  assert.equal((await phone.agent('jotter')).cache?.compacted, false)
})
