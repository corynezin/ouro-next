import assert from 'node:assert/strict'
import { test } from 'node:test'
import { elapsedText, setupProgress, signupFailureText, signupRequestOf, WELCOME_COPY } from './model.ts'

test('Welcome needs both fields, trimmed, and says why sign-up failed', () => {
  assert.deepEqual(signupRequestOf(' alpha ', ' Alex '), { request: { invite: 'alpha', name: 'Alex' } })
  assert.deepEqual(signupRequestOf('alpha', '  '), { error: WELCOME_COPY.missingFields })
  assert.equal(signupFailureText({ kind: 'unreachable', reason: 'offline' }), "Can't reach the server (offline). Check your connection and try again.")
  assert.equal(signupFailureText({ kind: 'refused', code: 'invite_invalid', message: 'That invite was used already.', retryable: false }), 'That invite was used already.')
  const full = 'This hub has no room for another computer right now. Your invite code still works: try it again later.'
  assert.equal(signupFailureText({ kind: 'refused', code: 'hub_full', message: full, retryable: true }), full, 'a full hub, as it is')
  assert.equal(signupFailureText({ kind: 'invalid_answer', status: 200 }), 'Sign-up failed.')
})

test('setup progress: each step its words and share of the bar; a failure shows no bar', () => {
  assert.deepEqual(setupProgress({ stage: 'waiting', step: null }), { fraction: 0.05, text: 'Getting started' })
  const steps = (['create', 'upload', 'install', 'setup', 'service', 'pair'] as const).map((step) => setupProgress({ stage: 'waiting', step }))
  assert.deepEqual(steps, [
    { fraction: 0.10, text: 'Creating your computer' }, { fraction: 0.25, text: 'Copying Ouro to it' }, { fraction: 0.45, text: 'Installing its tools' },
    { fraction: 0.75, text: 'Setting up your first agent' }, { fraction: 0.85, text: 'Opening a secure connection' }, { fraction: 0.95, text: 'Connecting this phone' },
  ])
  assert.deepEqual(setupProgress({ stage: 'pairing' }), { fraction: 0.95, text: 'Connecting this phone' })
  assert.equal(setupProgress({ stage: 'done' })?.fraction, 0.98)
  assert.equal(setupProgress({ stage: 'failed', message: 'x' }), null)
})

test('the timer says seconds under a minute, then m:ss', () => {
  assert.equal(elapsedText(12_400), '12s')
  assert.equal(elapsedText(65_000), '1:05')
  assert.equal(elapsedText(-5), '0s')
})
