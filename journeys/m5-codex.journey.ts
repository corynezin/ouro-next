// Agents on OpenAI models through the real server and runners, with a fake `codex app-server`: ChatGPT's models are
// offered once it is signed in, an agent on one waits for that sign-in and then runs in Codex, Codex finding itself
// signed out holds only Codex's agents, and moving an agent between Claude and Codex starts a new conversation.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { ChatgptLoginStart } from '@ouro/contract'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let run: JourneyRun
let phone: AppClient
let recordPath: string
let unauthorizedPath: string

before(async () => {
  run = new JourneyRun()
  recordPath = join(run.dir, 'codex-threads.jsonl')
  unauthorizedPath = join(run.dir, 'codex-unauthorized')
  const fakeCodex = join(run.dir, 'codex')
  writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${resolve(import.meta.dirname, 'fake-codex.ts')}" "$@"\n`)
  chmodSync(fakeCodex, 0o755)
  run.addServerEnv({
    OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_CODEX_BIN: fakeCodex, FAKE_CODEX_RECORD: recordPath, FAKE_CODEX_UNAUTHORIZED: unauthorizedPath, OURO_CLI_RETRY_MS: '60000' }),
  })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

interface ThreadOpening { method: 'thread/start' | 'thread/resume'; params: { model: string; threadId?: string; cwd: string }; cwd: string }
const openings = (): ThreadOpening[] => (existsSync(recordPath) ? readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ThreadOpening) : [])
const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const taken = (name: string, text: string) => waitFor(`${name} to take "${text}"`, async () => (await phone.conversation(name)).some((message) => message.text === text && message.deliveries[0]?.state.state === 'completed'), 30_000)
const isHeldSignedOut = async (name: string) => { const { state } = await phone.agent(name); return state.state === 'held' && state.hold === 'logged_out' }
const modelOffer = async (id: string) => (await phone.snapshot()).server.models.find((model) => model.id === id)
const chatgptStatus = async () => (await phone.snapshot()).integrations.find((integration) => integration.provider === 'chatgpt')?.state.status

async function signInToChatgpt(): Promise<void> {
  const started = ChatgptLoginStart.parse((await phone.integration('POST', 'chatgpt/login/start')).body)
  writeFileSync(join(run.accountsDir, 'chatgpt-entered'), started.code)
  await waitFor('ChatGPT signed in', async () => (await chatgptStatus()) === 'signed_in', 20_000)
}

test("an agent on a ChatGPT model waits for ChatGPT's sign-in, then runs in Codex", async () => {
  assert.equal(await modelOffer('gpt-6-luna'), undefined, "signed out, ChatGPT's models aren't known")
  await phone.command('create_agent', { task: 'codex work', name: 'on-codex', model: 'gpt-6-luna', folder: join(run.dir, 'on-codex') })
  await waitFor('the agent held', () => isHeldSignedOut('on-codex'), 10_000)
  const ask = (await phone.snapshot()).asks.find((candidate) => candidate.agentName === 'on-codex' && candidate.source.kind === 'system')
  assert.match(ask?.text ?? '', /ChatGPT is signed out/)

  await signInToChatgpt()
  assert.deepEqual(await modelOffer('gpt-6-luna'), { id: 'gpt-6-luna', label: 'gpt-6-luna', provider: 'openai', available: true })
  await taken('on-codex', 'codex work')
  const opening = openings().at(-1)!
  assert.equal(opening.method, 'thread/start')
  assert.equal(opening.params.model, 'gpt-6-luna')
  assert.equal(opening.cwd, join(run.dir, 'on-codex'))
  assert.equal((await phone.snapshot()).asks.filter((candidate) => candidate.agentName === 'on-codex').length, 0, 'the ask closes')
})

test("Codex finding itself signed out holds Codex's agents only", async () => {
  if ((await chatgptStatus()) !== 'signed_in') await signInToChatgpt()
  await phone.command('create_agent', { task: 'codex work', name: 'codex-two', model: 'gpt-6.1-sol', folder: join(run.dir, 'codex-two') })
  await taken('codex-two', 'codex work')
  await phone.command('create_agent', { task: 'claude work', name: 'on-stand-in', model: 'stand-in', folder: join(run.dir, 'on-stand-in') })
  await taken('on-stand-in', 'claude work')

  writeFileSync(unauthorizedPath, '')
  try {
    await send('codex-two', 'are you there?')
    await waitFor('the hold on the agent that found out', () => isHeldSignedOut('codex-two'), 30_000)
    assert.equal(await chatgptStatus(), 'signed_out', "Codex's own word counts as signed out")
    assert.equal(await modelOffer('gpt-6.1-sol'), undefined, 'nor are its models offered')
    await send('on-stand-in', 'still here?')
    await taken('on-stand-in', 'still here?')
    assert.equal((await phone.agent('on-stand-in')).state.state === 'held', false)
  } finally {
    rmSync(unauthorizedPath, { force: true })
  }
  await signInToChatgpt()
  await taken('codex-two', 'are you there?')
})

test('moving an agent from Claude to Codex starts a new conversation there; staying in Codex resumes it', async () => {
  if ((await chatgptStatus()) !== 'signed_in') await signInToChatgpt()
  await phone.command('create_agent', { task: 'first', name: 'switcher', model: 'stand-in', folder: join(run.dir, 'switcher') })
  await taken('switcher', 'first')
  const { id } = await phone.agent('switcher')
  await phone.command('set_agent_model', { agentId: id, model: 'gpt-6-luna' })
  await phone.command('stop_agent', { agentId: id })
  await waitFor('switcher stopped', async () => (await phone.agent('switcher')).state.state === 'stopped')
  const before = openings().length
  await send('switcher', 'second')
  await taken('switcher', 'second')
  const [opening] = openings().slice(before)
  assert.equal(opening?.method, 'thread/start', "the stand-in's conversation isn't Codex's to resume")

  await phone.command('stop_agent', { agentId: id })
  await waitFor('switcher stopped again', async () => (await phone.agent('switcher')).state.state === 'stopped')
  await send('switcher', 'third')
  await taken('switcher', 'third')
  const resumed = openings().at(-1)!
  assert.equal(resumed.method, 'thread/resume')
  assert.match(resumed.params.threadId ?? '', /^thread-\d+$/, 'the thread Codex started')
})
