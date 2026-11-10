// M1: pair, create an agent, send, get a reply, kill ourod mid-turn, lose nothing, and leave the runner undisturbed.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import type { AgentEntity, MessageEntity } from '@ouro/contract'
import { CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'

const runs: JourneyRun[] = []
const newRun = (): JourneyRun => {
  const run = new JourneyRun()
  runs.push(run)
  return run
}
after(async () => {
  await Promise.all(runs.map((run) => run.cleanup()))
})

const repliesIn = (messages: MessageEntity[], agentName: string) => messages.filter((message) => message.from === agentName)

const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)

test('pair, create an agent, send, and get a reply through the real command', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()

  const { agent } = await phone.command('create_agent', { task: 'say hello', name: 'greeter', model: null, folder: null })
  assert.equal(agent.name, 'greeter')
  assert.equal(agent.parent, 'human')

  // The direct chat exists from the moment creation returns, with the task as its first message.
  const initial = await phone.conversation('greeter')
  assert.equal(initial[0]?.purpose, 'task')

  await waitFor('the reply to the task', async () => repliesIn(await phone.conversation('greeter'), 'greeter').length >= 1)

  const { message } = await phone.command('send_message', { to: 'greeter', text: 'text with "quotes", $5B and `ticks`', attachmentIds: [], wake: 'wake', answersAskId: null })
  assert.equal(message.deliveries[0]?.recipient, 'greeter')
  const conversation = await waitFor('the reply to the message', async () => {
    const messages = await phone.conversation('greeter')
    return repliesIn(messages, 'greeter').length >= 2 ? messages : null
  })
  assert.equal(conversation.at(-1)?.text, 'stand-in received: text with "quotes", $5B and `ticks`')
  await waitFor('the delivery to complete', async () => {
    const sent = (await phone.conversation('greeter')).find((candidate) => candidate.id === message.id)
    return sent?.deliveries[0]?.state.state === 'completed'
  })

  const why = await run.cli('why', 'greeter')
  assert.match(why, /starting -> idle/)
  assert.match(why, /idle -> in_turn/)
})

test('retrying a send with the same key delivers once, and reusing a key for something else is refused', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  await phone.command('create_agent', { task: 'greet', name: 'once', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('once'), 'once').length === 1)

  const input = { to: 'once', text: 'only once', attachmentIds: [], wake: 'wake', answersAskId: null }
  const first = await phone.command('send_message', input, 'same-key-1234')
  const second = await phone.command('send_message', input, 'same-key-1234')
  assert.equal(first.message.id, second.message.id)
  await assert.rejects(phone.command('send_message', { ...input, text: 'different' }, 'same-key-1234'), (error: CommandFailed) => error.code === 'idempotency_conflict')

  await waitFor('the reply', async () => repliesIn(await phone.conversation('once'), 'once').length === 2)
  const fromHuman = (await phone.conversation('once')).filter((message) => message.text === 'only once')
  assert.equal(fromHuman.length, 1)
})

test('killing ourod mid-turn loses nothing and leaves the runner undisturbed', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  await phone.command('create_agent', { task: 'wait for work', name: 'worker', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('worker'), 'worker').length === 1)
  const before = await phone.snapshot()
  const chatId = await phone.directChatWith('worker')
  const stream = phone.openChanges(before.cursor, before.epoch)

  await waitFor('the agent to go idle', async () => (await phone.agent('worker')).state.state === 'idle')
  const generationBefore = generationOf(await phone.agent('worker'))!
  const runnerPidBefore = await run.runnerPid((await phone.agent('worker')).id, generationBefore)
  assert.ok(runnerPidBefore)

  const { message: sent } = await phone.command('send_message', {
    to: 'worker',
    text: standInScript({ do: 'barrier', name: 'mid-turn' }, { do: 'run', command: 'ouro reply "finished after the restart"' }),
    attachmentIds: [],
    wake: 'wake',
    answersAskId: null,
  })
  await waitFor('the turn to reach the barrier', () => run.barrierReached('mid-turn'))

  await run.killServer('SIGKILL')
  stream.close()

  // The model keeps working with no server at all: its command keeps retrying until one is back.
  run.releaseBarrier('mid-turn')
  await new Promise((done) => setTimeout(done, 300))
  const workerId = before.agents.find((agent) => agent.name === 'worker')!.id
  assert.equal(await run.runnerPid(workerId, generationBefore), runnerPidBefore, 'the runner survives the kill')

  await run.startServer()

  await waitFor('the reply after the restart', async () => {
    const messages = await phone.conversation('worker')
    return messages.some((message) => message.text === 'finished after the restart')
  })
  const settled = await waitFor('the delivery to complete', async () => {
    const page = await phone.history(chatId)
    const delivery = page.messages.find((message) => message.id === sent.id)?.deliveries[0]
    return delivery?.state.state === 'completed' ? page : null
  })

  // One reply, not two, and the message wasn't marked as possibly seen because the turn really did finish.
  assert.equal(settled.messages.filter((message) => message.text === 'finished after the restart').length, 1)
  const after = await phone.agent('worker')
  assert.equal(generationOf(after), generationBefore, 'no second instance was started')
  assert.equal(await run.runnerPid(after.id, generationBefore), runnerPidBefore, 'the same runner process carried on')

  // The pairing survived, and the phone's place in the stream catches up on exactly what it missed, once.
  const lastCursorSeen = stream.frames.flatMap((frame) => (frame.frame === 'change' ? [frame.change.cursor] : [])).at(-1) ?? before.cursor
  const caughtUp = phone.openChanges(lastCursorSeen, before.epoch)
  await waitFor('catch-up', () => caughtUp.frames.some((frame) => frame.frame === 'caught_up'))
  const seenMessages = [...stream.changes(), ...caughtUp.changes()].filter((change) => change.entity === 'message' && change.op === 'upsert' && change.id !== sent.id)
  assert.ok(seenMessages.some((change) => change.op === 'upsert' && change.entity === 'message' && change.value.text === 'finished after the restart'))
  caughtUp.close()
  const cursors = caughtUp.changes().map((change) => change.cursor)
  assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b), 'in order')
  assert.equal(new Set(caughtUp.changes().map((change) => `${change.entity}:${change.id}`)).size, caughtUp.changes().length, 'each entity once')

  // Follow-up work completes.
  await phone.command('send_message', { to: 'worker', text: 'one more', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the follow-up reply', async () => (await phone.conversation('worker')).some((message) => message.text === 'stand-in received: one more'))
})

test('a runner killed mid-turn: its work returns marked as possibly seen and completes with one reply', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  await phone.command('create_agent', { task: 'ready', name: 'crasher', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('crasher'), 'crasher').length === 1)

  const { message } = await phone.command('send_message', {
    to: 'crasher',
    text: standInScript({ do: 'crash_once', name: 'first' }, { do: 'run', command: 'ouro reply "recovered"' }),
    attachmentIds: [],
    wake: 'wake',
    answersAskId: null,
  })

  const requeued = await waitFor('the crash to requeue the message', async () => {
    const found = (await phone.conversation('crasher')).find((candidate) => candidate.id === message.id)
    const state = found?.deliveries[0]?.state
    return state?.state === 'queued' && state.possiblySeen ? state : null
  })
  assert.equal(requeued.possiblySeen, true)
  const crashed = await phone.agent('crasher')
  assert.ok(crashed.state.state === 'stopped' && crashed.state.stopped.reason === 'crash')

  // The backoff is 5 s; move the controlled clock instead of waiting.
  run.advanceClock(6_000)
  await waitFor('the single reply', async () => (await phone.conversation('crasher')).some((candidate) => candidate.text === 'recovered'))
  await waitFor('the delivery to complete', async () => {
    const found = (await phone.conversation('crasher')).find((candidate) => candidate.id === message.id)
    return found?.deliveries[0]?.state.state === 'completed'
  })
  assert.equal((await phone.conversation('crasher')).filter((candidate) => candidate.text === 'recovered').length, 1)
  assert.equal(generationOf(await phone.agent('crasher')), 2)
})

test('after a restart, a deliberately stopped agent stays stopped; a message wakes it', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  const { agent } = await phone.command('create_agent', { task: 'ready', name: 'sleeper', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('sleeper'), 'sleeper').length === 1)
  await waitFor('idle', async () => (await phone.agent('sleeper')).state.state === 'idle')

  await phone.command('stop_agent', { agentId: agent.id })
  await waitFor('stopped', async () => (await phone.agent('sleeper')).state.state === 'stopped')

  await run.killServer('SIGKILL')
  await run.startServer()
  await new Promise((done) => setTimeout(done, 500))
  assert.equal((await phone.agent('sleeper')).state.state, 'stopped')

  await phone.command('send_message', { to: 'sleeper', text: 'wake up', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the reply', async () => (await phone.conversation('sleeper')).some((message) => message.text === 'stand-in received: wake up'))
  assert.equal(generationOf(await phone.agent('sleeper')), 2)
})

test('an FYI waits without waking, and arrives with the next real message', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  const { agent } = await phone.command('create_agent', { task: 'ready', name: 'fyi-target', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('fyi-target'), 'fyi-target').length === 1)
  await waitFor('idle', async () => (await phone.agent('fyi-target')).state.state === 'idle')
  await phone.command('stop_agent', { agentId: agent.id })
  await waitFor('stopped', async () => (await phone.agent('fyi-target')).state.state === 'stopped')

  const { message: fyi } = await phone.command('send_message', { to: 'fyi-target', text: 'just so you know', attachmentIds: [], wake: 'fyi', answersAskId: null })
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await phone.agent('fyi-target')).state.state, 'stopped')

  await phone.command('send_message', { to: 'fyi-target', text: 'now wake', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('both to complete', async () => {
    const found = (await phone.conversation('fyi-target')).find((candidate) => candidate.id === fyi.id)
    return found?.deliveries[0]?.state.state === 'completed'
  })
})

test('a message sent mid-turn is with the runner but not taken in until the model reaches it', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  await phone.command('create_agent', { task: 'ready', name: 'busy', model: null, folder: null })
  await waitFor('the task reply', async () => repliesIn(await phone.conversation('busy'), 'busy').length === 1)
  const stateOf = async (id: string) => (await phone.conversation('busy')).find((candidate) => candidate.id === id)?.deliveries[0]?.state

  const { message: first } = await phone.command('send_message', {
    to: 'busy', text: standInScript({ do: 'barrier', name: 'working' }, { do: 'text', text: 'first done' }), attachmentIds: [], wake: 'wake', answersAskId: null,
  })
  await waitFor('the turn to reach the barrier', () => run.barrierReached('working'))
  assert.equal((await stateOf(first.id))?.state, 'taken_in', 'the message that started the turn is in the conversation')

  // The stand-in takes a mid-turn message in at its next turn, so while this turn runs it stays with the runner.
  const { message: second } = await phone.command('send_message', { to: 'busy', text: 'while you work', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the second message to reach the runner', async () => (await stateOf(second.id))?.state === 'handed_to_runner')
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await stateOf(second.id))?.state, 'handed_to_runner', 'not taken in while the turn is still busy')

  run.releaseBarrier('working')
  await waitFor('the reply to the second message', async () => (await phone.conversation('busy')).some((message) => message.text === 'stand-in received: while you work'))
  await waitFor('both to complete', async () => (await stateOf(first.id))?.state === 'completed' && (await stateOf(second.id))?.state === 'completed')
})

test('agent commands: spawn, list, send between agents, ask, done, reopen', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  await phone.command('create_agent', {
    task: standInScript(
      { do: 'run', command: 'ouro spawn helper "$(printf "standin:[{\\"do\\":\\"run\\",\\"command\\":\\"ouro done helper-result\\"}]")"' },
      { do: 'run', command: 'ouro list > listing.txt; ouro send human "listed"' },
    ),
    name: 'lead',
    model: null,
    folder: null,
  })
  await waitFor('the helper to exist and finish', async () => (await phone.snapshot()).agents.find((agent) => agent.name === 'helper')?.state.state === 'done')
  const helper = (await phone.snapshot()).agents.find((agent) => agent.name === 'helper')!
  assert.equal(helper.parent, 'lead')
  assert.equal(helper.createdBy, 'human')

  // The helper's report reached its parent, which replied to the helper's message through the normal path.
  await waitFor('lead to take in the report', async () => {
    const lead = await phone.agent('lead')
    return lead.queuedDeliveries === 0 && lead.state.state === 'idle'
  })
  assert.ok((await phone.conversation('lead')).some((message) => message.text === 'listed'))

  // ask: posed as a message with choices; a direct message closes it.
  await phone.command('send_message', { to: 'lead', text: standInScript({ do: 'run', command: 'ouro ask human --blocked --choice Yes --choice No "Ship it?"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const ask = await waitFor('the ask', async () => (await phone.snapshot()).asks[0])
  assert.equal(ask.level, 'blocked')
  assert.deepEqual(ask.choices, ['Yes', 'No'])
  const posed = (await phone.conversation('lead')).find((message) => message.posesAskId === ask.id)
  assert.equal(posed?.text, 'Ship it?')
  await phone.command('send_message', { to: 'lead', text: 'Yes', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the ask to close', async () => (await phone.snapshot()).asks.length === 0)

  // A done agent reopens on a message, on the same conversation.
  await phone.command('send_message', { to: 'helper', text: 'one more thing', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the reopened helper to reply', async () => (await phone.conversation('helper')).some((message) => message.text === 'stand-in received: one more thing'))
})

test('hostile input is refused with state unchanged', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  const noToken = await fetch(`${run.url}/v2/snapshot`)
  assert.equal(noToken.status, 401)
  const badToken = await fetch(`${run.url}/v2/snapshot`, { headers: { authorization: 'Bearer nonsense' } })
  assert.equal(badToken.status, 401)
  const badCode = await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code: 'not-a-code', deviceName: 'x' }) })
  assert.equal(badCode.status, 403)

  await phone.command('create_agent', { task: 'first', name: 'taken', model: null, folder: null })
  await assert.rejects(phone.command('create_agent', { task: 'second', name: 'taken', model: null, folder: null }), (error: CommandFailed) => error.code === 'agent_name_taken')
  await assert.rejects(phone.command('create_agent', { task: 'second', name: 'human', model: null, folder: null }), (error: CommandFailed) => error.code === 'agent_name_reserved')
  await assert.rejects(phone.command('send_message', { to: 'taken', text: '   ', attachmentIds: [], wake: 'wake', answersAskId: null }), (error: CommandFailed) => error.code === 'empty_message')
  const before = await phone.conversation('taken')
  await assert.rejects(phone.command('send_message', { to: 'nobody', text: 'hi', attachmentIds: [], wake: 'wake', answersAskId: null }), (error: CommandFailed) => error.code === 'not_found')
  assert.equal((await phone.conversation('taken')).length >= before.length, true)
  assert.deepEqual((await phone.snapshot()).agents.map((agent) => agent.name).sort(), ['master', 'taken'], 'only the master and the one it made')

  // A traversal-shaped file name can't pick where bytes are stored, and revoking cuts the stream at once.
  const upload = await fetch(`${run.url}/v2/attachments`, { method: 'POST', headers: { authorization: `Bearer ${phone.token}`, 'x-file-name': encodeURIComponent('../../escape.txt') }, body: 'bytes' })
  const attachment = await upload.json() as { id: string }
  assert.match(attachment.id, /^[0-9a-f]{64}$/)
  // The bytes land inside the attachments folder under their id, and nowhere else in the run, whatever the name asked for.
  const filesHolding = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name === 'escape.txt' || readFileSync(join(entry.parentPath, entry.name)).equals(Buffer.from('bytes'))))
    .map((entry) => relative(run.dir, join(entry.parentPath, entry.name)))
  assert.deepEqual(filesHolding(run.dir), [relative(run.dir, realpathSync(join(run.dataDir, 'attachments', attachment.id)))])
  assert.equal(existsSync(join(run.dataDir, 'attachments', '../../escape.txt')), false, 'not where the name pointed')

  const snapshot = await phone.snapshot()
  const stream = phone.openChanges(snapshot.cursor, snapshot.epoch)
  await waitFor('the stream to catch up', () => stream.frames.some((frame) => frame.frame === 'caught_up'))
  await phone.command('revoke_device', { deviceId: phone.deviceId })
  await waitFor('the stream to be cut', () => stream.closedWith !== null)
  const afterRevoke = await fetch(`${run.url}/v2/snapshot`, { headers: { authorization: `Bearer ${phone.token}` } })
  assert.equal(afterRevoke.status, 401)
})

test('a client with an old epoch is told to take a new snapshot, and a deletion reaches an offline client', async () => {
  const run = newRun()
  await run.startServer()
  const phone = await run.pairDevice()
  const second = await run.pairDevice('second-phone')
  const snapshot = await phone.snapshot()

  const stale = phone.openChanges(0, 'an-old-epoch')
  await waitFor('the resync frame', () => stale.frames[0]?.frame === 'resync_required')

  await second.command('revoke_device', { deviceId: second.deviceId })
  const catching = phone.openChanges(snapshot.cursor, snapshot.epoch)
  await waitFor('catch-up', () => catching.frames.some((frame) => frame.frame === 'caught_up'))
  assert.ok(catching.changes().some((change) => change.entity === 'device' && change.id === second.deviceId && change.op === 'delete'))
  catching.close()
})
