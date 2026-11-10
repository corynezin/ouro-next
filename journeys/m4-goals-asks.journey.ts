// Goals and asks through the real server, runners and commands, with the stand-in model and a controlled clock.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, GoalEntity } from '@ouro/contract'
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

async function readyAgent(name: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle' && (await phone.agent(name)).queuedDeliveries === 0)
  return await phone.agent(name)
}

async function goalOf(agentId: string): Promise<GoalEntity | undefined> {
  return (await phone.snapshot()).goals.find((goal) => goal.agentId === agentId)
}

const linesIn = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0)

test('goal cycles run when idle, count, and stop on done', async () => {
  const agent = await readyAgent('cycler')
  const counter = join(agent.folder, 'cycles.txt')
  await phone.command('set_goal', { agentId: agent.id, text: `count\n${standInScript({ do: 'run', command: 'echo cycle >> cycles.txt' })}`, kind: { kind: 'finishing' }, intervalSeconds: 60 })

  // Nothing before the interval, then exactly one cycle per interval.
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(linesIn(counter), 0)
  run.advanceClock(61_000)
  await waitFor('the first cycle', () => linesIn(counter) === 1)
  await waitFor('it to count', async () => (await goalOf(agent.id))?.cycleCount === 1 && !(await goalOf(agent.id) as GoalEntity & { status: { cycleRunning?: boolean } }).status.cycleRunning)
  run.advanceClock(61_000)
  await waitFor('the second cycle', () => linesIn(counter) === 2)

  // The cycle message is from the system and says how to finish.
  const cycleMessage = (await phone.conversation('cycler')).find((message) => message.purpose === 'goal_cycle')
  assert.equal(cycleMessage, undefined, "cycles aren't in the person's chat with the agent")

  const { goal } = await phone.command('mark_goal_done', { agentId: agent.id, summary: 'counted enough' })
  assert.deepEqual(goal.status.status, 'complete')
  run.advanceClock(120_000)
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(linesIn(counter), 2)
})

test('an interrupt pauses cycles until the next real message', async () => {
  const agent = await readyAgent('interrupted')
  await phone.command('set_goal', { agentId: agent.id, text: `hold\n${standInScript({ do: 'barrier', name: 'cycle-turn' })}`, kind: { kind: 'open_ended' }, intervalSeconds: 30 })
  run.advanceClock(31_000)
  await waitFor('the cycle to start', () => run.barrierReached('cycle-turn'))
  await phone.command('interrupt_agent', { agentId: agent.id })
  await waitFor('the pause', async () => {
    const goal = await goalOf(agent.id)
    return goal?.status.status === 'active' && goal.status.waitingFor?.kind === 'next_message_after_interrupt'
  })
  const cyclesBefore = (await goalOf(agent.id))!.cycleCount
  run.advanceClock(120_000)
  await new Promise((done) => setTimeout(done, 400))
  assert.equal((await goalOf(agent.id))!.cycleCount, cyclesBefore)

  run.releaseBarrier('cycle-turn')
  await send('interrupted', 'carry on')
  await waitFor('the reply', async () => (await phone.conversation('interrupted')).some((message) => message.text === 'stand-in received: carry on'))
  // The interval counts from when the agent went quiet, so move the clock only after that.
  await waitFor('the agent to go quiet', async () => (await phone.agent('interrupted')).state.state === 'idle')
  run.advanceClock(31_000)
  await waitFor('cycles to resume', async () => (await goalOf(agent.id))!.cycleCount > cyclesBefore).catch(async (error: Error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await goalOf(agent.id))} ${JSON.stringify((await phone.agent('interrupted')).state)} ${await run.cli('why', 'interrupted')}`)
  })
  // Open-ended goals refuse done.
  await assert.rejects(phone.command('mark_goal_done', { agentId: agent.id, summary: null }), (error: CommandFailed) => error.code === 'goal_refused')
  await phone.command('pause_goal', { agentId: agent.id, reason: 'enough' })
})

test('a checked goal refuses done until its real check passes, and the setter is told', async () => {
  const agent = await readyAgent('checked')
  await phone.command('set_goal', { agentId: agent.id, text: 'make done.flag', kind: { kind: 'checked', checkCommand: 'test -f done.flag' }, intervalSeconds: 3600 })

  await send('checked', standInScript({ do: 'run', command: 'ouro goal done "all set" > out.txt 2>&1; ouro reply "first try: $(cat out.txt)"' }))
  const refused = await waitFor('the refusal', async () => (await phone.conversation('checked')).find((message) => message.text.startsWith('first try:')))
  assert.match(refused.text, /check `test -f done.flag` failed/)
  assert.equal((await goalOf(agent.id))!.status.status, 'active')

  writeFileSync(join(agent.folder, 'done.flag'), '')
  await send('checked', standInScript({ do: 'run', command: 'ouro goal done "all set" > out.txt 2>&1; ouro reply "second try: $(cat out.txt)"' }))
  await waitFor('completion', async () => (await goalOf(agent.id))?.status.status === 'complete')

  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === snapshot.viewer.address))!
  const notices = (await phone.history(systemChat.id)).messages.map((message) => message.text)
  assert.ok(notices.includes('checked completed its goal: all set'), notices.join(' | '))
})

test('replacing a goal restarts its counters and keeps its notes; clearing keeps the notes too', async () => {
  const agent = await readyAgent('noted')
  await phone.command('set_goal', { agentId: agent.id, text: `note it\n${standInScript({ do: 'run', command: 'echo "learned something" > "$OURO_GOAL_NOTES"' })}`, kind: { kind: 'finishing' }, intervalSeconds: null })
  const goal = (await goalOf(agent.id))!
  assert.deepEqual(goal.interval, { kind: 'default', seconds: 30 })
  run.advanceClock(31_000)
  await waitFor('notes', async () => (await goalOf(agent.id))?.notes.includes('learned something'))
  const { goal: replaced } = await phone.command('set_goal', { agentId: agent.id, text: 'something else', kind: { kind: 'finishing' }, intervalSeconds: 600 })
  assert.equal(replaced.cycleCount, 0)
  assert.deepEqual(replaced.interval, { kind: 'chosen', seconds: 600 })
  assert.match(replaced.notes, /learned something/)
  await phone.command('clear_goal', { agentId: agent.id })
  assert.equal(await goalOf(agent.id), undefined)
  await phone.command('set_goal', { agentId: agent.id, text: 'again', kind: { kind: 'finishing' }, intervalSeconds: null })
  assert.match((await goalOf(agent.id))!.notes, /learned something/)
  await phone.command('clear_goal', { agentId: agent.id })
})

test('asks: snoozes end when the agent is done or idle, and when the person is back', async () => {
  await readyAgent('asker')
  await send('asker', standInScript({ do: 'run', command: 'ouro ask human "first?"' }, { do: 'run', command: 'ouro ask human --urgent "second?"' }, { do: 'barrier', name: 'asking' }))
  const asks = await waitFor('two asks', async () => {
    const found = (await phone.snapshot()).asks.filter((ask) => ask.agentName === 'asker')
    return found.length === 2 ? found : null
  })
  const [first, second] = asks.sort((a, b) => a.text.localeCompare(b.text))
  await phone.command('snooze_ask', { askId: first!.id, snooze: { kind: 'agent_done_or_idle' } })
  await phone.command('snooze_ask', { askId: second!.id, snooze: { kind: 'until', at: Date.now() + 3_600_000 } })
  await assert.rejects(phone.command('snooze_ask', { askId: second!.id, snooze: { kind: 'until', at: Date.now() + 8 * 86_400_000 } }), (error: CommandFailed) => error.code === 'invalid_request')

  run.releaseBarrier('asking')
  await waitFor('the done-or-idle snooze to end', async () => (await phone.snapshot()).asks.find((ask) => ask.id === first!.id)?.snooze === null)
  assert.equal((await phone.snapshot()).asks.find((ask) => ask.id === second!.id)?.snooze?.kind, 'until')

  await phone.command('snooze_ask', { askId: second!.id, snooze: { kind: 'person_back' } })
  // The next read by the person is them being back.
  assert.equal((await phone.snapshot()).asks.find((ask) => ask.id === second!.id)?.snooze, null)

  // Answering just one closes just that one; a plain message closes the rest.
  await phone.command('send_message', { to: 'asker', text: 'yes to the first', attachmentIds: [], wake: 'wake', answersAskId: first!.id })
  assert.deepEqual((await phone.snapshot()).asks.filter((ask) => ask.agentName === 'asker').map((ask) => ask.id), [second!.id])
  await send('asker', 'and the rest')
  assert.equal((await phone.snapshot()).asks.filter((ask) => ask.agentName === 'asker').length, 0)
})

test('urgent asks are capped at three per hour, then downgraded', async () => {
  await readyAgent('alarmist')
  await send('alarmist', standInScript(...Array.from({ length: 4 }, (_, index) => ({ do: 'run', command: `ouro ask human --urgent "alarm ${index}"` }))))
  const asks = await waitFor('four asks', async () => {
    const found = (await phone.snapshot()).asks.filter((ask) => ask.agentName === 'alarmist')
    return found.length === 4 ? found : null
  })
  assert.deepEqual(asks.map((ask) => ask.level).sort(), ['blocked', 'urgent', 'urgent', 'urgent'])
  await send('alarmist', 'calm down')
})

test('a credit failure holds the work, opens one system ask, retries on a backoff, and recovers in order', async () => {
  const agent = await readyAgent('broke')
  await send('broke', `first\n${standInScript({ do: 'fail', failure: 'credits', detail: 'credit balance is too low' })}`)
  await waitFor('the hold', async () => (await phone.agent('broke')).state.state === 'held')
  const held = await phone.agent('broke')
  assert.ok(held.state.state === 'held' && held.state.hold === 'credits')
  const systemAsks = (await phone.snapshot()).asks.filter((ask) => ask.agentId === agent.id && ask.source.kind === 'system')
  assert.equal(systemAsks.length, 1)

  // A second message waits too, and doesn't start anything or open another ask.
  await send('broke', 'second')
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await phone.agent('broke')).state.state, 'held')
  assert.equal((await phone.snapshot()).asks.filter((ask) => ask.agentId === agent.id && ask.source.kind === 'system').length, 1)

  // Five minutes later, by the controlled clock, it retries. The script fails only the first time it is attempted.
  run.advanceClock(5 * 60_000 + 1000)
  await waitFor('the retry to take both messages', async () => (await phone.conversation('broke')).filter((message) => message.from === 'broke').length >= 2)
  const replies = (await phone.conversation('broke')).filter((message) => message.from === 'broke').map((message) => message.text)
  assert.ok(replies.at(-1)?.includes('second'), `replies in order: ${replies.join(' | ')}`)
  await waitFor('the system ask to close', async () => (await phone.snapshot()).asks.filter((ask) => ask.agentId === agent.id && ask.source.kind === 'system').length === 0)
})
