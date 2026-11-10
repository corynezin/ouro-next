// Limits through the real server: a spent budget stops agents after their turn and refuses new ones, raising it lets
// them carry on with nothing lost, and raising the agent limit starts waiting agents at once. Owner only.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AppClient, CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'

const run = new JourneyRun()
let owner: AppClient
before(async () => {
  await run.startServer()
  owner = await run.pairDevice()
})
after(() => run.cleanup())

const spent = async () => (await owner.snapshot()).agents.reduce((total, agent) => total + agent.costUsd, 0)
const send = (to: string, text: string) => owner.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
async function readyAgent(name: string): Promise<void> {
  await owner.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  await waitFor(`${name} to go idle`, async () => (await owner.agent(name)).state.state === 'idle')
}
const holdOf = async (name: string) => { const { state } = await owner.agent(name); return state.state === 'held' ? state.hold : null }

test('a spent budget stops agents after their turn and refuses new ones; raising it lets them carry on', async () => {
  await readyAgent('spender')
  await readyAgent('bystander')
  const { server } = await owner.command('set_limits', { agentLimit: 8, budgetUsd: Math.round(((await spent()) + 0.05) * 1000) / 1000 })
  assert.ok(server.limits.budgetUsd !== null)

  // The turn that spends it finishes; then every agent stops.
  await send('spender', standInScript({ do: 'cost', usd: 0.1 }, { do: 'run', command: 'ouro reply "spent it"' }))
  await waitFor('the turn to finish', async () => (await owner.conversation('spender')).some((message) => message.text === 'spent it'))
  await waitFor('both held for the budget', async () => (await holdOf('spender')) === 'budget' && (await holdOf('bystander')) === 'budget', 15_000)
  await assert.rejects(owner.command('create_agent', { task: 'ready', name: 'newcomer', model: null, folder: null }), (error: CommandFailed) => error.code === 'budget_spent')

  // A message waits instead of starting a turn.
  await send('spender', 'after the budget')
  await new Promise((done) => setTimeout(done, 700))
  assert.equal(await holdOf('spender'), 'budget')
  assert.ok((await owner.snapshot()).asks.some((ask) => ask.agentName === 'spender' && ask.source.kind === 'system' && ask.source.problem === 'budget'))

  await owner.command('set_limits', { agentLimit: 8, budgetUsd: (await spent()) + 10 })
  await waitFor('the waiting message answered', async () => (await owner.conversation('spender')).some((message) => message.text === 'stand-in received: after the budget'), 20_000)
  await waitFor('the bystander to rest, not hold', async () => (await holdOf('bystander')) === null)
  assert.ok(!(await owner.snapshot()).asks.some((ask) => ask.source.kind === 'system' && ask.source.problem === 'budget'), 'the budget asks close')
  await owner.command('set_limits', { agentLimit: 8, budgetUsd: null })
})

test('at the agent limit a message waits for a slot, and raising the limit starts it at once', async () => {
  await readyAgent('slot-holder')
  await readyAgent('slot-waiter')
  const { agent } = await owner.command('stop_agent', { agentId: (await owner.agent('slot-waiter')).id })
  await waitFor('slot-waiter stopped', async () => (await owner.agent('slot-waiter')).state.state === 'stopped')
  const running = (await owner.snapshot()).agents.filter((candidate) => ['idle', 'in_turn', 'starting'].includes(candidate.state.state)).length
  await owner.command('set_limits', { agentLimit: running, budgetUsd: null })
  await assert.rejects(owner.command('create_agent', { task: 'ready', name: 'over-limit', model: null, folder: null }), (error: CommandFailed) => error.code === 'agent_limit_reached')

  await send('slot-waiter', 'waiting for a slot')
  await waitFor('slot-waiter held for a slot', async () => (await holdOf('slot-waiter')) === 'no_slot')
  const raisedAt = Date.now()
  await owner.command('set_limits', { agentLimit: 8, budgetUsd: null })
  await waitFor('its answer', async () => (await owner.conversation('slot-waiter')).some((message) => message.text === 'stand-in received: waiting for a slot'), 20_000)
  assert.ok(Date.now() - raisedAt < 10_000, 'at once, not at the next slot retry')
  assert.equal(agent.name, 'slot-waiter')
})

test('only the owner sets limits', async () => {
  const { code } = await owner.command('start_pairing', { inviteePersonName: 'guest' })
  const paired = await (await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'guest-phone' }) })).json() as { deviceToken: string; deviceId: string }
  const guest = new AppClient(run, paired.deviceToken, paired.deviceId)
  await assert.rejects(guest.command('set_limits', { agentLimit: 2, budgetUsd: 1 }), (error: CommandFailed) => error.code === 'forbidden')
})
