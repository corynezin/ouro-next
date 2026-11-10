// What the root of the app shows. Pure: AppRoot only draws it.
import type { StartupState } from '../../core/appCore.ts'

export type RootView =
  | { kind: 'loading' }
  | { kind: 'startup_failed'; message: string }
  /** No server and no hosted account: sign up with an invite, or pair with a server of one's own. */
  | { kind: 'welcome' }
  /** Signed up, and no server on this phone yet: the hub is making one. */
  | { kind: 'setup' }
  /** The screens of the active server. Their key is the server: nothing from the old one stays on screen after a switch. */
  | { kind: 'server'; serverId: string }

export function rootView(startup: StartupState, activeServerId: string | null, hasHostedAccount: boolean): RootView {
  if (startup.stage === 'loading') return { kind: 'loading' }
  if (startup.stage === 'failed') return { kind: 'startup_failed', message: startup.message }
  if (activeServerId !== null) return { kind: 'server', serverId: activeServerId }
  return hasHostedAccount ? { kind: 'setup' } : { kind: 'welcome' }
}

export const DAMAGED_SETUP_TEXT = 'Some saved setup is damaged. Usable connections and preferences are loaded. Changes to damaged storage are temporary until reset. Reset saves a recovery copy first; server credentials are retained.'

export interface RecoveryBannerModel {
  text: string
  offerPreferencesReset: boolean
  offerServerListReset: boolean
}

export function recoveryBanner(input: { startup: StartupState; preferencesDamaged: boolean; serverListDamaged: boolean }): RecoveryBannerModel | null {
  const { startup, preferencesDamaged, serverListDamaged } = input
  if (startup.stage === 'loading') return null
  const startupFailure = startup.stage === 'failed' ? startup.message : null
  if (!preferencesDamaged && !serverListDamaged && startupFailure === null) return null
  return {
    text: startupFailure ?? DAMAGED_SETUP_TEXT,
    offerPreferencesReset: preferencesDamaged,
    offerServerListReset: serverListDamaged || startupFailure !== null,
  }
}
