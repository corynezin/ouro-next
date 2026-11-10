// Summaries and live lines through the real server and runners, with the stand-in summarizer and a controlled clock.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AgentEntity, SummaryEntity } from '@ouro/contract'
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

async function summaryOf(agentId: string): Promise<SummaryEntity | undefined> {
  return (await phone.snapshot()).summaries.find((summary) => summary.agentId === agentId)
}

/** Its first turn (the stand-in replies with a tool) gets summary 1; then the clock moves past the interval. */
async function readyAgent(name: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: null })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle')
  const agent = await phone.agent(name)
  await waitFor(`${name}'s first summary`, async () => (await summaryOf(agent.id))?.latest?.number === 1)
  run.advanceClock(6 * MINUTE)
  return agent
}

/** Work, then an answer to the person: a turn that left them unanswered would be followed by a reply reminder's turn. */
const workThenReply = (command: string) => standInScript({ do: 'run', command }, { do: 'run', command: 'ouro reply "on it"' })

async function idleAfter(name: string, text: string): Promise<void> {
  await send(name, text)
  await waitFor(`${name} to finish`, async () => {
    const agent = await phone.agent(name)
    return agent.state.state === 'idle' && agent.queuedDeliveries === 0
  })
}

test('a turn with work gets a summary; the next waits out the interval; older ones page by number', async () => {
  const agent = await readyAgent('worker')
  await idleAfter('worker', workThenReply('echo building > build.txt'))
  const first = await waitFor('the summary of the work', async () => {
    const latest = (await summaryOf(agent.id))?.latest
    return latest?.number === 2 ? latest : null
  })
  assert.match(first.line, /^stand-in: Bash: echo building/)
  assert.ok(first.details.some((detail) => detail.includes('echo building')), first.details.join(' | '))

  // More work right away: it waits, since one came less than five minutes ago.
  await idleAfter('worker', workThenReply('echo testing > test.txt'))
  await pause(500)
  assert.equal((await summaryOf(agent.id))?.latest?.number, 2)

  // Once the interval has passed, the waiting activity gets its summary without any new turn.
  run.advanceClock(6 * MINUTE)
  const second = await waitFor('the second summary', async () => {
    const latest = (await summaryOf(agent.id))?.latest
    return latest?.number === 3 ? latest : null
  })
  assert.ok(second.details.some((detail) => detail.includes('echo testing')), second.details.join(' | '))
  assert.ok(!second.details.some((detail) => detail.includes('echo building')), 'it covers only what came after the first')
  assert.ok(second.coversThroughAt >= first.coversThroughAt)

  const newest = await phone.summaries(agent.id, undefined, 1)
  assert.deepEqual(newest.summaries.map((summary) => summary.number), [3])
  assert.equal(newest.hasOlder, true)
  const older = await phone.summaries(agent.id, 3, 1)
  assert.deepEqual(older.summaries.map((summary) => summary.number), [2])
  assert.equal(older.hasOlder, true)
  const oldest = await phone.summaries(agent.id, 2, 5)
  assert.deepEqual(oldest.summaries.map((summary) => summary.number), [1])
  assert.equal(oldest.hasOlder, false)
})

test('done always gets a final summary, and summarizing never wakes the agent', async () => {
  const agent = await readyAgent('finisher')
  await idleAfter('finisher', workThenReply('echo first > a.txt'))
  await waitFor('a summary of the work', async () => (await summaryOf(agent.id))?.latest?.number === 2)

  await send('finisher', standInScript({ do: 'run', command: 'echo last > b.txt' }, { do: 'run', command: 'ouro done "all finished"' }))
  await waitFor('done', async () => (await phone.agent('finisher')).state.state === 'done')
  const final = await waitFor('the final summary, within the interval', async () => {
    const latest = (await summaryOf(agent.id))?.latest
    return latest?.number === 3 ? latest : null
  })
  assert.ok(final.details.some((detail) => detail.includes('ouro done')), final.details.join(' | '))

  run.advanceClock(11 * MINUTE)
  await pause(800)
  assert.equal((await phone.agent('finisher')).state.state, 'done', 'still done: summaries never wake it')
  assert.equal((await summaryOf(agent.id))?.latest?.number, 3)
})

test('a failed summary is shown, backs off, and leaves the agent alone', async () => {
  const agent = await readyAgent('unlucky')
  await idleAfter('unlucky', workThenReply('echo "standin-summary: fail"'))
  const failed = await waitFor('the failure', async () => (await summaryOf(agent.id))?.lastFailure).catch(async (error: Error) => { throw new Error(`${error.message}: ${JSON.stringify((await phone.snapshot()).summaries)}`) })
  assert.match(failed.message, /told to fail/)
  assert.equal((await summaryOf(agent.id))?.latest?.number, 1)
  assert.equal((await phone.agent('unlucky')).state.state, 'idle')

  // The first retry waits ten minutes (twice the interval), not one tick.
  run.advanceClock(6 * MINUTE)
  await pause(500)
  assert.equal((await summaryOf(agent.id))?.lastFailure?.at, failed.at)
  run.advanceClock(5 * MINUTE)
  await waitFor('a retry', async () => ((await summaryOf(agent.id))?.lastFailure?.at ?? 0) > failed.at)
})

test('live lines come while someone is watching, and stop when the lease lapses', async () => {
  const agent = await readyAgent('watched')
  // Starting to look with nothing new since the summary says nothing, and doesn't hold back the next line.
  await phone.command('watch_agent', { agentId: agent.id })
  await idleAfter('watched', workThenReply('echo live one'))
  const live = await waitFor('a live line', async () => (await summaryOf(agent.id))?.live)
  assert.match(live.line, /echo live one/)

  // Within five seconds of the last one, new work waits; after, it gets a fresh line.
  run.advanceClock(6_000)
  await phone.command('watch_agent', { agentId: agent.id })
  await idleAfter('watched', workThenReply('echo live two'))
  await waitFor('a fresh live line', async () => (await summaryOf(agent.id))?.live?.line.includes('live two'))

  // Nobody renews: after the lease, work goes on without live lines.
  run.advanceClock(46_000)
  await idleAfter('watched', workThenReply('echo unwatched'))
  await pause(800)
  assert.match((await summaryOf(agent.id))!.live!.line, /live two/)
})
