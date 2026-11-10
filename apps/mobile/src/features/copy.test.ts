// Words the parity list states exactly, checked as literals: a test against the constant itself would pass whatever it says.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETUP_COPY } from '../core/hub/setupFlow.ts'
import { checkOutcomeText } from '../core/updates/updateFlow.ts'
import { COMPUTERS_COPY, TAILSCALE_COPY } from './computers/model.ts'
import { CONNECT_COPY } from './integrations/model.ts'
import { SETUP_SCREEN_COPY, WELCOME_COPY } from './onboarding/model.ts'
import { leaveAction, SETTINGS_COPY } from './settings/model.ts'
import { planUsageFooter } from './shared/planUsage.ts'

test('Welcome and Setup say what the reference says (ONB-03, ONB-07, ONB-11, ONB-17)', () => {
  assert.equal(WELCOME_COPY.pitch, 'Your own team of Claude agents, on a computer of your own in the cloud. Chat with them from here.')
  assert.equal(WELCOME_COPY.missingFields, 'Enter your invite code and your name.')
  assert.equal(WELCOME_COPY.pairInstead, 'I have my own server: pair with a code')
  assert.equal(SETUP_SCREEN_COPY.title('Alex'), 'Setting up your computer, Alex')
  assert.equal(SETUP_SCREEN_COPY.body, 'This takes a few minutes. You can leave the app; it carries on.')
  assert.equal(SETUP_SCREEN_COPY.failedTitle, 'Something went wrong')
  assert.equal(SETUP_COPY.signedOut, 'This sign-up is no longer valid. Start over with your invite code.')
  assert.equal(SETUP_COPY.failed, 'Setting up your computer failed.')
  assert.equal(SETUP_COPY.alreadyPaired, 'Your computer is ready but already paired with another phone.')
  assert.equal(SETUP_COPY.pairingFailed('expired'), 'Connecting this phone failed: expired')
})

test('Connect Claude says what the reference says (ONB-20, ONB-26, ONB-28, ONB-30)', () => {
  assert.equal(CONNECT_COPY.title, 'Sign in to Claude Code on your computer')
  assert.equal(CONNECT_COPY.codeRefused, 'Anthropic did not accept that code. Open the login page again for a new one.')
  assert.equal(CONNECT_COPY.keyRefused, 'That API key was not accepted.')
  assert.equal(CONNECT_COPY.openRouterRefused, 'OpenRouter did not accept that key.')
})

test('Settings footers and outcomes say what the reference says (SET-08, SET-13, SET-19, SET-22, SET-24)', () => {
  assert.equal(SETTINGS_COPY.inviteFooter, 'A one-time code they paste in the Ouro app (or a link they tap). The code lasts 10 minutes and gives them full access to this server.')
  assert.equal(planUsageFooter('mac'), "The subscription's 5-hour and weekly limits as mac last saw them (it learns them from agents' turns).")
  assert.equal(SETTINGS_COPY.foldFooter, 'Agents quiet that long (not busy, nothing unread or waiting) go into an Idle section at the bottom.')
  assert.equal(checkOutcomeText('checking'), 'Checking…')
  assert.equal(checkOutcomeText({ kind: 'disabled' }), 'Updates are off in development builds.')
  assert.equal(checkOutcomeText({ kind: 'up_to_date' }), 'Up to date.')
  assert.equal(checkOutcomeText({ kind: 'downloaded' }), 'Downloaded: tap the banner (or restart the app) to use it.')
  assert.equal(checkOutcomeText({ kind: 'failed', reason: 'no route' }), 'no route')
  const signOut = leaveAction(true)
  assert.equal(signOut.confirmMessage, 'Ouro forgets your account here. Your computers and agents keep running; signing in again needs a new invite code.')
  assert.equal(signOut.failedText, 'Could not sign out. Saved setup could not be updated.')
  assert.equal(leaveAction(false).failedText, 'Could not remove saved server.')
})

test('Computers says what the reference says (COMP-01, COMP-03, COMP-06, COMP-07)', () => {
  assert.equal(COMPUTERS_COPY.listTitle, 'Your computers')
  assert.equal(COMPUTERS_COPY.listFooter, 'When starting an agent, pick one under Machine.')
  assert.equal(COMPUTERS_COPY.addTitle, 'Add a computer')
  assert.equal(COMPUTERS_COPY.making, 'Making an invite…')
  assert.match(COMPUTERS_COPY.addFooter, /^Use your own Mac or Linux machine for agents\. .*Add only computers you trust that with\./)
  assert.equal(TAILSCALE_COPY.remove, 'Remove Tailscale from this server')
  assert.equal(TAILSCALE_COPY.removeTitle, 'Remove Tailscale?')
  assert.equal(TAILSCALE_COPY.removeMessage, 'This server leaves your Tailscale network.')
  assert.equal(COMPUTERS_COPY.offlineNote, 'An offline computer comes back by itself when it wakes.')
})
