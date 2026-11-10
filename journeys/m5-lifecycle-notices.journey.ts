// What the system tells agents and people when work goes wrong, through the real server and runners: a stalled turn, a
// turn running long, a helper going down, a done report with nowhere to go, a server restart and a lost conversation.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, MessageEntity } from '@ouro/contract'
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
const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)
const occurrences = (text: string, part: string) => text.split(part).length - 1

/** Everything in an agent's log that has text, one record per line: what it took in, ran and was told. */
async function logText(name: string): Promise<string> {
  const page = JSON.parse(await run.cli('log', name)) as { records: { text?: string; input?: string }[] }
  return page.records.map((record) => record.text ?? record.input ?? '').join('\n')
}

async function readyAgent(name: string, task = 'ready'): Promise<AgentEntity> {
  await phone.command('create_agent', { task, name, model: null, folder: null })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle')
  return await phone.agent(name)
}

/** A helper's task that takes no reply: the stand-in's default reply would start a conversation between stand-ins. */
const QUIET_TASK = standInScript({ do: 'text', text: 'ready' })

async function conversationIfAny(agentName: string): Promise<MessageEntity[]> {
  const snapshot = await phone.snapshot()
  const chat = snapshot.chats.find((candidate) => candidate.kind === 'direct' && candidate.members.some((member) => member.address === agentName) && candidate.members.some((member) => member.address === snapshot.viewer.address))
  return chat ? (await phone.history(chat.id)).messages : []
}

/** A helper of `parent`, started by the parent itself, whose task is `task`. Waits until it exists. */
async function spawnHelper(parent: string, name: string, task: string): Promise<AgentEntity> {
  const taskFile = join(run.dir, `${name}-task.txt`)
  writeFileSync(taskFile, task)
  await send(parent, standInScript({ do: 'run', command: `ouro spawn ${name} "$(cat ${taskFile})"` }))
  return await waitFor(`${name} to be spawned`, async () => (await phone.snapshot()).agents.find((agent) => agent.name === name) ?? null)
}

async function systemNotices(): Promise<string[]> {
  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === snapshot.viewer.address))
  if (!systemChat) return []
  return (await phone.history(systemChat.id)).messages.map((message) => message.text)
}

/** A shell command that shows as a running tool until its barrier is released. */
const toolUntilReleased = (name: string) => `touch "$OURO_STANDIN_BARRIERS/${name}.reached"; while [ ! -e "$OURO_STANDIN_BARRIERS/${name}.release" ]; do sleep 0.05; done`

test('a stalled turn is restarted, its message comes back, and the agent is told it stalled', async () => {
  const agent = await readyAgent('staller')
  await send('staller', `work on this\n${standInScript({ do: 'barrier', name: 'stall' }, { do: 'run', command: 'ouro reply "carried on"' })}`)
  await waitFor('the turn to go silent', () => run.barrierReached('stall'))
  const stalledGeneration = generationOf(await phone.agent('staller'))!

  run.advanceClock(10 * MINUTE + 1000)
  await waitFor('a new runner to take the turn over', async () => (generationOf(await phone.agent('staller')) ?? 0) > stalledGeneration)
  run.releaseBarrier('stall')
  await waitFor('a reply after the restart', async () => (await phone.conversation('staller')).some((message) => message.text === 'carried on'))
  const log = await logText('staller')
  assert.match(log, /Your last turn stalled \(no output for 10 min\) and was restarted\. Check where you were and carry on\./)
  assert.equal((await run.cli('why', 'staller')).includes('no output before the stall deadline'), true)
  assert.equal((await phone.agent('staller')).lastTurnFailure, null)
  assert.equal(agent.name, 'staller')
})

test('a turn running past 30 minutes is reported to the parent once, and keeps running', async () => {
  await readyAgent('lead')
  await spawnHelper('lead', 'slowpoke', standInScript(
    { do: 'barrier', name: 'slow-start' },
    { do: 'run', command: toolUntilReleased('slow-tool') },
    { do: 'text', text: 'slowpoke finished' },
  ))
  await waitFor('the helper to start its long turn', () => run.barrierReached('slow-start'))
  // Output at 9 minutes keeps it clear of the stall deadline; the turn as a whole still runs past 30.
  run.advanceClock(9 * MINUTE)
  run.releaseBarrier('slow-start')
  await waitFor('the helper to run its tool', () => run.barrierReached('slow-tool'))
  await waitFor('the tool to show', async () => {
    const state = (await phone.agent('slowpoke')).state
    return state.state === 'in_turn' && state.activity.kind === 'tool'
  })
  run.advanceClock(22 * MINUTE)
  const alert = 'Agent "slowpoke" has been busy on one turn for over 31 min. It may be stuck in a loop: look with ouro log slowpoke, or tell it to stop and report.'
  await waitFor('the parent to hear of it', async () => (await logText('lead')).includes(alert))
  assert.equal((await phone.agent('slowpoke')).state.state, 'in_turn', 'the long turn is not stopped')

  run.advanceClock(5 * MINUTE)
  await pause(800)
  assert.equal(occurrences(await logText('lead'), 'has been busy on one turn'), 1, 'reported once per turn')

  run.releaseBarrier('slow-tool')
  await waitFor('the helper to finish its turn', async () => (await phone.agent('slowpoke')).state.state === 'idle')
})

test('done warns about helpers still running, and a report with no parent to take it goes to the creator', async () => {
  await readyAgent('boss')
  await spawnHelper('boss', 'kid', standInScript({ do: 'barrier', name: 'kid-work' }, { do: 'run', command: 'ouro done "kid finished"' }))
  await waitFor('the helper to start work', () => run.barrierReached('kid-work'))

  await send('boss', standInScript({ do: 'run', command: 'ouro done "boss finished"' }))
  await waitFor('the boss to finish', async () => (await phone.agent('boss')).state.state === 'done')
  assert.match(await logText('boss'), /warning: your helpers kid are still running\. If their work is no longer needed, tell them to stop \(ouro send <name> "stop: call done"\); their reports would wait unread\./)

  const boss = await phone.agent('boss')
  await phone.command('archive_agent', { agentId: boss.id })
  run.releaseBarrier('kid-work')
  const report = await waitFor('the report to reach the person', async () => (await conversationIfAny('kid')).find((message) => message.text === 'kid finished') ?? null)
  assert.equal(report.from, 'kid')
  await waitFor('the helper to be done', async () => (await phone.agent('kid')).state.state === 'done')
})

test('a helper that goes down without reporting is reported to its parent and to the person', async () => {
  await readyAgent('manager')
  await spawnHelper('manager', 'fragile', QUIET_TASK)
  await waitFor('the helper to go idle', async () => (await phone.agent('fragile')).state.state === 'idle')
  const fragile = await phone.agent('fragile')
  const pid = await run.runnerPid(fragile.id, generationOf(fragile)!)
  assert.ok(pid, 'its runner is running')
  process.kill(-pid, 'SIGKILL')

  const expected = 'Your helper "fragile" stopped without reporting (it crashed or was killed). A message to it restarts it where it left off (ouro send fragile "..."), or spawn a replacement.'
  await waitFor('the parent to hear of it', async () => (await logText('manager')).includes(expected))
  const notices = await waitFor('the person to hear of it', async () => {
    const all = await systemNotices()
    return all.some((text) => text.includes('"fragile" stopped')) ? all : null
  })
  assert.ok(notices.includes('manager\'s helper "fragile" stopped without reporting (it crashed or was killed). manager has been told.'), notices.join('\n'))
  assert.match(await run.cli('why', 'fragile'), /stopped: crash|runner died while idle/)
})

test('after a restart that lost the runners, the person is told who was resumed, and only those with work come back', async () => {
  await readyAgent('sleeper')
  const busy = await readyAgent('busy')
  await send('busy', standInScript({ do: 'barrier', name: 'busy-work' }, { do: 'run', command: 'ouro reply "busy is back"' }))
  await waitFor('busy to be mid-turn', () => run.barrierReached('busy-work'))

  // Everything goes down at once, as in a reboot.
  const runners = (await phone.snapshot()).agents.flatMap((agent) => (generationOf(agent) === null ? [] : [{ id: agent.id, generation: generationOf(agent)! }]))
  await run.killServer('SIGKILL')
  for (const runner of runners) {
    const pid = await run.runnerPid(runner.id, runner.generation)
    if (pid) process.kill(-pid, 'SIGKILL')
  }
  run.releaseBarrier('busy-work')
  await run.startServer()

  const notices = await waitFor('the restart notice', async () => {
    const all = await systemNotices()
    return all.some((text) => text.startsWith('The server restarted')) ? all : null
  })
  assert.ok(notices.includes('The server restarted; resumed busy.'), notices.join('\n'))
  run.advanceClock(10_000)
  await waitFor('busy to carry on', async () => (await phone.conversation('busy')).some((message) => message.text === 'busy is back'))
  const sleeper = (await phone.agent('sleeper')).state
  assert.equal(sleeper.state, 'stopped', 'an idle agent stays down')
  assert.equal(notices.filter((text) => text.includes('stopped without reporting')).length, 1, 'no helper reports for what the restart took down')
  assert.equal(busy.name, 'busy')
})

test('a conversation the provider lost starts afresh, seeded with the task and recent messages, and says how to search', async () => {
  const agent = await readyAgent('forgetful', 'Keep the garden notes tidy')
  await send('forgetful', 'remember the tomatoes')
  await waitFor('a first reply', async () => (await phone.conversation('forgetful')).some((message) => message.text === 'stand-in received: remember the tomatoes'))
  const firstSession = JSON.parse(readFileSync(join(run.dataDir, 'agents', agent.id, `runner-${generationOf(await phone.agent('forgetful'))}.json`), 'utf8')) as { resumeProviderSessionId: string | null }
  assert.equal(firstSession.resumeProviderSessionId, null)

  await send('forgetful', `and the beans\n${standInScript({ do: 'lose_session_once', name: 'beans' }, { do: 'run', command: 'ouro reply "beans noted"' })}`)
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await phone.conversation('forgetful')).some((message) => message.text === 'beans noted')) break
    run.advanceClock(30_000)
    await pause(400)
  }
  await waitFor('the reply from the new conversation', async () => (await phone.conversation('forgetful')).some((message) => message.text === 'beans noted'))

  const log = await logText('forgetful')
  assert.match(log, /the conversation could not be resumed, so the next start begins a new one: No conversation found with session ID/)
  const generation = generationOf(await phone.agent('forgetful'))!
  const fresh = JSON.parse(readFileSync(join(run.dataDir, 'agents', agent.id, `runner-${generation}.json`), 'utf8')) as { resumeProviderSessionId: string | null; systemPrompt: string }
  assert.equal(fresh.resumeProviderSessionId, null, 'nothing to resume')
  assert.match(fresh.systemPrompt, /## Where you left off/)
  assert.match(fresh.systemPrompt, /you start with an empty memory/)
  assert.match(fresh.systemPrompt, /Your task: Keep the garden notes tidy/)
  assert.match(fresh.systemPrompt, /\[human\] remember the tomatoes/)
  assert.match(fresh.systemPrompt, /`ouro search <words>`/)

  // The search the seed points to works for an agent.
  assert.match(await run.cli('search', 'tomatoes'), /remember the tomatoes/)
})
