// A real hold: real Claude Code, with a config folder of its own that holds no login, says it isn't logged in, and the
// server holds the agent for it with one ask. Opt-in with the rest of the live tier (`OURO_LIVE=1 npm run test:live`),
// though it reaches no model and costs nothing. The machine's own Claude login is neither read nor touched: the agent's
// home and config folder are the run's own.
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../harness.ts'
import { liveSkip } from './live-gate.ts'

const HOLD_DEADLINE_MS = 90_000

const run = new JourneyRun({ env: { OURO_DEFAULT_MODEL: 'haiku' } })
const emptyClaudeConfig = join(run.dir, 'empty-claude-config')
run.addServerEnv({ OURO_AGENT_ENV_JSON: JSON.stringify({ CLAUDE_CONFIG_DIR: emptyClaudeConfig, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }) })
after(() => run.cleanup())

test('real Claude Code without a login holds its agent as logged out, with one ask, and nothing reaches a model', { skip: liveSkip({ needsClaudeLogin: false }) }, async () => {
  mkdirSync(emptyClaudeConfig, { recursive: true })
  assert.deepEqual(readdirSync(emptyClaudeConfig), [], 'the config folder starts empty')
  await run.startServer()
  const phone = await run.pairDevice()
  const { agent } = await phone.command('create_agent', { task: 'Reply with: ouro reply "should not happen"', name: 'signed-out', model: 'haiku', folder: null })

  const held = await waitFor('the hold', async () => {
    const { state } = await phone.agent('signed-out')
    return state.state === 'held' ? state : null
  }, HOLD_DEADLINE_MS)
  assert.equal(held.hold, 'logged_out', `held for ${held.hold}`)
  const asks = (await phone.snapshot()).asks.filter((ask) => ask.agentId === agent.id && ask.source.kind === 'system')
  assert.deepEqual(asks.map((ask) => ask.source.kind === 'system' && ask.source.problem), ['logged_out'])
  assert.equal((await phone.snapshot()).integrations.find((integration) => integration.provider === 'claude')?.state.status, 'signed_out', "Claude Code's own word counts as signed out")
  assert.ok(!(await phone.conversation('signed-out')).some((message) => message.from === 'signed-out'), 'no reply: nothing reached a model')
  const task = (await phone.conversation('signed-out'))[0]?.deliveries[0]
  assert.equal(task?.state.state, 'queued', 'the task waits for a login')
})
