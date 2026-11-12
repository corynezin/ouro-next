// Accounts through the real server and routes, against the stand-in accounts: what each says, signing in and out, keys
// and tokens refused or taken, a ChatGPT device sign-in that completes by itself, and a Claude sign-in releasing agents
// held because Claude was signed out.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AwsActionResult, AwsIntegrationState, ChatgptLoginStart, ClaudeLoginStart, IntegrationActionResult, SpritesActionResult, SpritesIntegrationState } from '@ouro/contract'
import type { IntegrationEntity, IntegrationProvider } from '@ouro/contract'
import { AppClient as Client, JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

/** Shaped like an AWS secret, so the server's format check lets it through to the stand-in. */
const AWS_SECRET = 'awsSecretTakenK7MDENGbPxRfiCYEXAMPLEKEY'

const accept = (secret: string) => {
  mkdirSync(run.accountsDir, { recursive: true })
  appendFileSync(join(run.accountsDir, 'accepted'), `${secret}\n`)
}
const integrationOf = async (provider: IntegrationProvider): Promise<IntegrationEntity | undefined> => (await phone.snapshot()).integrations.find((integration) => integration.provider === provider)
async function act(method: 'POST' | 'DELETE', action: string, body?: object): Promise<IntegrationActionResult> {
  const { status, body: answer } = await phone.integration(method, action, body)
  assert.equal(status, 200, JSON.stringify(answer))
  return IntegrationActionResult.parse(answer)
}

test('every account is checked when the server starts and synced like any entity', async () => {
  const integrations = await waitFor('all four accounts', async () => (await phone.snapshot()).integrations.length === 4 && (await phone.snapshot()).integrations)
  assert.deepEqual(Object.fromEntries(integrations.map((integration) => [integration.provider, integration.state])), {
    claude: { status: 'signed_in', account: { method: 'plan', email: 'person@stand-in.invalid' } },
    chatgpt: { status: 'signed_out' },
    github: { status: 'not_connected' },
    openrouter: { status: 'not_configured' },
  })
})

test('Claude: a sign-in code is refused or taken, and an API key replaces it until cleared', async () => {
  const notStarted = await act('POST', 'claude/login/finish', { code: 'too-early' })
  assert.deepEqual(notStarted, { accepted: false, why: 'no sign-in in progress: start it first' })
  const started = ClaudeLoginStart.parse((await phone.integration('POST', 'claude/login/start')).body)
  assert.match(started.url, /^https:\/\//)
  assert.equal((await act('POST', 'claude/login/finish', { code: 'wrong-code' })).accepted, false)
  accept('right-code')
  const signedIn = await act('POST', 'claude/login/finish', { code: 'right-code' })
  assert.ok(signedIn.accepted)
  assert.deepEqual(signedIn.integration.state, { status: 'signed_in', account: { method: 'plan', email: 'person@stand-in.invalid' } })
  assert.deepEqual((await integrationOf('claude'))?.state, signedIn.integration.state, 'and every device sees it')

  assert.equal((await act('POST', 'claude/api_key', { key: 'sk-ant-not-accepted' })).accepted, false)
  accept('sk-ant-accepted')
  const keyed = await act('POST', 'claude/api_key', { key: 'sk-ant-accepted' })
  assert.ok(keyed.accepted && keyed.integration.provider === 'claude')
  assert.deepEqual(keyed.integration.state, { status: 'signed_in', account: { method: 'api_key' } })
  const cleared = await act('DELETE', 'claude/api_key')
  assert.ok(cleared.accepted)
  assert.deepEqual(cleared.integration.state, { status: 'signed_out' })
})

test("signed out holds every agent on Claude, and signing in resumes them all with nothing lost", async () => {
  await phone.integration('POST', 'claude/login/start')
  accept('first-code')
  assert.ok((await act('POST', 'claude/login/finish', { code: 'first-code' })).accepted, 'it starts signed in')
  await phone.command('create_agent', { task: 'ready', name: 'finds-out', model: null, folder: join(run.dir, 'finds-out') })
  await waitFor('finds-out to go idle', async () => (await phone.agent('finds-out')).state.state === 'idle')
  await phone.command('send_message', { to: 'finds-out', text: standInScript({ do: 'fail', failure: 'logged_out', detail: 'Not logged in · Please run /login' }, { do: 'run', command: 'ouro reply "carried on"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const isHeld = async (name: string) => { const { state } = await phone.agent(name); return state.state === 'held' && state.hold === 'logged_out' }
  await waitFor('the hold on the agent that found out', () => isHeld('finds-out'), 30_000)
  assert.equal((await integrationOf('claude'))?.state.status, 'signed_out', "the provider's own word counts as signed out")

  // Another agent doesn't start only to fail: it is held as it is created.
  await phone.command('create_agent', { task: 'ready', name: 'never-tried', model: null, folder: join(run.dir, 'never-tried') })
  await waitFor('the hold on the new agent', () => isHeld('never-tried'), 10_000)
  const loggedOutAsks = (await phone.snapshot()).asks.filter((ask) => ask.source.kind === 'system' && ask.source.problem === 'logged_out')
  assert.deepEqual(loggedOutAsks.map((ask) => ask.agentName).sort(), ['finds-out', 'never-tried'], 'one ask per agent, as for every system problem')
  assert.match(loggedOutAsks[0]!.text, /Claude is signed out/)

  await phone.integration('POST', 'claude/login/start')
  accept('second-code')
  assert.ok((await act('POST', 'claude/login/finish', { code: 'second-code' })).accepted)
  await waitFor('the reply after signing in', async () => (await phone.conversation('finds-out')).some((message) => message.text === 'carried on'), 30_000)
  await waitFor('the new agent to start', async () => (await phone.conversation('never-tried')).some((message) => message.text === 'stand-in received: ready'), 30_000)
  assert.equal((await phone.snapshot()).asks.filter((ask) => ask.source.kind === 'system' && ask.source.problem === 'logged_out').length, 0, 'and the ask closes')
})

test('ChatGPT: a device sign-in completes by itself once its code is entered; its plan usage read on request; sign out', async () => {
  const started = ChatgptLoginStart.parse((await phone.integration('POST', 'chatgpt/login/start')).body)
  assert.ok(started.code.length > 0 && started.expiresAt > Date.now())
  writeFileSync(join(run.accountsDir, 'chatgpt-entered'), started.code)
  await waitFor('ChatGPT signed in', async () => (await integrationOf('chatgpt'))?.state.status === 'signed_in', 20_000)
  assert.deepEqual((await integrationOf('chatgpt'))?.state, { status: 'signed_in', email: 'person@stand-in.invalid', plan: 'plus', models: ['gpt-6-luna', 'gpt-6.1-sol'] })
  writeFileSync(join(run.accountsDir, 'chatgpt-usage.json'), JSON.stringify([{ windowMinutes: 300, usedFraction: 0.12, resetsAt: null, status: null }]))
  const { server } = await phone.command('refresh_plan_usage', { provider: 'chatgpt' })
  assert.deepEqual(server.planUsage.chatgpt?.windows, [{ windowMinutes: 300, usedFraction: 0.12, resetsAt: null }])
  const out = await act('POST', 'chatgpt/sign_out')
  assert.ok(out.accepted)
  assert.deepEqual(out.integration.state, { status: 'signed_out' })
})

test('OpenRouter keys and GitHub tokens: refused, taken and removed; bad requests and unknown actions are refused', async () => {
  assert.equal((await act('POST', 'openrouter/key', { key: 'sk-or-refused' })).accepted, false)
  accept('sk-or-taken')
  const configured = await act('POST', 'openrouter/key', { key: 'sk-or-taken' })
  assert.ok(configured.accepted)
  assert.deepEqual(configured.integration.state, { status: 'configured', spentUsd: 0, availableUsd: 10 })
  // Spent elsewhere since: refreshing asks OpenRouter now, and the answer arrives with the integration.
  writeFileSync(join(run.accountsDir, 'openrouter-credits.json'), JSON.stringify({ spentUsd: 2.5, availableUsd: 7.5 }))
  await phone.command('refresh_plan_usage', { provider: 'openrouter' })
  assert.deepEqual((await integrationOf('openrouter'))?.state, { status: 'configured', spentUsd: 2.5, availableUsd: 7.5 })
  const removed = await act('DELETE', 'openrouter/key')
  assert.ok(removed.accepted)
  assert.deepEqual(removed.integration.state, { status: 'not_configured' })

  accept('ghp_taken')
  const connected = await act('POST', 'github/token', { token: 'ghp_taken' })
  assert.ok(connected.accepted)
  assert.deepEqual(connected.integration.state, { status: 'connected', user: 'stand-in', scopes: ['repo'] })
  assert.deepEqual((await act('POST', 'github/disconnect')).accepted, true)
  assert.equal((await integrationOf('github'))?.state.status, 'not_connected')

  // AWS has its own routes, not an entity: an app from before it would refuse a snapshot holding it.
  const awsOf = async (method: 'GET' | 'POST', action: string, body?: object) => {
    const { status, body: answer } = await phone.integration(method, action, body)
    assert.equal(status, 200, JSON.stringify(answer))
    return answer
  }
  assert.deepEqual(AwsIntegrationState.parse(await awsOf('GET', 'aws')), { status: 'not_connected' })
  const awsKey = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: AWS_SECRET, region: 'us-west-2' }
  assert.equal(AwsActionResult.parse(await awsOf('POST', 'aws/credentials', awsKey)).accepted, false)
  assert.deepEqual(AwsActionResult.parse(await awsOf('POST', 'aws/credentials', { ...awsKey, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' })), {
    accepted: false, why: 'that is a temporary key (ASIA…), which expires; make an access key for an IAM user (AKIA…)',
  }, 'the format is checked before the key goes anywhere')
  accept(AWS_SECRET)
  const awsConnected = AwsActionResult.parse(await awsOf('POST', 'aws/credentials', awsKey))
  assert.ok(awsConnected.accepted)
  assert.deepEqual(awsConnected.state, { status: 'connected', accessKeyId: 'AKIA…MPLE', region: 'us-west-2', accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/ouro-agents', problem: null })
  assert.deepEqual(AwsIntegrationState.parse(await awsOf('GET', 'aws')), awsConnected.state)
  assert.ok(!(await phone.snapshot()).integrations.some((integration) => (integration.provider as string) === 'aws'))
  // Disconnecting removes the machine's default key, which may be the owner's own: an invited person can't.
  const { code } = await phone.command('start_pairing', { inviteePersonName: 'guest' })
  const paired = await (await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'guest-phone' }) })).json() as { deviceToken: string; deviceId: string }
  const guest = new Client(run, paired.deviceToken, paired.deviceId)
  const refused = await guest.integration('POST', 'aws/disconnect')
  assert.equal(refused.status, 403, JSON.stringify(refused.body))
  assert.deepEqual(AwsIntegrationState.parse(await awsOf('GET', 'aws')), awsConnected.state, 'still connected')
  assert.deepEqual(AwsActionResult.parse(await awsOf('POST', 'aws/disconnect')), { accepted: true, state: { status: 'not_connected' } })
  assert.equal((await phone.integration('POST', 'aws/credentials', { accessKeyId: 'AKIA' })).status, 400)

  // Sprites, like AWS, has its own routes; its token makes servers, so only the owner sees or changes it.
  const SPRITES_TOKEN = 'sprites-token-taken-0123456789'
  assert.deepEqual(SpritesIntegrationState.parse(await awsOf('GET', 'sprites')), { status: 'not_connected' })
  assert.equal(SpritesActionResult.parse(await awsOf('POST', 'sprites/token', { token: SPRITES_TOKEN })).accepted, false)
  accept(SPRITES_TOKEN)
  assert.deepEqual(SpritesActionResult.parse(await awsOf('POST', 'sprites/token', { token: SPRITES_TOKEN })), {
    accepted: true, state: { status: 'connected', token: 'sprite…6789', problem: null },
  })
  for (const [method, action] of [['GET', 'sprites'], ['POST', 'sprites/token'], ['POST', 'sprites/disconnect']] as const) {
    const answer = await guest.integration(method, action, method === 'POST' ? { token: SPRITES_TOKEN } : undefined)
    assert.equal(answer.status, 403, `${method} ${action}: ${JSON.stringify(answer.body)}`)
  }
  assert.deepEqual(SpritesActionResult.parse(await awsOf('POST', 'sprites/disconnect')), { accepted: true, state: { status: 'not_connected' } })

  assert.equal((await phone.integration('POST', 'github/token', { nothing: true })).status, 400)
  assert.equal((await phone.integration('POST', 'github/teleport')).status, 404)
  const anonymous = await fetch(`${run.url}/v2/integrations/claude/login/start`, { method: 'POST' })
  assert.equal(anonymous.status, 401)
  assert.ok(!run.log().includes('sk-or-taken') && !run.log().includes('right-code') && !run.log().includes(AWS_SECRET) && !run.log().includes('sprites-token-taken'), 'no secret is ever logged')
})
