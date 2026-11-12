// Models on more than one provider, through the real server and runners with a fake `claude` that records how it was
// launched: Claude models as they are, OpenRouter models pointed at OpenRouter with the key read from its file, a
// fallback (and a word to the agent) when OpenRouter isn't set up, and Claude being signed out holding only Claude's agents.
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const OPENROUTER_KEY = 'sk-or-journey-key-0123456789abcdef'
let run: JourneyRun
let phone: AppClient
let recordPath: string

before(async () => {
  run = new JourneyRun()
  recordPath = join(run.dir, 'claude-launches.jsonl')
  const fakeClaude = join(run.dir, 'claude')
  writeFileSync(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${resolve(import.meta.dirname, 'fake-claude.ts')}" "$@"\n`)
  chmodSync(fakeClaude, 0o755)
  run.addServerEnv({
    OURO_DEFAULT_MODEL: 'sonnet',
    OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_RECORD: recordPath, OURO_CLI_RETRY_MS: '60000' }),
  })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

interface Launch { args: string[]; env: Record<string, string> }
const launches = (): Launch[] => (existsSync(recordPath) ? readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Launch) : [])
const argAfter = (launch: Launch, flag: string) => launch.args[launch.args.indexOf(flag) + 1]

async function startAgent(name: string, model: string): Promise<Launch> {
  const before = launches().length
  await phone.command('create_agent', { task: 'work', name, model, folder: join(run.dir, name) })
  await waitFor(`${name}'s task to be taken`, async () => (await phone.conversation(name)).some((message) => message.deliveries[0]?.state.state === 'completed'))
  const started = launches().slice(before)
  assert.equal(started.length, 1, `one launch for ${name}`)
  return started[0]!
}

const accept = (secret: string) => {
  mkdirSync(run.accountsDir, { recursive: true })
  appendFileSync(join(run.accountsDir, 'accepted'), `${secret}\n`)
}

test('a Claude model runs on Claude as it is', async () => {
  const launch = await startAgent('on-claude', 'sonnet')
  assert.equal(argAfter(launch, '--model'), 'claude-sonnet-5-5')
  assert.deepEqual(launch.env, {}, 'no provider variables')
})

test('an OpenRouter model without OpenRouter set up runs on the fallback, and the agent is told', async () => {
  const models = (await phone.snapshot()).server.models
  assert.equal(models.find((model) => model.id === 'deepseek')?.available, false)
  const launch = await startAgent('wants-deepseek', 'deepseek')
  assert.equal(argAfter(launch, '--model'), 'claude-sonnet-5-5')
  assert.deepEqual(launch.env, {})
  assert.match(argAfter(launch, '--append-system-prompt')!, /set to run on DeepSeek V4 Pro, but OpenRouter isn't set up on this machine, so you are running on Claude Sonnet 5.5 instead/)
})

test('with an OpenRouter key, its models run on OpenRouter, and the key never sits in a runner config', async () => {
  accept(OPENROUTER_KEY)
  const { status } = await phone.integration('POST', 'openrouter/key', { key: OPENROUTER_KEY })
  assert.equal(status, 200)
  await waitFor('deepseek available', async () => (await phone.snapshot()).server.models.find((model) => model.id === 'deepseek')?.available === true)
  const launch = await startAgent('on-deepseek', 'deepseek')
  assert.equal(argAfter(launch, '--model'), 'deepseek/deepseek-v4-pro')
  assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, OPENROUTER_KEY)
  assert.equal(launch.env.ANTHROPIC_API_KEY, '')
  assert.equal(launch.env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek/deepseek-v4-pro')
  assert.doesNotMatch(argAfter(launch, '--append-system-prompt')!, /isn't set up/)

  const agentsDir = join(run.dataDir, 'agents')
  for (const agentId of readdirSync(agentsDir)) {
    for (const file of readdirSync(join(agentsDir, agentId)).filter((name) => name.startsWith('runner-'))) {
      assert.ok(!readFileSync(join(agentsDir, agentId, file), 'utf8').includes(OPENROUTER_KEY), `${file} holds no key`)
    }
  }
  assert.ok(!run.log().includes(OPENROUTER_KEY), 'nor does the log')
})

test("Claude being signed out holds Claude's agents only; an OpenRouter agent carries on", async () => {
  if ((await phone.snapshot()).server.models.find((model) => model.id === 'deepseek')?.available !== true) {
    accept(OPENROUTER_KEY)
    await phone.integration('POST', 'openrouter/key', { key: OPENROUTER_KEY })
  }
  await phone.integration('DELETE', 'claude/api_key')
  await waitFor('Claude signed out', async () => (await phone.snapshot()).integrations.find((integration) => integration.provider === 'claude')?.state.status === 'signed_out')
  await phone.command('create_agent', { task: 'work', name: 'claude-held', model: 'opus', folder: join(run.dir, 'claude-held') })
  await waitFor('the Claude agent held', async () => { const { state } = await phone.agent('claude-held'); return state.state === 'held' && state.hold === 'logged_out' })
  await startAgent('deepseek-free', 'deepseek')
  assert.equal((await phone.snapshot()).server.models.find((model) => model.id === 'opus')?.available, false)
})
