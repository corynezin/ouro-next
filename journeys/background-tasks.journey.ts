// An agent that ends its turn while a background task it started still runs, through the real server and runners: it
// stays up past the idle exit while the task runs (up to a cap), and the turn the task's end wakes it for is a turn, so
// a done inside it waits for that turn's end.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
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
const BACKGROUND_TASKS_CAP_MS = 120 * MINUTE
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const stateOf = async (name: string) => (await phone.agent(name)).state

test('a running background task holds off the idle exit; its end wakes the agent, and a done there waits for the turn', async () => {
  await phone.command('create_agent', {
    task: standInScript(
      { do: 'background', name: 'ci', then: [{ do: 'text', text: 'CI passed' }, { do: 'run', command: 'ouro done "CI is green"' }] },
      { do: 'text', text: "I'll wait for its notification" },
    ),
    name: 'watcher', model: null, folder: null,
  })
  await waitFor('watcher to wait idle on its background task', async () => run.barrierReached('ci') && (await stateOf('watcher')).state === 'idle')

  run.advanceClock(IDLE_EXIT_MS + MINUTE)
  await pause(1500)
  assert.equal((await stateOf('watcher')).state, 'idle', 'still up while its background task runs')

  run.releaseBarrier('ci')
  const done = await waitFor('watcher to finish', async () => {
    const state = await stateOf('watcher')
    return state.state === 'done' ? state : null
  })
  assert.equal(done.state === 'done' && done.summary, 'CI is green')
  const why = await run.cli('why', 'watcher')
  assert.match(why, /idle -> in_turn .*turn began on its own/)
  assert.match(why, /in_turn -> stopping .*turn finished, applying what was waiting for it/)
  assert.doesNotMatch(why, /idle -> stopping/)
})

test('a background task that never ends keeps the agent up only until the cap', async () => {
  await phone.command('create_agent', { task: standInScript({ do: 'background', name: 'hung', then: [] }, { do: 'text', text: 'waiting' }), name: 'hanger', model: null, folder: null })
  await waitFor('hanger to wait idle on its background task', async () => run.barrierReached('hung') && (await stateOf('hanger')).state === 'idle')

  run.advanceClock(IDLE_EXIT_MS + MINUTE)
  await pause(1500)
  assert.equal((await stateOf('hanger')).state, 'idle')

  run.advanceClock(BACKGROUND_TASKS_CAP_MS)
  const stopped = await waitFor('hanger to exit idle at the cap', async () => {
    const state = await stateOf('hanger')
    return state.state === 'stopped' ? state : null
  })
  assert.deepEqual(stopped.state === 'stopped' && stopped.stopped, { reason: 'idle' })
})
