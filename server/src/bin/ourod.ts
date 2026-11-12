// ourod: the server for one data directory. Configured entirely by its environment, so a run owns all of its state.
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { createServer } from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_SERVER_PORT } from '@ouro/contract'
import { dataPaths } from '../adapters/paths.ts'
import { OuroCore } from '../app/core.ts'
import { defaultAgentPolicy } from '../domain/agent.ts'
import { createApiHandler, openChangeStreams } from '../interfaces/http.ts'
import { fileClock, systemClock } from '../adapters/clock.ts'
import { apnsSender } from '../adapters/apns.ts'
import { realIntegrationTools } from '../adapters/integration-tools.ts'
import { standInIntegrationTools } from '../adapters/integrations.ts'
import { spriteTailscale, systemdTailscale, standInTailscale } from '../adapters/tailscale.ts'
import type { TailscaleSetup } from '../adapters/tailscale.ts'
import type { SendPush } from '../adapters/apns.ts'
import { claudeSummarize } from '../adapters/summarizer.ts'
import { neverSleeps, spriteTasksHold } from '../adapters/host-hold.ts'
import type { HostHold } from '../adapters/host-hold.ts'
import { versionOf } from '../adapters/base-source.ts'
import type { BaseSource } from '../adapters/base-source.ts'
import { gitBaseSource } from '../adapters/git-bases.ts'
import { httpGitHubApi } from '../adapters/github-api.ts'
import { guardianClient } from '../adapters/guardian-client.ts'
import { DEFAULT_LIVE_POLICY, DEFAULT_SUMMARY_POLICY } from '../domain/summary.ts'
import { ownPeerAddress } from '../domain/peers.ts'

const startedAt = performance.now()
const DEFAULT_SLOW_REQUEST_MS = 2_000
const MEMORY_READING_INTERVAL_MS = 10 * 60_000
const EVENT_LOOP_CHECK_MS = 10_000
const EVENT_LOOP_STALL_MS = 1_000
const environment = process.env
const serverRoot = resolve(import.meta.dirname, '../..')

/** Each line names this instance, its release and how long it has run; never message contents or secrets. */
function logEvent(event: string, fields: object = {}): void {
  console.log(JSON.stringify({ event, at: Date.now(), pid: process.pid, release: releaseId, uptimeMs: Math.round(performance.now() - startedAt), ...fields }))
}

const dataDir = environment.OURO_DATA
if (!dataDir) throw new Error('OURO_DATA must name this server\'s data directory')
const releaseId = environment.OURO_RELEASE_ID ?? 'dev'
const paths = dataPaths(resolve(dataDir))

const isAnotherServerListening = (socketPath: string) => new Promise<boolean>((resolvePromise) => {
  if (!existsSync(socketPath)) return resolvePromise(false)
  const probe = connect(socketPath)
  probe.on('connect', () => { probe.destroy(); resolvePromise(true) })
  probe.on('error', () => resolvePromise(false))
})

if (await isAnotherServerListening(paths.localSocket)) {
  console.error(`another ourod is already serving ${paths.dataDir}`)
  process.exit(1)
}

function parseAgentEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL']) {
    const value = environment[name]
    if (value !== undefined) base[name] = value
  }
  // Agents deploy and publish through the guardian, when there is one.
  for (const name of ['OURO_GUARDIAN_SOCKET', 'OURO_APP_SOURCE', 'OURO_APP_EXPORT_COMMAND']) {
    const value = environment[name]
    if (value !== undefined) base[name] = value
  }
  // Credentials and settings are never inherited by accident; a run names exactly what its agents get.
  return environment.OURO_AGENT_ENV_JSON ? { ...base, ...JSON.parse(environment.OURO_AGENT_ENV_JSON) as Record<string, string> } : base
}

const policy = { ...defaultAgentPolicy, ...(environment.OURO_POLICY_JSON ? JSON.parse(environment.OURO_POLICY_JSON) as Partial<typeof defaultAgentPolicy> : {}) }

const agentBaseEnv = parseAgentEnv()

/** The person's own APNs key, if they set one up. Without it nothing is pushed. */
function pushSenderFromEnvironment(): SendPush | null {
  const { OURO_APNS_KEY_FILE: keyFile, OURO_APNS_KEY_ID: keyId, OURO_APNS_TEAM_ID: teamId } = environment
  if (!keyFile || !keyId || !teamId) return null
  // An unreadable key turns push off rather than stopping the server: everything still reaches the app through sync.
  try {
    return apnsSender({ keyFile, keyId, teamId }, environment.OURO_APNS_GATEWAY ?? null)
  } catch (error) {
    logEvent('push_unavailable', { keyFile, why: (error as Error).message })
    return null
  }
}

/** The git repository at `OURO_BASE_REPO`, which bases are taken from. */
function baseSourceOf(env: NodeJS.ProcessEnv): BaseSource | null {
  return env.OURO_BASE_REPO ? gitBaseSource(env.OURO_BASE_REPO) : null
}

/** `ouro-next` from `https://github.com/someone/ouro-next(.git)`; the base repository's name when none is configured. */
function baseRepositoryNameOf(url: string | undefined): string {
  return url?.replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') || 'ouro-next'
}

/** The guardian names the app inside the person's copy; the server is beside it there. */
function personSourceOf(appDir: string | undefined): { root: string; appDir: string; serverDir: string } | null {
  if (!appDir) return null
  return { root: resolve(appDir, '../..'), appDir, serverDir: join(appDir, '../../server') }
}

/** On a Sprite, its Tasks API holds it awake; `OURO_HOST_HOLD` says so outright (`sprite` or `none`). The task is named
 * for this data directory, so servers beside each other each hold for their own work. */
function hostHoldFromEnvironment(): HostHold {
  const socketPath = environment.OURO_SPRITE_API_SOCKET ?? '/.sprite/api.sock'
  const kind = environment.OURO_HOST_HOLD ?? (existsSync(socketPath) ? 'sprite' : 'none')
  if (kind === 'none') return neverSleeps
  if (kind !== 'sprite') throw new Error(`OURO_HOST_HOLD must be sprite or none, not ${kind}`)
  return spriteTasksHold(socketPath, `ouro-${createHash('sha256').update(paths.dataDir).digest('hex').slice(0, 12)}`)
}

/**
 * Journeys use the stand-in; a run Sprite sets Tailscale up itself, and reaches computers only through it. A run server
 * under systemd (an EC2 instance, `OURO_TAILSCALE=systemd`) can join the person's Tailscale network too, though it
 * reaches computers without it. Anywhere else the machine has its own network.
 */
function tailscaleSetupFromEnvironment(): TailscaleSetup {
  if (environment.OURO_TAILSCALE_STAND_IN_DIR) return { kind: 'set_up_here', host: standInTailscale(environment.OURO_TAILSCALE_STAND_IN_DIR), neededForComputers: true }
  const kind = environment.OURO_TAILSCALE
  if (kind === 'sprite') return { kind: 'set_up_here', host: spriteTailscale(), neededForComputers: true }
  if (kind === 'systemd') return { kind: 'set_up_here', host: systemdTailscale(), neededForComputers: false }
  return { kind: 'not_needed' }
}

const core = new OuroCore({
  paths,
  clock: environment.OURO_CLOCK_FILE ? fileClock(environment.OURO_CLOCK_FILE) : systemClock,
  policy,
  releaseId,
  version: versionOf(readFileSync(join(serverRoot, 'package.json'), 'utf8')),
  machineName: environment.OURO_MACHINE_NAME ?? 'this-machine',
  peerAddress: ownPeerAddress({ peerAddress: environment.OURO_PEER_ADDRESS, publicUrl: environment.OURO_PUBLIC_URL }),
  defaultModel: environment.OURO_DEFAULT_MODEL ?? 'opus',
  defaultFolder: environment.OURO_DEFAULT_FOLDER ?? join(paths.dataDir, 'work'),
  agentLimit: Number(environment.OURO_AGENT_LIMIT ?? 8),
  cliBinDir: environment.OURO_CLI_BIN_DIR ?? join(serverRoot, 'bin'),
  runnerEntry: join(serverRoot, 'src/bin/ouro-runner.ts'),
  runnerHostSocket: environment.OURO_RUNNER_HOST_SOCKET ?? null,
  protocolsDir: join(serverRoot, 'protocols'),
  personSource: personSourceOf(agentBaseEnv.OURO_APP_SOURCE),
  agentBaseEnv,
  publicUrl: environment.OURO_PUBLIC_URL ?? null,
  linkScheme: 'ouronext',
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
  livePolicy: DEFAULT_LIVE_POLICY,
  // The summarizer runs with what agents get, so it signs in the way they do.
  summarize: claudeSummarize(agentBaseEnv.OURO_CLAUDE_BIN ?? 'claude', agentBaseEnv),
  summaryModel: environment.OURO_SUMMARY_MODEL ?? 'haiku',
  sendPush: pushSenderFromEnvironment(),
  // Journeys use the stand-in; a real machine asks the accounts' own tools.
  integrationTools: environment.OURO_INTEGRATIONS_STAND_IN_DIR
    ? standInIntegrationTools(environment.OURO_INTEGRATIONS_STAND_IN_DIR, { openrouter: paths.openrouterApiKey })
    : realIntegrationTools({ dataDir: paths.dataDir, anthropicKeyFile: paths.anthropicApiKey, openrouterKeyFile: paths.openrouterApiKey, claudeConfigDir: environment.CLAUDE_CONFIG_DIR ?? null }),
  // An older guardian's acceptance check runs stand-in agents with real accounts and an empty home.
  accountsAreStandIns: environment.OURO_INTEGRATIONS_STAND_IN_DIR !== undefined,
  hostHold: hostHoldFromEnvironment(),
  peerMemoryPullIntervalMs: Number(environment.OURO_PEER_MEMORY_PULL_MS ?? 30_000),
  // The hub offers bases on installed machines, and the publisher machine publishes them there (M6); a folder stands in for it.
  baseSource: baseSourceOf(environment),
  baseRepositoryName: baseRepositoryNameOf(environment.OURO_BASE_REPO),
  firstPushRetryDelaysMs: [2_000, 5_000, 10_000, 20_000],
  githubApi: httpGitHubApi(environment.OURO_GITHUB_API_URL ?? 'https://api.github.com'),
  guardian: agentBaseEnv.OURO_GUARDIAN_SOCKET ? guardianClient(agentBaseEnv.OURO_GUARDIAN_SOCKET) : null,
  tailscale: tailscaleSetupFromEnvironment(),
  log: logEvent,
})

const requestLogging = { log: logEvent, slowRequestMs: Number(environment.OURO_SLOW_REQUEST_MS ?? DEFAULT_SLOW_REQUEST_MS) }
const servers = [createServer(createApiHandler(core, 'local', requestLogging))]
rmSync(paths.localSocket, { force: true })
servers[0]!.listen(paths.localSocket)

const appListen = environment.OURO_APP_LISTEN ?? `tcp:${DEFAULT_SERVER_PORT}`
const appServer = createServer(createApiHandler(core, 'network', requestLogging))
servers.push(appServer)
if (appListen.startsWith('unix:')) {
  const socketPath = appListen.slice('unix:'.length)
  rmSync(socketPath, { force: true })
  appServer.listen(socketPath)
} else {
  appServer.listen(Number(appListen.slice('tcp:'.length)), '0.0.0.0')
}

core.start(Number(environment.OURO_TICK_MS ?? 1000))

function logMemory(): void {
  const usage = process.memoryUsage()
  logEvent('memory', { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal, externalBytes: usage.external })
}
logMemory()
setInterval(logMemory, MEMORY_READING_INTERVAL_MS).unref()

// A blocked event loop holds up every request and agent at once, so it is logged even when nothing else looks wrong.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()
setInterval(() => {
  const maxDelayMs = Math.round(eventLoopDelay.max / 1e6)
  if (maxDelayMs >= EVENT_LOOP_STALL_MS) logEvent('event_loop_stalled', { maxDelayMs, intervalMs: EVENT_LOOP_CHECK_MS })
  eventLoopDelay.reset()
}, EVENT_LOOP_CHECK_MS).unref()

appServer.on('listening', () => {
  const address = appServer.address()
  logEvent('listening', { elapsedMs: Math.round(performance.now() - startedAt), app: typeof address === 'object' && address ? address.port : address, localSocket: paths.localSocket, instance: process.pid })
})

const DRAIN_LIMIT_MS = 5_000

/**
 * Stops taking requests, answers the ones in progress, then exits. Cutting a request mid-answer would turn a routine
 * restart into an error on someone's phone. Change streams end, and their clients resume from their cursors.
 */
async function shutDown(signal: string): Promise<void> {
  logEvent('stopping', { signal })
  const drained = servers.map((server) => new Promise<void>((resolveClosed) => server.close(() => resolveClosed())))
  for (const server of servers) server.closeIdleConnections()
  for (const stream of openChangeStreams) stream.destroy()
  await Promise.race([Promise.all(drained), new Promise((done) => setTimeout(done, DRAIN_LIMIT_MS))])
  for (const server of servers) server.closeAllConnections()
  core.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutDown('SIGTERM'))
process.on('SIGINT', () => void shutDown('SIGINT'))
