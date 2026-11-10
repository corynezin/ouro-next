// Welcome and Setup as data. Pure: the screens only draw this.
import type { ProvisioningStep, SignupRequest } from '@ouro/contract'
import { hubFailureText } from '../../core/hub/hubApi.ts'
import type { HubFailure } from '../../core/hub/hubApi.ts'
import type { SetupState } from '../../core/hub/setupFlow.ts'

export const WELCOME_COPY = {
  pitch: 'Your own team of Claude agents, on a computer of your own in the cloud. Chat with them from here.',
  missingFields: 'Enter your invite code and your name.',
  pairInstead: 'I have my own server: pair with a code',
  saveFailed: 'Could not save your account on this phone. Please try again.',
} as const

/** What Welcome sends, or why it can't. */
export function signupRequestOf(invite: string, name: string): { request: SignupRequest } | { error: string } {
  const request = { invite: invite.trim(), name: name.trim() }
  return request.invite && request.name ? { request } : { error: WELCOME_COPY.missingFields }
}

export const signupFailureText = (failure: HubFailure) => hubFailureText(failure, 'Sign-up failed.')

/** Where a setup is, as the bar and the line under it show it. */
export interface SetupProgress { fraction: number; text: string }

const STEP_PROGRESS: Record<ProvisioningStep, SetupProgress> = {
  create: { fraction: 0.10, text: 'Creating your computer' },
  upload: { fraction: 0.25, text: 'Copying Ouro to it' },
  install: { fraction: 0.45, text: 'Installing its tools' },
  setup: { fraction: 0.75, text: 'Setting up your first agent' },
  service: { fraction: 0.85, text: 'Opening a secure connection' },
  pair: { fraction: 0.95, text: 'Connecting this phone' },
}

/** Null once it has failed: the failure is shown instead. */
export function setupProgress(state: SetupState): SetupProgress | null {
  switch (state.stage) {
    case 'waiting': return state.step === null ? { fraction: 0.05, text: 'Getting started' } : STEP_PROGRESS[state.step]
    case 'pairing': return STEP_PROGRESS.pair
    case 'done': return { fraction: 0.98, text: STEP_PROGRESS.pair.text }
    case 'failed': return null
  }
}

/** "12s" under a minute, then "m:ss". */
export function elapsedText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`
}

export const SETUP_SCREEN_COPY = {
  title: (name: string) => `Setting up your computer, ${name}`,
  /** Inside Servers, for a server made there. */
  serverTitle: (label: string) => `Setting up ${label}`,
  body: 'This takes a few minutes. You can leave the app; it carries on.',
  failedTitle: 'Something went wrong',
  resetFailed: 'Could not reset saved setup. Use the storage recovery warning or try again.',
} as const
