// One Claude plan across the person's computers: computers on the same login tell each other the plan as they read it and
// what their agents cost in its windows, so each shows the newest reading of each window, and each agent's share is its
// part of every agent's cost on that login, not just of its own computer's. Only computers that trust each other fully
// count each other, and only on the same login: a computer whose week resets at another time reads another plan.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const FIVE_HOURS = 300
const WEEK = 10_080

async function agentWithCost(phone: AppClient, name: string, usd: number, windows: { windowMinutes: number; usedFraction: number; resetsAt: number }[]): Promise<void> {
  const report = windows.map((window) => ({ ...window, status: 'allowed' as const }))
  await phone.command('create_agent', { task: `work\n${standInScript({ do: 'cost', usd }, { do: 'plan_usage', windows: report })}`, name, model: 'stand-in', folder: null })
  await waitFor(`${name}'s turn`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 }, 30_000)
}

const shareOf = async (phone: AppClient, name: string) =>
  (await phone.agent(name)).planShare?.map((window) => [window.windowMinutes, Math.round(window.usedFraction * 1000) / 1000])

const now = Date.now()
// Each computer read the plan at its own moment; the same login's windows reset within minutes of each other.
const fiveHourReset = now + 4 * 3_600_000
const weekReset = now + 5 * 86_400_000

test("agents on the same login split the plan's use by their cost on every computer, until a computer is trusted only limitedly", async () => {
  await agentWithCost(alphaPhone, 'thrifty', 1, [{ windowMinutes: FIVE_HOURS, usedFraction: 0.4, resetsAt: fiveHourReset }, { windowMinutes: WEEK, usedFraction: 0.2, resetsAt: weekReset }])
  await agentWithCost(betaPhone, 'busy', 3, [{ windowMinutes: FIVE_HOURS, usedFraction: 0.4, resetsAt: fiveHourReset + 60_000 }, { windowMinutes: WEEK, usedFraction: 0.2, resetsAt: weekReset - 120_000 }])

  await waitFor("alpha counting beta's costs", async () => JSON.stringify(await shareOf(alphaPhone, 'thrifty')) === JSON.stringify([[FIVE_HOURS, 0.1], [WEEK, 0.05]]), 15_000)
  await waitFor("beta counting alpha's costs", async () => JSON.stringify(await shareOf(betaPhone, 'busy')) === JSON.stringify([[FIVE_HOURS, 0.3], [WEEK, 0.15]]), 15_000)

  const alphaIdAtBeta = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'limited' })
  try {
    // Beta stops telling alpha its costs, and stops believing alpha's.
    await waitFor('alpha splitting the plan among its own agents again', async () => JSON.stringify(await shareOf(alphaPhone, 'thrifty')) === JSON.stringify([[FIVE_HOURS, 0.4], [WEEK, 0.2]]), 15_000)
    await waitFor('beta splitting the plan among its own agents again', async () => JSON.stringify(await shareOf(betaPhone, 'busy')) === JSON.stringify([[FIVE_HOURS, 0.4], [WEEK, 0.2]]), 15_000)
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'full' })
  }
})

test('each computer on the login shows each window as whichever of them read it last', async () => {
  // Only beta's agent works now; its report carries the five-hour window alone.
  await agentWithCost(betaPhone, 'reporter', 0, [{ windowMinutes: FIVE_HOURS, usedFraction: 0.6, resetsAt: fiveHourReset + 60_000 }])
  const fiveHourAtAlpha = async () => (await alphaPhone.snapshot()).server.planUsage.claude?.windows.find((window) => window.windowMinutes === FIVE_HOURS)
  await waitFor("alpha showing beta's newer five hours", async () => (await fiveHourAtAlpha())?.usedFraction === 0.6, 15_000)
  const { server } = await alphaPhone.snapshot()
  assert.deepEqual(server.planUsage.claude?.windows, [
    { windowMinutes: FIVE_HOURS, usedFraction: 0.6, resetsAt: fiveHourReset + 60_000 },
    { windowMinutes: WEEK, usedFraction: 0.2, resetsAt: weekReset - 120_000 },
  ], "the week as beta read it last, after alpha's own reading")
  assert.deepEqual(await shareOf(alphaPhone, 'thrifty'), [[FIVE_HOURS, 0.15], [WEEK, 0.05]], 'its part of the newer reading')
})

test("a computer whose week resets at another time is on another login: neither its reading nor its agents' costs count", async () => {
  // Beta's plan now resets its week a day after alpha's: another account, however used.
  await agentWithCost(betaPhone, 'elsewhere', 0, [{ windowMinutes: WEEK, usedFraction: 0.9, resetsAt: weekReset + 86_400_000 }])
  await waitFor('alpha back on its own reading', async () => JSON.stringify(await shareOf(alphaPhone, 'thrifty')) === JSON.stringify([[FIVE_HOURS, 0.4], [WEEK, 0.2]]), 15_000)
  assert.deepEqual((await alphaPhone.snapshot()).server.planUsage.claude?.windows, [
    { windowMinutes: FIVE_HOURS, usedFraction: 0.4, resetsAt: fiveHourReset },
    { windowMinutes: WEEK, usedFraction: 0.2, resetsAt: weekReset },
  ], "alpha's own reading, not beta's newer one")
  // Alpha's $1 isn't added at beta either: busy's $3 is nearly all beta's own cost (its other turns cost next to nothing).
  const nearly = (shares: number[][] | undefined, expected: number[][]) => shares !== undefined && shares.length === expected.length
    && shares.every(([minutes, fraction], index) => minutes === expected[index]![0] && Math.abs(fraction! - expected[index]![1]!) < 0.01)
  await waitFor('beta splitting its plan among its own agents', async () => nearly(await shareOf(betaPhone, 'busy'), [[FIVE_HOURS, 0.6], [WEEK, 0.9]]), 15_000)
})
