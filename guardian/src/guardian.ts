// The release lifecycle: build beside the live release, verify offline, switch, confirm from outside, roll back by
// itself. Also the watchdog. Decisions are recorded in deployments.jsonl, so "what happened to that update?" has an answer.
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { runAcceptance } from './acceptance.ts'
import { holdingHostAwake, hostHoldSocket } from './host-hold.ts'
import { RestartBudget } from './budget.ts'
import { guardianPaths } from './config.ts'
import type { GuardianConfig, GuardianPaths } from './config.ts'
import { probeHealth, takeBaseline } from './probe.ts'
import { judgeFailedCheck } from './watchdog.ts'
import type { WatchdogClock } from './watchdog.ts'
import type { HealthBaseline, ProbeTarget } from './probe.ts'
import { startProxy } from './proxy.ts'
import { fetchHead, followingRequested, FollowRefused, followStep, readFollowing, validateFollowing, writeFollowing } from './follow.ts'
import type { FinishedAttempt, FollowCheck, Following } from './follow.ts'
import { buildRelease, readReleaseCommit, readReleaseManifest, resolveCommit } from './release-build.ts'
import { readDatabaseSchema, schemaRefusal } from './schema-gate.ts'
import { OurodSupervisor } from './supervisor.ts'

export type DeploymentPhase =
  | 'queued' | 'building' | 'verifying' | 'switching' | 'confirming'
  /** Terminal: live and confirmed healthy. */
  | 'live'
  /** Terminal: nothing changed. */
  | 'build_failed' | 'verification_failed' | 'refused' | 'superseded'
  /** Terminal: it went live, was unhealthy, and the last good release is back. */
  | 'rolled_back'
  /** Terminal: it went live and was unhealthy, and the return couldn't be confirmed either. Needs a person. */
  | 'rollback_unverified'

const TERMINAL_PHASES: readonly DeploymentPhase[] = ['live', 'build_failed', 'verification_failed', 'refused', 'superseded', 'rolled_back', 'rollback_unverified']

export interface Deployment {
  id: string
  releaseId: string | null
  commit: string | null
  requestedBy: string | null
  phase: DeploymentPhase
  reason: string | null
  startedAt: number
  endedAt: number | null
  /** It went live and was rolled back only because it didn't start serving in time. */
  startedTooSlowly: boolean
}

/** Rolling back because a release went live and was unhealthy: why, and whether it only started too slowly. */
interface LiveProblem {
  why: string
  startedTooSlowly: boolean
}

class NotServingInTime extends Error {}

const KEEP_RELEASES = 4
const PROBE_FAILURES_TO_ROLL_BACK = 2

export class Guardian {
  private readonly config: GuardianConfig
  private readonly paths: GuardianPaths
  private readonly supervisor: OurodSupervisor
  private readonly budget: RestartBudget
  private readonly deployments = new Map<string, Deployment>()
  private deployQueue: { deployment: Deployment; reference: string }[] = []
  private deploying = false
  private proxy: Server | null = null
  private control: Server | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private watchdogClock: WatchdogClock = { startedAt: Date.now(), lastHealthyAt: null }
  private followTimer: NodeJS.Timeout | null = null
  private followCheckInFlight: Promise<FollowCheck> | null = null
  private lastFollowCheck: { at: number; check: FollowCheck } | null = null
  private stopped = false

  constructor(config: GuardianConfig) {
    this.config = config
    this.paths = guardianPaths(config.home)
    this.supervisor = new OurodSupervisor(config, this.paths)
    this.budget = new RestartBudget(this.paths.restartBudget)
    for (const dir of [this.paths.state, this.paths.releases, this.paths.dataDir, this.paths.cliBin, this.paths.failureSnapshots]) mkdirSync(dir, { recursive: true })
    this.writeCliShim()
  }

  /** One `ouro` on agents' PATH that always runs the active release's client, so pruning a release can't strand an agent. */
  private writeCliShim(): void {
    const shim = join(this.paths.cliBin, 'ouro')
    writeFileSync(shim, `#!/bin/sh\nexec node --no-warnings "${this.paths.releases}/$(cat "${this.paths.activePointer}")/server/src/bin/ouro.ts" "$@"\n`)
    chmodSync(shim, 0o755)
  }

  async start(): Promise<void> {
    this.startControlSocket()
    this.proxy = startProxy({
      host: this.config.listenHost,
      port: this.config.listenPort,
      upstreamSocket: this.paths.appSocket,
      onListening: () => this.logEvent('listening', { host: this.config.listenHost, port: this.config.listenPort }),
    })
    this.supervisor.whenExitsUnexpectedly((code) => this.handleOurodExit(code))

    const active = this.readPointer(this.paths.activePointer)
    if (active && existsSync(this.paths.releaseDir(active))) {
      this.startOurod(active)
    } else {
      void this.enqueueDeploy(this.config.sourceBranch, 'first start')
    }
    this.watchdogTimer = setInterval(() => void this.watchdogCheck(), this.config.timing.watchdogIntervalMs)
    this.watchdogTimer.unref()
    this.followTimer = setInterval(() => void this.checkFollowed(), this.config.timing.followCheckMs)
    this.followTimer.unref()
  }

  /** Only for an orderly exit. ourod stops too; every runner keeps running. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    if (this.followTimer) clearInterval(this.followTimer)
    this.proxy?.close()
    this.proxy?.closeAllConnections()
    this.control?.close()
    this.control?.closeAllConnections()
    await this.supervisor.stop()
  }

  // Records

  private logEvent(event: string, fields: object = {}): void {
    console.log(JSON.stringify({ event, at: Date.now(), ...fields }))
  }

  private record(deployment: Deployment, phase: DeploymentPhase, reason: string | null = null): void {
    deployment.phase = phase
    deployment.reason = reason
    if (TERMINAL_PHASES.includes(phase)) deployment.endedAt = Date.now()
    appendFileSync(this.paths.deployments, `${JSON.stringify(deployment)}\n`)
    this.logEvent('deployment', { id: deployment.id, phase, reason, release: deployment.releaseId })
  }

  private readPointer(path: string): string | null {
    try {
      return readFileSync(path, 'utf8').trim() || null
    } catch {
      return null
    }
  }

  private writePointer(path: string, releaseId: string): void {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, releaseId)
    renameSync(temporary, path)
  }

  // Talking to the server

  private async askLocal(path: string, body: object): Promise<{ status: number; body: unknown }> {
    return await new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body))
      const outgoing = request({ socketPath: this.paths.localSocket, method: 'POST', path, timeout: this.config.timing.probeTimeoutMs, headers: { 'content-type': 'application/json' } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: response.statusCode ?? 0, body: text.length > 0 ? JSON.parse(text) as unknown : null })
          } catch {
            resolve({ status: response.statusCode ?? 0, body: text })
          }
        })
      })
      outgoing.on('timeout', () => outgoing.destroy(new Error(`${path} timed out`)))
      outgoing.on('error', reject)
      outgoing.end(payload)
    })
  }

  /** The probe's own device: re-issued if a release or a person lost it. */
  private async probeTarget(): Promise<ProbeTarget> {
    let credential = this.readPointer(this.paths.probeCredential)
    if (!credential) {
      const answer = await this.askLocal('/v2/internal/probe-credential', {})
      if (answer.status !== 200) throw new Error(`the server wouldn't issue a probe credential: ${answer.status}`)
      credential = (answer.body as { deviceToken: string }).deviceToken
      writeFileSync(this.paths.probeCredential, credential, { mode: 0o600 })
    }
    return { socketPath: this.paths.appSocket, credential, timeoutMs: this.config.timing.probeTimeoutMs }
  }

  private async waitUntilServing(releaseId: string): Promise<void> {
    const deadline = Date.now() + this.config.timing.startDeadlineMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      if (this.supervisor.release !== releaseId) throw new Error(`release ${releaseId} exited while starting`)
      try {
        await probeHealth({ ...(await this.probeTarget()) }, { releaseId, baseline: null })
        return
      } catch (error) {
        lastError = error
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    throw new NotServingInTime(`release ${releaseId} wasn't serving within ${this.config.timing.startDeadlineMs} ms: ${(lastError as Error | null)?.message ?? 'no answer'}`)
  }

  private startOurod(releaseId: string): void {
    this.watchdogClock = { startedAt: Date.now(), lastHealthyAt: null }
    this.supervisor.start(releaseId)
    this.logEvent('ourod_started', { release: releaseId, pid: this.supervisor.pid })
  }

  /** Tells the person, and whoever asked for the deploy. If the server can't take it, it stays in deployments.jsonl. */
  private async notify(text: string, requestedBy: string | null): Promise<void> {
    try {
      const answer = await this.askLocal('/v2/internal/system-notice', { text, alsoToAgent: requestedBy })
      if (answer.status !== 200) this.logEvent('notice_refused', { status: answer.status })
    } catch (error) {
      this.logEvent('notice_undelivered', { error: (error as Error).message })
    }
  }

  // Deploying

  enqueueDeploy(reference: string, requestedBy: string | null): Deployment {
    const deployment: Deployment = {
      id: randomBytes(6).toString('hex'),
      releaseId: null,
      commit: null,
      requestedBy,
      phase: 'queued',
      reason: null,
      startedAt: Date.now(),
      endedAt: null,
      startedTooSlowly: false,
    }
    this.deployments.set(deployment.id, deployment)
    // A newer deployment supersedes one still waiting.
    for (const waiting of this.deployQueue.splice(0)) this.record(waiting.deployment, 'superseded', `superseded by ${deployment.id}`)
    this.deployQueue.push({ deployment, reference })
    this.record(deployment, 'queued')
    void this.drainDeployQueue()
    return deployment
  }

  private async drainDeployQueue(): Promise<void> {
    if (this.deploying) return
    this.deploying = true
    try {
      for (;;) {
        const next = this.deployQueue.shift()
        if (!next) return
        const socket = hostHoldSocket({ ...process.env, ...this.config.ourodEnv })
        await holdingHostAwake(socket, 'ouro-guardian-deploy', () => this.deploy(next.deployment, next.reference))
      }
    } finally {
      this.deploying = false
    }
  }

  private isSuperseded(): boolean {
    return this.deployQueue.length > 0
  }

  private async deploy(deployment: Deployment, reference: string): Promise<void> {
    try {
      this.record(deployment, 'building')
      const commit = await resolveCommit(this.config.sourceDir, reference)
      deployment.commit = commit
      const releaseId = `${Date.now().toString(36)}-${commit.slice(0, 8)}`
      deployment.releaseId = releaseId
      await buildRelease({ sourceDir: this.config.sourceDir, commit, releaseDir: this.paths.releaseDir(releaseId) })
      const refusal = schemaRefusal(readDatabaseSchema(join(this.paths.dataDir, 'ouro.db')), readReleaseManifest(this.paths.releaseDir(releaseId)))
      if (refusal) {
        this.record(deployment, 'refused', refusal)
        await this.notify(`Your update wasn't deployed: ${refusal}. Nothing changed.`, deployment.requestedBy)
        return
      }
    } catch (error) {
      this.record(deployment, 'build_failed', (error as Error).message)
      await this.notify(`Your server update failed to build, so nothing changed. ${(error as Error).message.slice(0, 600)}`, deployment.requestedBy)
      return
    }
    if (this.isSuperseded()) return this.record(deployment, 'superseded', 'a newer deployment arrived')

    const releaseId = deployment.releaseId!
    this.record(deployment, 'verifying')
    try {
      await runAcceptance({
        releaseDir: this.paths.releaseDir(releaseId),
        workDir: this.paths.verifyDir(releaseId.slice(-8)),
        deadlineMs: this.config.timing.acceptanceDeadlineMs,
        env: {},
      })
    } catch (error) {
      this.record(deployment, 'verification_failed', (error as Error).message)
      await this.notify(`Your server update failed its checks before going live, so nothing changed. ${(error as Error).message.slice(0, 600)}`, deployment.requestedBy)
      return
    }
    if (this.isSuperseded()) return this.record(deployment, 'superseded', 'a newer deployment arrived')

    await this.switchTo(deployment, releaseId)
  }

  private async switchTo(deployment: Deployment, releaseId: string): Promise<void> {
    const previous = this.readPointer(this.paths.activePointer)
    const lastGood = this.readPointer(this.paths.lastGoodPointer)
    this.record(deployment, 'switching')

    let baseline: HealthBaseline | null = null
    if (previous && this.supervisor.release) {
      try {
        baseline = await takeBaseline(await this.probeTarget())
      } catch (error) {
        // The live release is unhealthy already, so there's nothing it can tell us. Moving away from it is not worse.
        this.logEvent('baseline_unavailable', { error: (error as Error).message })
      }
    }

    await this.supervisor.stop()
    this.writePointer(this.paths.activePointer, releaseId)
    this.startOurod(releaseId)

    this.record(deployment, 'confirming')
    const problem = await this.confirmHealthy(releaseId, baseline)
    if (problem === null) {
      this.writePointer(this.paths.lastGoodPointer, releaseId)
      this.record(deployment, 'live')
      const answer = await this.askLocal('/v2/internal/release-confirmed', {}).catch((error: Error) => ({ status: 0, body: error.message }))
      if (answer.status !== 200) this.logEvent('release_confirmation_undelivered', { answer })
      this.pruneReleases(releaseId)
      return
    }

    await this.rollBack(deployment, releaseId, problem, lastGood ?? previous, baseline)
  }

  /** Null if it stayed healthy through the whole window, otherwise what was wrong. */
  private async confirmHealthy(releaseId: string, baseline: HealthBaseline | null): Promise<LiveProblem | null> {
    try {
      await this.waitUntilServing(releaseId)
    } catch (error) {
      return { why: (error as Error).message, startedTooSlowly: error instanceof NotServingInTime }
    }
    const windowEnd = Date.now() + this.config.timing.steadyWindowMs
    let consecutiveFailures = 0
    let lastProblem = ''
    for (;;) {
      if (this.supervisor.release !== releaseId) return { why: `release ${releaseId} exited during its first minute`, startedTooSlowly: false }
      try {
        await probeHealth(await this.probeTarget(), { releaseId, baseline })
        consecutiveFailures = 0
      } catch (error) {
        consecutiveFailures++
        lastProblem = (error as Error).message
        if (consecutiveFailures >= PROBE_FAILURES_TO_ROLL_BACK) return { why: lastProblem, startedTooSlowly: false }
      }
      if (Date.now() >= windowEnd && consecutiveFailures === 0) return null
      await new Promise((done) => setTimeout(done, this.config.timing.steadyIntervalMs))
    }
  }

  private async rollBack(deployment: Deployment, failedRelease: string, liveProblem: LiveProblem, target: string | null, baseline: HealthBaseline | null): Promise<void> {
    const problem = liveProblem.why
    deployment.startedTooSlowly = liveProblem.startedTooSlowly
    this.logEvent('rolling_back', { from: failedRelease, to: target, problem })
    await this.supervisor.stop()
    if (!target) {
      this.record(deployment, 'rollback_unverified', `${problem}; there is no earlier release to go back to`)
      return
    }
    this.writePointer(this.paths.activePointer, target)
    this.startOurod(target)
    try {
      await this.waitUntilServing(target)
      await probeHealth(await this.probeTarget(), { releaseId: target, baseline })
    } catch (error) {
      const reason = `${problem}; the return to ${target} is unverified: ${(error as Error).message}`
      this.record(deployment, 'rollback_unverified', reason)
      await this.notify(`Your server update failed once live, and returning to the last good version couldn't be confirmed. ${reason}`, deployment.requestedBy)
      return
    }
    this.record(deployment, 'rolled_back', problem)
    await this.notify(
      `Your server update went live and turned out unhealthy, so the last good version is back. Why: ${problem}. The failed release is kept at ${this.paths.releaseDir(failedRelease)} (commit ${deployment.commit?.slice(0, 8)}), so it can be repaired and tried again.`,
      deployment.requestedBy,
    )
  }

  private pruneReleases(justConfirmed: string): void {
    const keep = new Set([justConfirmed, this.readPointer(this.paths.activePointer), this.readPointer(this.paths.lastGoodPointer)])
    const all = readdirSync(this.paths.releases).filter((name) => !name.endsWith('.building')).sort()
    const removable = all.filter((name) => !keep.has(name))
    for (const name of removable.slice(0, Math.max(0, removable.length - KEEP_RELEASES))) {
      rmSync(this.paths.releaseDir(name), { recursive: true, force: true })
    }
  }

  // Following a branch

  /** Every finished deployment, oldest first, as recorded: the record outlives restarts, the in-memory map doesn't. */
  private finishedDeployments(): Deployment[] {
    let text = ''
    try {
      text = readFileSync(this.paths.deployments, 'utf8')
    } catch {
      return []
    }
    return text.split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Deployment)
      .filter((deployment) => TERMINAL_PHASES.includes(deployment.phase))
  }

  /** The commit running now: the one its release was built from. */
  private liveCommit(finished: Deployment[]): string | null {
    const active = this.readPointer(this.paths.activePointer)
    return finished.findLast((deployment) => deployment.releaseId === active && deployment.commit !== null)?.commit ?? null
  }

  private lastAttemptOf(finished: Deployment[], commit: string): FinishedAttempt | null {
    const last = finished.findLast((deployment) => deployment.commit === commit)
    if (!last || last.endedAt === null) return null
    // Records from before this field was kept never started too slowly by this guardian's judgement.
    return { phase: last.phase, endedAt: last.endedAt, startedTooSlowly: last.startedTooSlowly === true }
  }

  /** One check at a time; a second asker waits for the one under way. */
  checkFollowed(): Promise<FollowCheck> {
    if (!this.followCheckInFlight) {
      this.followCheckInFlight = this.runFollowCheck().then((check) => {
        this.lastFollowCheck = { at: Date.now(), check }
        if (check.kind !== 'up_to_date' && check.kind !== 'not_following') this.logEvent('follow_check', { check })
        return check
      }).finally(() => { this.followCheckInFlight = null })
    }
    return this.followCheckInFlight
  }

  private async runFollowCheck(): Promise<FollowCheck> {
    const following = readFollowing(this.paths.following)
    if (!following) return { kind: 'not_following' }
    if (this.deploying || this.deployQueue.length > 0 || this.stopped) return { kind: 'busy' }
    let head: string
    try {
      head = await fetchHead(this.config.sourceDir, following)
    } catch (error) {
      return { kind: 'fetch_failed', following, error: (error as Error).message }
    }
    // A deploy may have started while the fetch ran.
    if (this.deploying || this.deployQueue.length > 0) return { kind: 'busy' }
    const finished = this.finishedDeployments()
    const step = followStep(head, this.liveCommit(finished), this.lastAttemptOf(finished, head), Date.now(), this.config.timing.followSlowRetryMs)
    if (step.kind !== 'deploy') return { following, head, ...step }
    const deployment = this.enqueueDeploy(head, null)
    return { following, head, kind: 'deploying', deploymentId: deployment.id }
  }

  /** Only a person sets this; null stops following. */
  async setFollowing(following: Following | null): Promise<FollowCheck> {
    if (following) await validateFollowing(this.config.sourceDir, following)
    writeFollowing(this.paths.following, following)
    this.logEvent('following', { following })
    return await this.checkFollowed()
  }

  // Watchdog

  private handleOurodExit(code: number | null): void {
    if (this.stopped) return
    this.logEvent('ourod_exited', { code })
    // During a deploy the deploy decides. Otherwise this is the crash the budget exists for.
    if (this.deploying) return
    this.restartWithinBudget(`it exited with code ${code}`)
  }

  private restartWithinBudget(why: string): void {
    const active = this.readPointer(this.paths.activePointer)
    if (!active) return
    this.takeFailureSnapshot(why)
    const answer = this.budget.trySpend(Date.now())
    if (!answer.allowed) {
      this.logEvent('restart_refused', { why, budget: answer.why })
      return
    }
    this.logEvent('restarting', { why, release: active })
    this.startOurod(active)
  }

  /** What was true at the failure: no conversation contents, only process and release facts. */
  private takeFailureSnapshot(why: string): void {
    const path = join(this.paths.failureSnapshots, `${Date.now()}.json`)
    let logTail = ''
    try {
      logTail = readFileSync(this.paths.ourodLog, 'utf8').slice(-4000)
    } catch { /* no log yet */ }
    writeFileSync(path, JSON.stringify({ at: Date.now(), why, active: this.readPointer(this.paths.activePointer), lastGood: this.readPointer(this.paths.lastGoodPointer), logTail }))
  }

  private async watchdogCheck(): Promise<void> {
    if (this.deploying || this.stopped) return
    const active = this.readPointer(this.paths.activePointer)
    if (!active || !this.supervisor.release) return
    try {
      await probeHealth(await this.probeTarget(), { releaseId: active, baseline: null })
      this.watchdogClock.lastHealthyAt = Date.now()
      return
    } catch (error) {
      const verdict = judgeFailedCheck(this.watchdogClock, Date.now(), this.config.timing)
      if (verdict.kind === 'starting') return
      this.logEvent('probe_failed', { outageMs: verdict.outageMs, error: (error as Error).message })
      if (verdict.kind === 'outage') return
    }
    // Sustained. Check once more, because restarting has a cost.
    try {
      await probeHealth(await this.probeTarget(), { releaseId: active, baseline: null })
      this.watchdogClock.lastHealthyAt = Date.now()
      return
    } catch (error) {
      const answer = this.budget.trySpend(Date.now())
      if (!answer.allowed) {
        this.logEvent('restart_refused', { budget: answer.why })
        return
      }
      this.takeFailureSnapshot(`sustained outage: ${(error as Error).message}`)
      this.logEvent('restarting', { why: 'sustained outage', release: active })
      await this.supervisor.stop()
      this.startOurod(active)
    }
  }

  // Control: only on a Unix socket in the person's own home. Agents reach it through the `ouro` command.

  private startControlSocket(): void {
    rmSync(this.paths.controlSocket, { force: true })
    this.control = createServer((incoming, outgoing) => {
      const reply = (status: number, body: unknown) => {
        outgoing.writeHead(status, { 'content-type': 'application/json' })
        outgoing.end(`${JSON.stringify(body)}\n`)
      }
      const url = new URL(incoming.url ?? '/', 'http://guardian.invalid')
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string | null | undefined> : {}
        if (incoming.method === 'GET' && url.pathname === '/status') {
          const active = this.readPointer(this.paths.activePointer)
          return reply(200, {
            active,
            activeCommit: active === null ? null : readReleaseCommit(this.paths.releaseDir(active)),
            lastGood: this.readPointer(this.paths.lastGoodPointer),
            ourodPid: this.supervisor.pid,
            serving: this.supervisor.release,
            deploying: this.deploying,
            following: readFollowing(this.paths.following),
            lastFollowCheck: this.lastFollowCheck,
          })
        }
        if (incoming.method === 'PUT' && url.pathname === '/following') {
          return void Promise.resolve().then(() => this.setFollowing(followingRequested(body.remote, body.branch))).then(
            (check) => reply(200, check),
            (error: Error) => reply(error instanceof FollowRefused ? 400 : 500, { error: error.message }),
          )
        }
        if (incoming.method === 'POST' && url.pathname === '/following/check') {
          return void this.checkFollowed().then((check) => reply(200, check), (error: Error) => reply(500, { error: error.message }))
        }
        if (incoming.method === 'POST' && url.pathname === '/deploy') {
          return reply(200, this.enqueueDeploy(body.reference ?? this.config.sourceBranch, body.requestedBy ?? null))
        }
        const deployment = /^\/deployments\/([0-9a-f]+)$/.exec(url.pathname)
        if (incoming.method === 'GET' && deployment) {
          const found = this.deployments.get(deployment[1]!)
          return found ? reply(200, found) : reply(404, { error: 'no such deployment' })
        }
        reply(404, { error: 'no such endpoint' })
      })
    })
    this.control.listen(this.paths.controlSocket)
  }
}
