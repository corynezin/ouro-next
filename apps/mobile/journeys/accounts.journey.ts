// Accounts in Settings through the real server and its stand-in accounts.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { actionOutcome, chatgptSection, claudeStatusText, CONNECT_COPY, gitHubConnectedToast, openRouterSpentText } from '../src/features/integrations/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('accounts in Settings: a refused key says so, an accepted one arrives through sync, and a ChatGPT sign-in completes by itself', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  const accept = async (secret: string) => {
    await mkdir(run.accountsDir, { recursive: true })
    await appendFile(join(run.accountsDir, 'accepted'), `${secret}\n`)
  }
  const claude = () => session.store.integration('claude')?.state ?? null
  const chatgpt = () => session.store.integration('chatgpt')?.state ?? null
  const openrouter = () => session.store.integration('openrouter')?.state ?? null
  const github = () => session.store.integration('github')?.state ?? null
  try {
    // The stand-in starts signed in with a plan, like a machine in use.
    await waitFor('Claude checked', () => claudeStatusText(claude()) === 'Signed in as person@stand-in.invalid')

    const refused = actionOutcome(await session.api.claudeSetApiKey('sk-ant-not-accepted'), CONNECT_COPY.keyRefused)
    assert.deepEqual(refused, { kind: 'failed', text: 'That API key was not accepted.' })
    await accept('sk-ant-accepted')
    const keyed = actionOutcome(await session.api.claudeSetApiKey('sk-ant-accepted'), CONNECT_COPY.keyRefused)
    assert.equal(keyed.kind, 'accepted')
    await waitFor('Claude signed in, through sync', () => claudeStatusText(claude()) === 'Signed in with an API key')

    await accept('sk-or-accepted')
    assert.equal(actionOutcome(await session.api.openrouterSetKey('sk-or-accepted'), CONNECT_COPY.openRouterRefused).kind, 'accepted')
    // The stand-in's key has spent nothing and has $10 left.
    await waitFor('OpenRouter spending shown', () => { const state = openrouter(); return state !== null && openRouterSpentText(state) === '$0.00, $10.00 left' })

    await accept('ghp_accepted')
    const connected = actionOutcome(await session.api.githubSetToken('ghp_accepted'), 'GitHub did not accept that token.')
    assert.ok(connected.kind === 'accepted' && connected.integration.provider === 'github')
    assert.match(gitHubConnectedToast(connected.integration.state), /^Connected (as .+|to GitHub)$/)
    assert.equal(actionOutcome(await session.api.githubDisconnect(), 'Could not disconnect.').kind, 'accepted')
    await waitFor('GitHub disconnected', () => github()?.status === 'not_connected')

    assert.equal(chatgptSection(chatgpt(), false), 'sign_in')
    const started = await session.api.chatgptLoginStart()
    assert.ok(started.ok, started.ok ? '' : JSON.stringify(started.failure))
    assert.equal(chatgptSection(chatgpt(), true), 'enter_code')
    await writeFile(join(run.accountsDir, 'chatgpt-entered'), started.value.code)
    await waitFor('ChatGPT connected without the phone asking', () => chatgptSection(chatgpt(), true) === 'connected', 20_000)
    const refreshed = await session.command('refresh_plan_usage', { provider: 'chatgpt' })
    assert.ok(refreshed.ok, refreshed.ok ? '' : JSON.stringify(refreshed.failure))
    assert.equal(actionOutcome(await session.api.chatgptSignOut(), 'x').kind, 'accepted')
    await waitFor('ChatGPT signed out', () => chatgptSection(chatgpt(), false) === 'sign_in')
  } finally {
    phone.activeSession?.dispose()
  }
})
