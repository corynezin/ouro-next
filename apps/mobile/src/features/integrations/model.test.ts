import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actionOutcome, awsCredentialsOf, awsIdentityText, awsName, awsOutcome, chatgptAccountText, chatgptSection, claudeButtonLabel, claudeStatusText, GITHUB_TOKEN_PAGE, gitHubConnectedToast, gitHubMissingScopesNote,
  gitHubName, KEY_REMOVAL_FAILED, keyRemovalOutcome, OPENROUTER_CREDITS_FOOTER, openRouterCreditsText, openRouterSpentText, pasted, usageFooter, usageRows, usageWindowLabel, usageWindowValue,
} from './model.ts'

test('Claude Code status in words, checking until the server has asked', () => {
  assert.equal(claudeStatusText(null), 'Checking…')
  assert.equal(claudeStatusText({ status: 'signed_out' }), 'Not signed in')
  assert.equal(claudeStatusText({ status: 'signed_in', account: { method: 'api_key' } }), 'Signed in with an API key')
  assert.equal(claudeStatusText({ status: 'signed_in', account: { method: 'plan', email: 'a@b.c' } }), 'Signed in as a@b.c')
  assert.equal(claudeStatusText({ status: 'signed_in', account: { method: 'plan', email: null } }), 'Signed in')
  assert.equal(claudeButtonLabel({ status: 'signed_out' }), 'Sign in to Claude Code')
  assert.equal(claudeButtonLabel({ status: 'signed_in', account: { method: 'api_key' } }), 'Sign in again or use an API key')
})

test('an action: accepted with the new state, refused in the reference words, or the failure', () => {
  const integration = { id: 'github', provider: 'github', state: { status: 'not_connected' }, checkedAt: 1 } as const
  assert.deepEqual(actionOutcome({ ok: true, value: { accepted: true, integration } }, 'no'), { kind: 'accepted', integration })
  assert.deepEqual(actionOutcome({ ok: true, value: { accepted: false, why: 'bad credentials' } }, 'GitHub did not accept that token.'),
    { kind: 'failed', text: 'GitHub did not accept that token.' })
  assert.deepEqual(actionOutcome({ ok: false, failure: { kind: 'timed_out' } }, 'no'), { kind: 'failed', text: 'request timed out' })
})

test('ChatGPT shows one section at a time', () => {
  assert.equal(chatgptSection(null, false), 'checking')
  assert.equal(chatgptSection({ status: 'not_installed' }, true), 'not_installed')
  assert.equal(chatgptSection({ status: 'signed_in', email: null, plan: null, models: [] }, true), 'connected')
  assert.equal(chatgptSection({ status: 'signed_out' }, true), 'enter_code')
  assert.equal(chatgptSection({ status: 'signed_out' }, false), 'sign_in')
})

test('usage windows: named by length, used until they reset', () => {
  const now = 1_700_000_000_000
  assert.equal(usageWindowLabel({ usedFraction: 0.01, windowMinutes: 300, resetsAt: null }), '5-hour window')
  assert.equal(usageWindowLabel({ usedFraction: 0.01, windowMinutes: 10080, resetsAt: null }), '7-day window')
  assert.equal(usageWindowLabel({ usedFraction: 0.01, windowMinutes: 90, resetsAt: null }), '90-minute window')
  assert.equal(usageWindowValue({ usedFraction: 0.416, windowMinutes: 300, resetsAt: null }, now), '42% used')
  assert.match(usageWindowValue({ usedFraction: 0.416, windowMinutes: 300, resetsAt: now + 60_000 }, now), /^42% used · resets .+$/)
  assert.equal(usageWindowValue({ usedFraction: 0.416, windowMinutes: 300, resetsAt: now }, now), '0% used')
  assert.equal(usageFooter(null, true), 'Checking usage…')
  assert.equal(usageFooter(null, false), 'Usage is not available yet.')
  assert.match(usageFooter({ windows: [], observedAt: now }, false), /^Last updated .+\. Usage is shared across Codex on your ChatGPT plan\.$/)
})

test('OpenRouter spending, with what is left when OpenRouter says', () => {
  assert.equal(openRouterSpentText({ status: 'not_configured' }), null)
  assert.equal(openRouterSpentText({ status: 'configured', spentUsd: null, availableUsd: 10 }), null)
  assert.equal(openRouterSpentText({ status: 'configured', spentUsd: 1.5, availableUsd: null }), '$1.50')
  assert.equal(openRouterSpentText({ status: 'configured', spentUsd: 1.5, availableUsd: 8.5 }), '$1.50, $8.50 left')
})

test('GitHub names the missing scopes agents need', () => {
  assert.equal(gitHubMissingScopesNote({ status: 'connected', user: 'c', scopes: ['repo'] }), 'Missing scopes: workflow. Create a new token with these scopes for full agent access.')
  assert.equal(gitHubMissingScopesNote({ status: 'connected', user: 'c', scopes: ['repo', 'workflow', 'gist'] }), null)
  assert.equal(gitHubName({ status: 'connected', user: null, scopes: [] }), 'GitHub')
  assert.equal(gitHubConnectedToast({ status: 'connected', user: 'ada', scopes: [] }), 'Connected as ada')
  assert.equal(GITHUB_TOKEN_PAGE, 'https://github.com/settings/tokens/new?description=Ouro%20agents&scopes=repo,gist,read:org,workflow')
  assert.equal(pasted('  '), null)
  assert.equal(pasted(' ghp_x '), 'ghp_x')
})

test('Settings shows OpenRouter credits as spent of all it may spend, once OpenRouter has said (SET-15)', () => {
  assert.equal(openRouterCreditsText({ status: 'configured', spentUsd: 1.5, availableUsd: 8.5 }), '$1.50 of $10.00')
  assert.equal(openRouterCreditsText({ status: 'configured', spentUsd: 1.5, availableUsd: null }), '$1.50')
  assert.equal(openRouterCreditsText({ status: 'configured', spentUsd: null, availableUsd: null }), null)
  assert.equal(openRouterCreditsText({ status: 'not_configured' }), null)
  assert.match(OPENROUTER_CREDITS_FOOTER, /^What this OpenRouter key has spent, and what is left of its limit/)
})

test("removing the OpenRouter key, refused, says the server's reason, else the reference's words (INT-18)", () => {
  assert.deepEqual(keyRemovalOutcome({ ok: true, value: { accepted: false, why: 'the key file is locked' } }), { kind: 'failed', text: 'the key file is locked' })
  assert.deepEqual(keyRemovalOutcome({ ok: true, value: { accepted: false, why: ' ' } }), { kind: 'failed', text: 'Could not remove the key.' })
  assert.equal(KEY_REMOVAL_FAILED, 'Could not remove the key.')
})

test('ChatGPT signed in without an email reads "Signed in"; usage says "Checking…" until the first reading, then its two shortest windows (INT-17)', () => {
  assert.equal(chatgptAccountText({ email: null }), 'Signed in')
  assert.equal(chatgptAccountText({ email: 'a@b.c' }), 'a@b.c')
  assert.deepEqual(usageRows(null, true, 0), [{ key: 'checking', label: 'Usage', value: 'Checking…' }])
  assert.deepEqual(usageRows(null, false, 0), [])
  const windows = [300, 10_080, 43_200].map((windowMinutes) => ({ windowMinutes, usedFraction: 0.5, resetsAt: null, status: 'allowed' as const }))
  assert.deepEqual(usageRows({ windows, observedAt: 0 }, true, 0).map((row) => row.label), ['5-hour window', '7-day window'])
})

test('AWS: refusals in the server\'s words, named by account, and sent only when all three are given', () => {
  const state = { status: 'connected', accessKeyId: 'AKIA…WXYZ', region: 'us-east-1', accountId: '111122223333', arn: 'arn:aws:iam::111122223333:user/agents', problem: null } as const
  assert.deepEqual(awsOutcome({ ok: true, value: { accepted: true, state } }, 'no'), { kind: 'accepted', state })
  assert.deepEqual(awsOutcome({ ok: true, value: { accepted: false, why: "that isn't an AWS region (like us-east-1)" } }, 'no'), { kind: 'failed', text: "that isn't an AWS region (like us-east-1)" })
  assert.deepEqual(awsOutcome({ ok: false, failure: { kind: 'timed_out' } }, 'no'), { kind: 'failed', text: 'request timed out' })
  assert.equal(awsName(state), 'AWS account 111122223333')
  assert.equal(awsName({ ...state, accountId: null }), 'AWS key AKIA…WXYZ')
  assert.equal(awsName({ status: 'not_connected' }), 'AWS')
  assert.equal(awsIdentityText(state.arn), 'agents')
  assert.equal(awsIdentityText('arn:aws:iam::111122223333:root'), 'root')
  assert.equal(awsIdentityText(null), null)
  assert.deepEqual(awsCredentialsOf(' AKIAX ', 'secret\n', 'US-EAST-1'), { accessKeyId: 'AKIAX', secretAccessKey: 'secret', region: 'us-east-1' })
  assert.equal(awsCredentialsOf('AKIAX', ' ', 'us-east-1'), null)
})

test('Sprites: a pasted token without its spaces, and refusals in the server\'s words', async () => {
  const { spritesOutcome, spritesTokenOf } = await import('./model.ts')
  assert.equal(spritesTokenOf(' abc\ndef '), 'abcdef')
  assert.equal(spritesTokenOf('  '), null)
  const state = { status: 'connected', token: 'abcd…wxyz', problem: null } as const
  assert.deepEqual(spritesOutcome({ ok: true, value: { accepted: true, state } }, 'no'), { kind: 'accepted', state })
  assert.deepEqual(spritesOutcome({ ok: true, value: { accepted: false, why: 'Sprites rejected that token' } }, 'no'), { kind: 'failed', text: 'Sprites rejected that token' })
  assert.deepEqual(spritesOutcome({ ok: true, value: { accepted: false, why: ' ' } }, 'no'), { kind: 'failed', text: 'no' })
})
