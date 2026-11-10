// Login and usage holds (brief §10): the work waits, the person hears once, nothing retries while the cause lasts, and
// once it clears every waiting message is answered, in the order it was sent. Real server, runners and commands, the
// stand-in model and stand-in accounts, and a controlled clock. Credit holds are proved in m4-goals-asks.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, HoldReason } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const HOUR = 3_600_000
const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const linesIn = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0)

async function readyAgent(name: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  return await waitFor(`${name} to go idle`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 && agent })
}

const isHeld = (name: string, hold: HoldReason) => async () => { const { state } = await phone.agent(name); return state.state === 'held' && state.hold === hold }
const systemAsksOf = async (agentId: string) => (await phone.snapshot()).asks.filter((ask) => ask.agentId === agentId && ask.source.kind === 'system')

/** Every reply after the task's, oldest first. */
async function answersOf(name: string): Promise<string[]> {
  const replies = (await phone.conversation(name)).filter((message) => message.from === name).sort((a, b) => a.seq - b.seq)
  return replies.slice(1).map((message) => message.text)
}

/**
 * Sends the first message, which counts each attempt in `tries.txt` and fails with `failure` the first time, then two
 * more while the agent is held.
 */
async function holdWithThreeWaiting(agent: AgentEntity, failure: object, hold: HoldReason): Promise<string> {
  const tries = join(agent.folder, 'tries.txt')
  await send(agent.name, `first\n${standInScript({ do: 'run', command: 'echo try >> tries.txt' }, failure, { do: 'run', command: 'ouro reply "answer 1"' })}`)
  await waitFor(`${agent.name} held`, isHeld(agent.name, hold), 30_000)
  await send(agent.name, 'second')
  await send(agent.name, 'third')
  return tries
}

async function assertWaitsQuietly(agent: AgentEntity, tries: string, hold: HoldReason, forMs: number): Promise<void> {
  run.advanceClock(forMs)
  await new Promise((done) => setTimeout(done, 1_500)) // many server ticks at the new time
  assert.ok(await isHeld(agent.name, hold)(), `still held for ${hold}`)
  assert.equal(linesIn(tries), 1, 'nothing retried while the cause lasts')
  assert.equal((await phone.agent(agent.name)).queuedDeliveries, 3, 'all three wait')
  const asks = await systemAsksOf(agent.id)
  assert.deepEqual(asks.map((ask) => ask.source.kind === 'system' && ask.source.problem), [hold], 'the person hears once')
}

async function assertRecoversInOrder(agent: AgentEntity, tries: string): Promise<void> {
  await waitFor(`${agent.name}'s three answers`, async () => (await answersOf(agent.name)).length === 3, 30_000)
  assert.deepEqual(await answersOf(agent.name), ['answer 1', 'stand-in received: second', 'stand-in received: third'])
  assert.equal(linesIn(tries), 2, 'one retry, after the cause cleared')
  await waitFor('the ask closed', async () => (await systemAsksOf(agent.id)).length === 0)
}

test('signed out: the work waits through the checks without retrying, and signing in answers it all in order', async () => {
  const agent = await readyAgent('locked-out')
  const tries = await holdWithThreeWaiting(agent, { do: 'fail', failure: 'logged_out', detail: 'Not logged in · Please run /login' }, 'logged_out')

  // The account's own tool agrees it is signed out, so the 10-minute checks find nothing to resume.
  const statePath = join(run.accountsDir, 'state.json')
  mkdirSync(run.accountsDir, { recursive: true })
  const signedOut = { claude: { status: 'signed_out' }, claudeLoginStarted: false, chatgpt: { status: 'signed_out' }, chatgptPendingCode: null, openrouter: { status: 'not_configured' }, github: { status: 'not_connected' } }
  writeFileSync(statePath, JSON.stringify(signedOut))
  await assertWaitsQuietly(agent, tries, 'logged_out', 2 * HOUR)

  await phone.integration('POST', 'claude/login/start')
  appendFileSync(join(run.accountsDir, 'accepted'), 'the-code\n')
  const { status } = await phone.integration('POST', 'claude/login/finish', { code: 'the-code' })
  assert.equal(status, 200)
  await assertRecoversInOrder(agent, tries)
})

test('a usage limit: the work waits until the limit lifts without retrying, then is answered in order', async () => {
  const agent = await readyAgent('limited')
  const tries = await holdWithThreeWaiting(agent, { do: 'fail', failure: 'usage_limit', detail: "You've hit your limit", retryAfterMs: 3 * HOUR }, 'usage_limit')
  await assertWaitsQuietly(agent, tries, 'usage_limit', 2 * HOUR)

  run.advanceClock(HOUR + 60_000)
  await assertRecoversInOrder(agent, tries)
})
