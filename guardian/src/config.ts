// Everything the guardian needs, from one file written at install time. Nothing here is read from a release.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GuardianConfig {
  home: string
  listenPort: number
  /** The person's own copy of the source, a git repository. Deploys build from its commits. */
  sourceDir: string
  sourceBranch: string
  /** The person's app source, inside their copy, for `ouro publish`. */
  appSourceDir: string
  machineName: string
  publicUrl: string | null
  /** Passed to ourod as is: default model and folder, agents' environment. */
  ourodEnv: Record<string, string>
  timing: GuardianTiming
}

export interface GuardianTiming {
  probeTimeoutMs: number
  /** After a switch, how long the new release must stay healthy before it's confirmed. */
  steadyWindowMs: number
  steadyIntervalMs: number
  startDeadlineMs: number
  stopGraceMs: number
  watchdogIntervalMs: number
  coldStartGraceMs: number
  sustainedOutageMs: number
  acceptanceDeadlineMs: number
  /** While following a branch, how often it is fetched. */
  followCheckMs: number
  /** A followed commit that started too slowly is tried again after this long. */
  followSlowRetryMs: number
}

export const defaultTiming: GuardianTiming = {
  probeTimeoutMs: 10_000,
  steadyWindowMs: 45_000,
  steadyIntervalMs: 5_000,
  startDeadlineMs: 30_000,
  stopGraceMs: 10_000,
  watchdogIntervalMs: 30_000,
  coldStartGraceMs: 60_000,
  sustainedOutageMs: 3 * 60_000,
  acceptanceDeadlineMs: 120_000,
  followCheckMs: 2 * 60_000,
  followSlowRetryMs: 30 * 60_000,
}

export interface GuardianPaths {
  releases: string
  releaseDir(id: string): string
  verifyDir(id: string): string
  state: string
  activePointer: string
  lastGoodPointer: string
  deployments: string
  /** What this machine follows, if anything: set by a person. */
  following: string
  restartBudget: string
  probeCredential: string
  failureSnapshots: string
  ourodLog: string
  dataDir: string
  appSocket: string
  localSocket: string
  controlSocket: string
  cliBin: string
}

export function guardianPaths(home: string): GuardianPaths {
  const state = join(home, 'guardian')
  return {
    releases: join(home, 'releases'),
    releaseDir: (id) => join(home, 'releases', id),
    verifyDir: (id) => join(home, 'verify', id),
    state,
    activePointer: join(state, 'active-release'),
    lastGoodPointer: join(state, 'last-good-release'),
    deployments: join(state, 'deployments.jsonl'),
    following: join(state, 'following.json'),
    restartBudget: join(state, 'restart-budget.json'),
    probeCredential: join(state, 'probe-credential'),
    failureSnapshots: join(state, 'failure-snapshots'),
    ourodLog: join(state, 'ourod.log'),
    dataDir: join(home, 'data'),
    appSocket: join(home, 'app.sock'),
    localSocket: join(home, 'data', 'local.sock'),
    controlSocket: join(home, 'guardian.sock'),
    cliBin: join(home, 'bin'),
  }
}

export function loadConfig(path: string): GuardianConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardianConfig> & { home: string; listenPort: number; sourceDir: string }
  return {
    sourceBranch: 'main',
    appSourceDir: join(raw.sourceDir, 'apps/mobile'),
    machineName: 'this-machine',
    publicUrl: null,
    ourodEnv: {},
    ...raw,
    timing: { ...defaultTiming, ...raw.timing },
  }
}
