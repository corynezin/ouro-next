// A real model through the real system: a turn end to end, a kill, and a resume that keeps the conversation. Paid and
// opt-in: `OURO_LIVE=1 npm run test:live`. It reads this machine's Claude login and never changes it. Bounded by the
// model (the cheapest), two short turns, the deadlines below and a cost ceiling. It checks effects, not wording.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../harness.ts'
import { LIVE_COST_CEILING_USD, LIVE_HOME, liveSkip } from './live-gate.ts'

const TURN_DEADLINE_MS = 150_000

const run = new JourneyRun({ env: {
  OURO_DEFAULT_MODEL: 'haiku',
  // The real login is the one thing shared with the machine; everything else stays in the run's directory.
  OURO_AGENT_ENV_JSON: JSON.stringify({ HOME: LIVE_HOME, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
} })
after(() => run.cleanup())

test('Claude replies through the real command, is killed, and resumes with its context', { skip: liveSkip({ needsClaudeLogin: true }) }, async () => {
  await run.startServer()
  const phone = await run.pairDevice()
  const { agent } = await phone.command('create_agent', {
    task: 'Run exactly this shell command and nothing else, then end your turn: ouro reply "the word is heron"',
    name: 'live',
    model: 'haiku',
    folder: null,
  })
  await waitFor('the reply', async () => (await phone.conversation('live')).some((message) => message.from === 'live' && message.text.includes('heron')), TURN_DEADLINE_MS)
  await waitFor('the turn to end', async () => (await phone.agent('live')).state.state === 'idle', TURN_DEADLINE_MS)

  const taskDelivery = (await phone.conversation('live'))[0]?.deliveries[0]
  assert.equal(taskDelivery?.state.state, 'completed', 'the provider acknowledged the task message')
  const costAfterFirstTurn = (await phone.agent('live')).costUsd
  console.log(`cost after one turn: $${costAfterFirstTurn}`)
  assert.ok(costAfterFirstTurn <= LIVE_COST_CEILING_USD, `spent $${costAfterFirstTurn}, over the $${LIVE_COST_CEILING_USD} ceiling`)

  const firstPid = await run.runnerPid(agent.id, 1)
  assert.ok(firstPid)
  process.kill(-firstPid, 'SIGKILL')
  await waitFor('the crash to be noticed', async () => (await phone.agent('live')).state.state === 'stopped')

  await phone.command('send_message', {
    to: 'live',
    text: 'What word did your first reply say the word was? Answer with: ouro reply "<that word> again"',
    attachmentIds: [],
    wake: 'wake',
    answersAskId: null,
  })
  await waitFor('the reply from memory', async () => (await phone.conversation('live')).some((message) => message.from === 'live' && /heron again/i.test(message.text)), TURN_DEADLINE_MS)
  assert.equal((await phone.agent('live')).state.state === 'stopped', false)
  const cost = (await phone.agent('live')).costUsd
  console.log(`cost after both turns: $${cost}`)
  assert.ok(cost <= LIVE_COST_CEILING_USD, `spent $${cost}, over the $${LIVE_COST_CEILING_USD} ceiling`)
})
