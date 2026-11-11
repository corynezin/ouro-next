// Messaging between people and agents, through the real server and runners: a broadcast, the one reply reminder and
// turning reminders off,
// a file sent to an agent and back, a file given with a task, and a message to an archived agent.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, LogRecord } from '@ouro/contract'
import { MAX_ATTACHMENT_BYTES } from '@ouro/contract'
import { AppClient, CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const send = (to: string, text: string, attachmentIds: string[] = []) => phone.command('send_message', { to, text, attachmentIds, wake: 'wake', answersAskId: null })
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function logRecords(name: string): Promise<LogRecord[]> {
  return (JSON.parse(await run.cli('log', name)) as { records: LogRecord[] }).records
}

async function readyAgent(name: string, task = 'ready'): Promise<AgentEntity> {
  await phone.command('create_agent', { task, name, model: null, folder: null })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle')
  return await phone.agent(name)
}

/** A file holding text for an agent's shell command to pass on whole, quotes and all. */
function textFile(name: string, text: string): string {
  const path = join(run.dir, name)
  writeFileSync(path, text)
  return path
}

/** What a stand-in agent says that wants no answer: the stand-in's default reply would start a conversation between stand-ins. */
const QUIET = standInScript({ do: 'text', text: 'noted' })

const remindersIn = (records: LogRecord[]) => records.flatMap((record) => (record.kind === 'incoming' && record.from === 'system' && record.text.includes('no reply yet') ? [record.text] : []))

async function settled(name: string): Promise<void> {
  await waitFor(`${name} to settle`, async () => (await phone.agent(name)).state.state === 'idle')
  await pause(800)
  await waitFor(`${name} to settle`, async () => (await phone.agent(name)).state.state === 'idle')
}

// First, while the only agents are its own: every running agent hears a broadcast.
test('a broadcast reaches every other running agent, and not a stopped one', async () => {
  await readyAgent('herald')
  for (const name of ['north', 'south', 'resting']) await readyAgent(name)
  await phone.command('stop_agent', { agentId: (await phone.agent('resting')).id })
  await waitFor('resting to stop', async () => (await phone.agent('resting')).state.state === 'stopped')

  const answerQuietly = textFile('quiet-answer.txt', QUIET)
  const announcement = textFile('announcement.txt', `the build is green\n${standInScript({ do: 'run', command: `ouro reply "$(cat ${answerQuietly})"` })}`)
  await send('herald', standInScript({ do: 'run', command: `ouro send all "$(cat ${announcement})"` }))

  for (const name of ['north', 'south']) {
    await waitFor(`${name} to hear it`, async () => (await logRecords(name)).some((record) => record.kind === 'incoming' && record.from === 'herald' && record.text.startsWith('the build is green')))
  }
  const heraldLog = await logRecords('herald')
  const output = heraldLog.find((record) => record.kind === 'tool_result' && record.text.startsWith('sent to'))
  assert.ok(output && output.kind === 'tool_result')
  assert.deepEqual(output.text.trim().replace('sent to ', '').split(', ').sort(), ['north', 'south'])
  assert.equal((await phone.agent('resting')).state.state, 'stopped', 'a stopped agent is not woken')
  assert.equal((await logRecords('resting')).some((record) => record.kind === 'incoming' && record.from === 'herald'), false)
  await waitFor('the answers to come back', async () => (await logRecords('herald')).filter((record) => record.kind === 'incoming' && record.text.startsWith(QUIET)).length === 2)
})

test('a turn that leaves a person without a reply gets exactly one reminder, and the person hears back', async () => {
  await readyAgent('mute')
  await send('mute', `what is the status?\n${standInScript({ do: 'text', text: 'thinking about it, but not saying' })}`)
  // The stand-in answers the reminder with its default reply, which answers the person's message.
  const answer = await waitFor('the person to hear back', async () => (await phone.conversation('mute')).find((message) => message.text.startsWith('stand-in received: human\'s message has no reply yet')) ?? null)
  assert.equal(answer.text, 'stand-in received: human\'s message has no reply yet; your terminal is not seen. Reply with `ouro send human "…"` (short, outcome first). If you are still working on it or waiting, say so in one line. This is the only reminder.')
  await settled('mute')
  assert.equal(remindersIn(await logRecords('mute')).length, 1)

  // Answered, the next one owes nothing; nor does an FYI with it.
  await phone.command('send_message', { to: 'mute', text: `by the way\n${QUIET}`, attachmentIds: [], wake: 'fyi', answersAskId: null })
  await send('mute', 'and now?')
  await waitFor('the answer', async () => (await phone.conversation('mute')).some((message) => message.text === 'stand-in received: and now?'))
  await settled('mute')
  assert.equal(remindersIn(await logRecords('mute')).length, 1, 'no second reminder')
})

test('with reply reminders off a turn that leaves a person unanswered gets none, and turning them on again reminds of nothing from before', async () => {
  const { server } = await phone.command('set_reply_reminders', { on: false })
  assert.equal(server.limits.replyReminders, false)
  try {
    // The agent from the test before, its reminder long answered.
    await send('mute', `anything new?\n${standInScript({ do: 'text', text: 'keeping it to myself' })}`)
    await waitFor('the turn to be taken in', async () => (await logRecords('mute')).some((record) => record.kind === 'incoming' && record.text.startsWith('anything new?')))
    await settled('mute')
    assert.equal(remindersIn(await logRecords('mute')).length, 1, 'only the reminder from before')
  } finally {
    assert.equal((await phone.command('set_reply_reminders', { on: true })).server.limits.replyReminders, true)
  }
  // The next turn is answered; what was owed while reminders were off was let go, so nothing is reminded of now.
  await send('mute', 'and since?')
  await waitFor('the answer', async () => (await phone.conversation('mute')).some((message) => message.text === 'stand-in received: and since?'))
  await settled('mute')
  assert.equal(remindersIn(await logRecords('mute')).length, 1, 'only the reminder from before')
})

test('only the owner turns reply reminders off', async () => {
  const { code } = await phone.command('start_pairing', { inviteePersonName: 'guest' })
  const paired = await (await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'guest-phone' }) })).json() as { deviceToken: string; deviceId: string }
  const guest = new AppClient(run, paired.deviceToken, paired.deviceId)
  await assert.rejects(guest.command('set_reply_reminders', { on: false }), (error: CommandFailed) => error.code === 'forbidden')
  assert.equal((await phone.snapshot()).server.limits.replyReminders, true)
})

test('an agent writing back owes nothing, and a helper is not reminded of its task', async () => {
  await readyAgent('asker')
  const question = textFile('question.txt', `which port?\n${standInScript({ do: 'run', command: `ouro reply "$(cat ${textFile('port.txt', `8790\n${QUIET}`)})"` })}`)
  const helperTask = textFile('helper-task.txt', QUIET)
  await readyAgent('answerer')
  await send('asker', standInScript(
    { do: 'run', command: `ouro send answerer "$(cat ${question})"` },
    { do: 'run', command: `ouro spawn errand "$(cat ${helperTask})"` },
  ))
  await waitFor('the answer to come back', async () => (await logRecords('asker')).some((record) => record.kind === 'incoming' && record.from === 'answerer' && record.text.startsWith('8790')))
  await waitFor('the helper to be up', async () => (await phone.snapshot()).agents.some((agent) => agent.name === 'errand' && agent.state.state === 'idle'))
  await settled('asker')
  await settled('answerer')

  // The asker left the person unanswered, and only that.
  const reminders = remindersIn(await logRecords('asker'))
  assert.equal(reminders.length, 1)
  assert.match(reminders[0]!, /^human's message has no reply yet/)
  assert.deepEqual(remindersIn(await logRecords('answerer')), [], 'it replied')
  assert.deepEqual(remindersIn(await logRecords('errand')), [], 'a task is answered by its result')
})

test('a file sent to an agent can be read by it under its own name, and a file it sends back arrives whole', async () => {
  await readyAgent('reader')
  const { attachment } = await phone.upload('garden notes.txt', Buffer.from('tomatoes: water at dawn\n'), 'text/plain')
  assert.ok(attachment)
  const readIt = 'f=$(printf "%s\\n" "$OURO_STANDIN_MODEL_CONTENT" | grep "/garden notes.txt$"); cp "$f" summary.txt; echo "beans: shade" >> summary.txt; ouro reply --file summary.txt "read: $(head -1 "$f")"'
  await send('reader', `please read this\n${standInScript({ do: 'run', command: readIt })}`, [attachment.id])

  const reply = await waitFor('the reply', async () => (await phone.conversation('reader')).find((message) => message.text.startsWith('read:')) ?? null)
  assert.equal(reply.text, 'read: tomatoes: water at dawn')
  assert.equal(reply.attachments.length, 1)
  assert.equal(reply.attachments[0]!.fileName, 'summary.txt')
  assert.equal(reply.attachments[0]!.mimeType, 'text/plain', 'its type from its name, as ouro reply --file sends none')
  assert.equal((await phone.download(reply.attachments[0]!.id)).toString(), 'tomatoes: water at dawn\nbeans: shade\n')
})

test('a file given with a task comes in the task itself, and the agent can read it', async () => {
  // Room under the agent limit: reader is finished with.
  const reader = await phone.agent('reader')
  await phone.command('archive_agent', { agentId: reader.id })
  await waitFor('reader to be archived', async () => (await phone.snapshot()).agents.some((agent) => agent.id === reader.id && agent.state.state === 'archived'))
  const { attachment } = await phone.upload('recipe.txt', Buffer.from('bread: flour, water, salt\n'), 'text/plain')
  assert.ok(attachment)
  const readIt = 'f=$(printf "%s\\n" "$OURO_STANDIN_MODEL_CONTENT" | grep "/recipe.txt$"); ouro done "read: $(head -1 "$f")"'
  await phone.command('create_agent', { task: `read the recipe\n${standInScript({ do: 'run', command: readIt })}`, name: 'baker', model: null, folder: null, attachmentIds: [attachment.id] })
  const task = (await phone.conversation('baker'))[0]!
  assert.deepEqual(task.attachments.map((a) => a.fileName), ['recipe.txt'])
  const done = await waitFor('its result', async () => (await phone.conversation('baker')).find((message) => message.from !== 'human' && message.text.includes('read: ')) ?? null)
  assert.match(done.text, /read: bread: flour, water, salt/)
  await assert.rejects(phone.command('create_agent', { task: 'no file', name: 'nofile', model: null, folder: null, attachmentIds: ['missing'] }),
    (error: unknown) => error instanceof CommandFailed && error.code === 'not_found', 'a missing file refuses it, and nothing is made')
  assert.equal((await phone.snapshot()).agents.some((agent) => agent.name === 'nofile'), false)
  await phone.command('archive_agent', { agentId: (await phone.agent('baker')).id })
})

test('a file up to 25 MB is taken, and a larger one is refused', async () => {
  const largest = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7)
  const taken = await phone.upload('largest.bin', largest, 'application/octet-stream')
  assert.equal(taken.status, 200)
  assert.equal(taken.attachment!.byteLength, MAX_ATTACHMENT_BYTES)
  const refused = await phone.upload('too-large.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7), 'application/octet-stream')
  assert.equal(refused.status, 413)
})

test('a message to an archived agent fails with an error, from a person and from an agent', async () => {
  // Room under the agent limit.
  for (const name of ['herald', 'north', 'south']) await phone.command('archive_agent', { agentId: (await phone.agent(name)).id })
  const retired = await readyAgent('retired')
  await phone.command('archive_agent', { agentId: retired.id })
  await waitFor('it to be archived', async () => (await phone.snapshot()).agents.some((agent) => agent.id === retired.id && agent.state.state === 'archived'))

  await assert.rejects(send('retired', 'are you there?'), (error: unknown) => error instanceof CommandFailed && error.code === 'agent_archived')
  await readyAgent('caller')
  await send('caller', standInScript({ do: 'run', command: 'ouro send retired "are you there?"' }))
  await waitFor('the failure in its log', async () => (await logRecords('caller')).some((record) => record.kind === 'tool_result' && record.isError && record.text.includes('retired is archived')))
})
