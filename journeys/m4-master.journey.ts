// The master agent: made when the owner first pairs, started by their first message with its own protocol, never
// finishing, and the only one that can carry the person's own words to another agent.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { MASTER_AGENT_NAME, OWNER_ADDRESS } from '@ouro/contract'
import { Store } from '../server/src/store/store.ts'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)

async function masterSays(prefix: string): Promise<string> {
  const reply = await waitFor(`master's "${prefix}"`, async () => (await phone.conversation(MASTER_AGENT_NAME)).find((message) => message.from === MASTER_AGENT_NAME && message.text.startsWith(prefix)))
  return reply.text
}

test('the owner\'s first pairing makes a master, waiting and costing nothing; another pairing makes no second one', async () => {
  const masters = (await phone.snapshot()).agents.filter((agent) => agent.name === MASTER_AGENT_NAME)
  assert.equal(masters.length, 1)
  assert.deepEqual(masters[0]!.state.state === 'stopped' && masters[0]!.state.stopped, { reason: 'idle' })
  assert.equal(masters[0]!.createdBy, OWNER_ADDRESS)
  await run.pairDevice()
  assert.equal((await phone.snapshot()).agents.filter((agent) => agent.name === MASTER_AGENT_NAME).length, 1)
  await assert.rejects(phone.command('create_agent', { task: 'impostor', name: MASTER_AGENT_NAME, model: null, folder: null }), (error: CommandFailed) => error.code === 'agent_name_reserved')
})

test('a first message starts it with the master protocol, and it never finishes', async () => {
  await send(MASTER_AGENT_NAME, standInScript({ do: 'run', command: 'ouro done "all done" > done.txt 2>&1; ouro reply "done says: $(tr "\\n" " " < done.txt)"' }))
  assert.match(await masterSays('done says:'), /never finishes/)
  const master = await phone.agent(MASTER_AGENT_NAME)
  assert.notEqual(master.state.state, 'done')
  const config = JSON.parse(readFileSync(join(run.dataDir, 'agents', master.id, `runner-${generationOf(master)}.json`), 'utf8')) as { systemPrompt: string }
  assert.match(config.systemPrompt, /the master agent: the person's front door/)
  assert.match(config.systemPrompt, /ouro relay <agent>/)
  assert.ok(!config.systemPrompt.includes('{{'), 'every placeholder is filled')
})

test("the master carries the person's own words to an agent as theirs, answering its question; nobody else can", async () => {
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro ask human "Black or dark grey?"' }), name: 'painter', model: null, folder: null })
  const ask = await waitFor("painter's question", async () => (await phone.snapshot()).asks.find((candidate) => candidate.agentName === 'painter'))

  await send(MASTER_AGENT_NAME, standInScript({ do: 'run', command: `ouro relay painter --ask ${ask.id} "Black, like the old ones" > relay.txt 2>&1; ouro reply "relay says: $(tr "\\n" " " < relay.txt)"` }))
  assert.match(await masterSays('relay says:'), /as human's own words/)

  const relayed = await waitFor('the relayed words in painter\'s chat', async () => (await phone.conversation('painter')).find((message) => message.text === 'Black, like the old ones'))
  assert.equal(relayed.from, OWNER_ADDRESS, "they are the person's words")
  assert.equal(relayed.relayedBy, MASTER_AGENT_NAME, 'and say who carried them')
  assert.equal(relayed.answersAskId, ask.id)
  assert.equal((await phone.snapshot()).asks.some((candidate) => candidate.id === ask.id), false, 'the question is closed')
  await waitFor("painter's reply", async () => (await phone.conversation('painter')).some((message) => message.text === 'stand-in received: Black, like the old ones'))

  // Any other agent is refused.
  await send('painter', standInScript({ do: 'run', command: 'ouro relay master "pretending" > relay.txt 2>&1; ouro reply "painter relay says: $(tr "\\n" " " < relay.txt)"' }))
  const refused = await waitFor('the refusal', async () => (await phone.conversation('painter')).find((message) => message.text.startsWith('painter relay says:')))
  assert.match(refused.text, /only the master agent relays/)
})

test('an owner who paired before masters existed gets one when the server starts', async () => {
  const earlier = new JourneyRun()
  try {
    await earlier.startServer()
    await earlier.killServer('SIGKILL')
    // A pairing as an older release recorded it: a device, and no master.
    const store = new Store(join(earlier.dataDir, 'ouro.db'))
    store.transaction(() => store.insertDevice({ id: 'old-phone', name: 'old phone', personId: store.ownerPerson()!.id, pairedAt: 1, lastSeenAt: null, revokedAt: null }, 'not-a-real-token-hash'))
    assert.equal(store.activeAgentByName(MASTER_AGENT_NAME), null)
    store.close()

    // Before any new pairing, which would make one by itself.
    await earlier.startServer()
    assert.match(await earlier.cli('list'), /^master {2}stopped/m)
  } finally {
    await earlier.cleanup()
  }
})
