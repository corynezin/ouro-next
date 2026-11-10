// Plan usage through the real server, runners and commands, with the stand-in model and a controlled clock: the plan's
// windows as turns report them, each agent's share by cost, goal cycles held near the limit, and a usage-limit hold that
// lifts when the window resets.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, GoalEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

// The server reads its clock through the run's offset; the journey keeps the same offset to name times the server sees.
let clockOffsetMs = 0
const advance = (byMs: number) => { clockOffsetMs += byMs; run.advanceClock(byMs) }
const serverNow = () => Date.now() + clockOffsetMs

const FIVE_HOURS = 300
const WEEK = 10_080

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })

async function readyAgent(name: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle' && (await phone.agent(name)).queuedDeliveries === 0)
  return await phone.agent(name)
}

async function turnDone(name: string, text: string): Promise<void> {
  await send(name, text)
  await waitFor(`${name}'s turn`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 })
}

async function goalOf(agentId: string): Promise<GoalEntity | undefined> {
  return (await phone.snapshot()).goals.find((goal) => goal.agentId === agentId)
}

const linesIn = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0)

test("a turn's report sets the plan's windows, and each agent's share follows its cost", async () => {
  await readyAgent('heavy')
  await readyAgent('light')
  const fiveHourReset = serverNow() + 4 * 3_600_000
  const weekReset = serverNow() + 5 * 86_400_000
  await turnDone('heavy', `work\n${standInScript({ do: 'cost', usd: 3 }, { do: 'plan_usage', windows: [{ windowMinutes: FIVE_HOURS, usedFraction: 0.2, resetsAt: fiveHourReset, status: 'allowed' }] })}`)
  // A later report carrying only the weekly window keeps the five-hour one.
  await turnDone('light', `work\n${standInScript({ do: 'cost', usd: 1 }, { do: 'plan_usage', windows: [{ windowMinutes: WEEK, usedFraction: 0.1, resetsAt: weekReset, status: 'allowed' }] })}`)

  const { server } = await phone.snapshot()
  assert.deepEqual(server.planUsage.claude?.windows, [
    { windowMinutes: FIVE_HOURS, usedFraction: 0.2, resetsAt: fiveHourReset },
    { windowMinutes: WEEK, usedFraction: 0.1, resetsAt: weekReset },
  ])
  assert.equal(server.planUsage.chatgpt, null)

  const shareOf = async (name: string) => (await phone.agent(name)).planShare?.map((window) => [window.windowMinutes, Math.round(window.usedFraction * 1000) / 1000])
  assert.deepEqual(await shareOf('heavy'), [[FIVE_HOURS, 0.15], [WEEK, 0.075]])
  assert.deepEqual(await shareOf('light'), [[FIVE_HOURS, 0.05], [WEEK, 0.025]])
})

test('goal cycles wait while the five-hour window is past half, and run again once it resets', async () => {
  const agent = await readyAgent('goal-keeper')
  const resetsAt = serverNow() + 3_600_000
  await turnDone('goal-keeper', `report\n${standInScript({ do: 'plan_usage', windows: [{ windowMinutes: FIVE_HOURS, usedFraction: 0.6, resetsAt, status: 'allowed' }] })}`)
  const counter = join(agent.folder, 'cycles.txt')
  await phone.command('set_goal', { agentId: agent.id, text: `count\n${standInScript({ do: 'run', command: 'echo cycle >> cycles.txt' })}`, kind: { kind: 'finishing' }, intervalSeconds: 60 })

  await waitFor('the goal to wait for the plan', async () => {
    const status = (await goalOf(agent.id))?.status
    return status?.status === 'active' && status.waitingFor?.kind === 'plan_usage'
  })
  const status = (await goalOf(agent.id))!.status
  assert.ok(status.status === 'active')
  assert.deepEqual(status.waitingFor, { kind: 'plan_usage', windowMinutes: FIVE_HOURS, usedFraction: 0.6, resetsAt })
  assert.equal(status.nextCycleAt, resetsAt)

  advance(120_000)
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(linesIn(counter), 0, 'no cycle while the window is held')

  advance(resetsAt - serverNow() + 1_000)
  await waitFor('a cycle after the reset', () => linesIn(counter) >= 1)
  await phone.command('mark_goal_done', { agentId: agent.id, summary: 'done' })
})

test('a usage-limit refusal holds the agent until the refusing window resets, then retries', async () => {
  const agent = await readyAgent('refused')
  const tries = join(agent.folder, 'tries.txt')
  const resetsAt = serverNow() + 2 * 3_600_000
  await send('refused', `try\n${standInScript(
    { do: 'run', command: 'echo try >> tries.txt' },
    { do: 'plan_usage', windows: [{ windowMinutes: FIVE_HOURS, usedFraction: 1, resetsAt, status: 'rejected' }] },
    { do: 'fail', failure: 'usage_limit', detail: "You've hit your limit" },
  )}`)
  await waitFor('the agent held for usage', async () => { const { state } = await phone.agent('refused'); return state.state === 'held' && state.hold === 'usage_limit' })
  const { state } = await phone.agent('refused')
  assert.ok(state.state === 'held')
  assert.equal(state.retryAt, resetsAt)
  assert.equal(linesIn(tries), 1)

  advance(resetsAt - serverNow() + 1_000)
  await waitFor('the retry after the reset', () => linesIn(tries) === 2)
})
