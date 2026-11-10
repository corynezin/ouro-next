// Accepted work that isn't moving reaches the person: an agent that takes its work in and then goes quiet past the stall
// deadline, again and again, is relaunched each time, and on the third stall in a row its creator gets one ask. A finished
// turn closes it. Real server, runners and commands, the stand-in model held at a barrier, and a controlled clock.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const STALL_MS = 60_000
const run = new JourneyRun()
let phone: AppClient
before(async () => {
  run.addServerEnv({ OURO_POLICY_JSON: JSON.stringify({ stallMs: STALL_MS }) })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

/** In its turn on this generation, and past its first output: the silence the stall deadline counts starts there, so
 * the clock mustn't move before it. */
const inTurnOnGeneration = (generation: number) => async (): Promise<AgentEntity | null> => {
  const agent = await phone.agent('quiet')
  return agent.state.state === 'in_turn' && agent.state.generation === generation && agent.state.activity.kind !== 'waiting' ? agent : null
}
const noProgressAsks = async () => (await phone.snapshot()).asks.filter((ask) => ask.agentName === 'quiet' && ask.source.kind === 'system' && ask.source.problem === 'no_progress')

test('the third stall in a row tells the person once, and a finished turn closes it', async () => {
  await phone.command('create_agent', { task: 'ready', name: 'quiet', model: null, folder: null })
  await waitFor('quiet to go idle', async () => (await phone.agent('quiet')).state.state === 'idle')
  await phone.command('send_message', { to: 'quiet', text: standInScript({ do: 'barrier', name: 'silent' }, { do: 'run', command: 'ouro reply "moving again"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  let agent = await waitFor('the work taken in', inTurnOnGeneration(1))
  await waitFor('the barrier', () => run.barrierReached('silent'))

  for (let stall = 1; stall <= 3; stall++) {
    assert.deepEqual(await noProgressAsks(), [], `nothing said before stall ${stall}`)
    run.advanceClock(STALL_MS + 1_000)
    const generation = agent.state.state === 'in_turn' ? agent.state.generation + 1 : -1
    agent = await waitFor(`the relaunch after stall ${stall}`, inTurnOnGeneration(generation), 30_000)
  }

  const asks = await waitFor('the ask', async () => { const found = await noProgressAsks(); return found.length > 0 && found })
  assert.equal(asks.length, 1)
  assert.equal(asks[0]!.to, 'human')
  assert.match(asks[0]!.text, /stalled 3 times in a row/)

  run.advanceClock(STALL_MS + 1_000)
  const generation = agent.state.state === 'in_turn' ? agent.state.generation + 1 : -1
  agent = await waitFor('the relaunch after stall 4', inTurnOnGeneration(generation), 30_000)
  assert.equal((await noProgressAsks()).length, 1, 'told once, not at every stall')

  run.releaseBarrier('silent')
  await waitFor('the reply', async () => (await phone.conversation('quiet')).some((message) => message.text === 'moving again'))
  await waitFor('the ask closed', async () => (await noProgressAsks()).length === 0)
})
