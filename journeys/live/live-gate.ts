// The live tier spends the owner's plan, so it runs only when asked: `OURO_LIVE=1 npm run test:live`. Without the opt-in a
// live test is skipped as not asked for; a test that needs Claude's login and finds none is blocked, never passed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** This machine's home: the live Claude turn reads its login there, and never changes it. */
export const LIVE_HOME = process.env.HOME ?? ''

/** The node:test `skip` option for a live test: false when it may run, otherwise why not. */
export function liveSkip(options: { needsClaudeLogin: boolean }): false | string {
  if (process.env.OURO_LIVE !== '1') return 'live tier not asked for: set OURO_LIVE=1'
  if (options.needsClaudeLogin && !existsSync(join(LIVE_HOME, '.claude', '.credentials.json'))) return 'BLOCKED: no Claude login on this machine'
  return false
}

/** Above this, a run has gone wrong: a live test fails rather than keep spending. */
export const LIVE_COST_CEILING_USD = 0.25
