// The starter agent: made, pinned and greeting the person when the owner first pairs, with its front-door instructions
// as standing instructions, which keep it from finishing. Otherwise it is an ordinary agent: unpinned and archived like
// any other. An agent a person started carries their words; its helpers don't. Pins: the person's own, kept on the server,
// in the order they were pinned.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { OWNER_ADDRESS } from '@ouro/contract'
import { Store } from '../server/src/store/store.ts'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const STARTER = 'concierge'
const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)

async function says(agent: string, prefix: string): Promise<string> {
  const reply = await waitFor(`${agent}'s "${prefix}"`, async () => (await phone.conversation(agent)).find((message) => message.from === agent && message.text.startsWith(prefix)))
  return reply.text
}

test("the owner's first pairing makes the starter agent, pinned, greeting them and costing nothing; another pairing makes no second one", async () => {
  const snapshot = await phone.snapshot()
  const starters = snapshot.agents.filter((agent) => agent.name === STARTER)
  assert.equal(starters.length, 1)
  assert.deepEqual(starters[0]!.state.state === 'stopped' && starters[0]!.state.stopped, { reason: 'idle' })
  assert.equal(starters[0]!.createdBy, OWNER_ADDRESS)
  assert.deepEqual(snapshot.pins.map((pin) => pin.target), [{ kind: 'agent', agentId: starters[0]!.id }])
  const welcome = (await phone.conversation(STARTER))
  assert.equal(welcome.length, 1)
  assert.match(welcome[0]!.text, /front door/)
  await run.pairDevice()
  assert.equal((await phone.snapshot()).agents.filter((agent) => agent.name === STARTER).length, 1)
  assert.equal((await phone.snapshot()).pins.length, 1)
})

test('a first message starts it with the default rules and its standing instructions, which keep it from finishing', async () => {
  await send(STARTER, standInScript({ do: 'run', command: 'ouro done "bye" > done.txt 2>&1; ouro reply "hello there, done says: $(tr "\\n" " " < done.txt)"' }))
  assert.match(await says(STARTER, 'hello there'), /standing role and never finish/)
  await assert.rejects(phone.command('create_agent', { task: 'x', name: 'master', model: null, folder: null }), /reserved/, "the old front door's name stays reserved")
  const starter = await phone.agent(STARTER)
  const config = JSON.parse(readFileSync(join(run.dataDir, 'agents', starter.id, `runner-${generationOf(starter)}.json`), 'utf8')) as { systemPrompt: string }
  assert.match(config.systemPrompt, /You are agent "concierge"/)
  assert.match(config.systemPrompt, /Your standing role: the person's front door/)
  assert.ok(!config.systemPrompt.includes('{{'), 'every placeholder is filled')
})

test("an agent the person started carries their own words to another as theirs, answering its question; its helpers can't", async () => {
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro ask human "Black or dark grey?"' }), name: 'painter', model: null, folder: null })
  const ask = await waitFor("painter's question", async () => (await phone.snapshot()).asks.find((candidate) => candidate.agentName === 'painter'))
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: `ouro relay painter --ask ${ask.id} "Black, like the old ones" > relay.txt 2>&1; ouro send human "relay says: $(tr "\\n" " " < relay.txt)"` }), name: 'courier', model: null, folder: null })
  assert.match(await says('courier', 'relay says:'), /as human's own words/)

  const relayed = await waitFor("the relayed words in painter's chat", async () => (await phone.conversation('painter')).find((message) => message.text === 'Black, like the old ones'))
  assert.equal(relayed.from, OWNER_ADDRESS, "they are the person's words")
  assert.equal(relayed.relayedBy, 'courier', 'and say who carried them')
  assert.equal(relayed.answersAskId, ask.id)
  assert.equal((await phone.snapshot()).asks.some((candidate) => candidate.id === ask.id), false, 'the question is closed')

  // A relay that names no question closes none of the recipient's.
  await send('painter', standInScript({ do: 'run', command: 'ouro ask human "Matte or gloss?"' }))
  const second = await waitFor("painter's second question", async () => (await phone.snapshot()).asks.find((candidate) => candidate.agentName === 'painter'))
  await send('courier', standInScript({ do: 'run', command: 'ouro relay painter "Thanks!" > relay2.txt 2>&1; ouro reply "relayed: $(tr "\\n" " " < relay2.txt)"' }))
  await says('courier', 'relayed:')
  assert.ok((await phone.snapshot()).asks.some((candidate) => candidate.id === second.id), 'the open question stays open')

  // A helper courier starts reports to courier, not to the person: what it says can't stand as theirs.
  const errandTask = join(run.dataDir, 'errand-task.txt')
  writeFileSync(errandTask, standInScript({ do: 'run', command: 'ouro relay painter "ship it" > relay3.txt 2>&1; ouro send human "helper relay says: $(tr "\\n" " " < relay3.txt)"' }))
  await send('courier', standInScript({ do: 'run', command: `ouro spawn errand "$(cat ${errandTask})"` }))
  const refused = await waitFor("the helper's relay to be refused", async () => {
    const snapshot = await phone.snapshot()
    const chats = snapshot.chats.filter((candidate) => candidate.members.some((member) => member.address === 'errand'))
    for (const chat of chats) {
      const found = (await phone.history(chat.id)).messages.find((message) => message.text.startsWith('helper relay says:'))
      if (found) return found
    }
    return undefined
  })
  assert.match(refused.text, /only an agent a person started relays/)
  assert.equal((await phone.conversation('painter')).some((message) => message.text === 'ship it'), false)
})

test('pins: an agent pins for its creator, in the order pinned; the person unpins, and an archived agent loses its pin', async () => {
  const painter = await phone.agent('painter')
  await send('painter', standInScript({ do: 'run', command: 'ouro pin painter > pin.txt 2>&1; ouro reply "pin says: $(cat pin.txt)"' }))
  assert.match(await says('painter', 'pin says:'), /pinned painter/)
  const starter = await phone.agent(STARTER)
  const order = async () => (await phone.snapshot()).pins.map((pin) => (pin.target.kind === 'agent' ? pin.target.agentId : null))
  assert.deepEqual(await order(), [starter.id, painter.id])
  await assert.rejects(phone.command('pin', { target: { kind: 'remote_agent', address: 'nobody@nowhere' } }), /no agent nobody@nowhere/, 'only what the lists show')

  await phone.command('unpin', { target: { kind: 'agent', agentId: starter.id } })
  assert.deepEqual(await order(), [painter.id])
  await phone.command('stop_agent', { agentId: painter.id }).catch(() => undefined)
  await waitFor('painter to stop', async () => ['stopped', 'done'].includes((await phone.agent('painter')).state.state))
  await phone.command('archive_agent', { agentId: painter.id })
  assert.deepEqual(await order(), [])
})

test('a machine with a master keeps it, pinned, with its front-door rules as standing instructions', async () => {
  const earlier = new JourneyRun()
  try {
    await earlier.startServer()
    await earlier.killServer('SIGKILL')
    // As an older release left it: a paired device and a master, and no starter made yet.
    const store = new Store(join(earlier.dataDir, 'ouro.db'))
    store.transaction(() => {
      const owner = store.ownerPerson()!
      store.insertDevice({ id: 'old-phone', name: 'old phone', personId: owner.id, pairedAt: 1, lastSeenAt: null, revokedAt: null }, 'not-a-real-token-hash')
      store.insertAgent({
        id: 'oldmaster', name: 'master', task: 'route', folder: earlier.dir, model: 'stand-in', parent: OWNER_ADDRESS, createdBy: OWNER_ADDRESS, createdAt: 1,
        lifecycle: { state: { state: 'stopped', since: 1, stopped: { reason: 'idle' } }, instanceGeneration: 0, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: 0, consecutiveStalls: 0 },
        credentialHash: 'x', worktree: null, promptCacheLifetime: '5m',
      })
    })
    store.close()

    await earlier.startServer()
    assert.match(await earlier.cli('list'), /^master {2}stopped/m)
    assert.doesNotMatch(await earlier.cli('list'), /concierge/, 'and no second front door')
    const reopened = new Store(join(earlier.dataDir, 'ouro.db'))
    try {
      assert.deepEqual(reopened.agentById('oldmaster')!.instructions, { kind: 'protocol', name: 'starter' }, 'starter.md, by name')
      assert.deepEqual(reopened.listPins(reopened.ownerPerson()!.id).map((pin) => pin.target), [{ kind: 'agent', agentId: 'oldmaster' }])
    } finally {
      reopened.close()
    }
  } finally {
    await earlier.cleanup()
  }
})
