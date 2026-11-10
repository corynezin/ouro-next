// A guardian over a private source repository, as on a person's machine: their own copy of the source, edited by commits.
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runnerSocketDirOf } from '../server/src/adapters/paths.ts'
import { AppClient, freePort, waitFor } from './harness.ts'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')
const isolatedPath = (process.env.PATH ?? '').split(':').filter((entry) => !entry.includes('.claude-inbox')).join(':')

export interface DeploymentRecord { id: string; phase: string; reason: string | null; releaseId: string | null; commit: string | null; requestedBy: string | null; startedTooSlowly: boolean; endedAt: number | null }

export const fastTiming = {
  probeTimeoutMs: 5_000,
  steadyWindowMs: 2_500,
  steadyIntervalMs: 400,
  startDeadlineMs: 20_000,
  stopGraceMs: 5_000,
  watchdogIntervalMs: 500,
  coldStartGraceMs: 1_500,
  sustainedOutageMs: 1_500,
  acceptanceDeadlineMs: 40_000,
  followCheckMs: 1_000,
  followSlowRetryMs: 15_000,
}

export class GuardianRun {
  readonly dir: string
  readonly home: string
  readonly source: string
  readonly barrierDir: string
  port = 0
  private guardian: ChildProcess | null = null
  private runnerHost: ChildProcess | null = null
  output = ''
  /** More of ourod's environment, set before `start`. */
  extraOurodEnv: Record<string, string> = {}

  /** A short path to `dir`. Unix socket paths have a limit of about 104 bytes, and the guardian's nest deeply under its
   * home; a checkout at a long path would otherwise fail to listen. The files stay in `dir`. */
  private readonly shortLink: string

  /** The guardian's timing: `fastTiming`, with any of it changed for one journey. */
  readonly timing: typeof fastTiming

  constructor(options: { timing?: Partial<typeof fastTiming> } = {}) {
    this.timing = { ...fastTiming, ...options.timing }
    const id = randomBytes(4).toString('hex')
    this.dir = join(repoRoot, 'runs', `g-${id}`)
    mkdirSync(this.dir, { recursive: true })
    this.shortLink = join('/tmp', `ouro-g-${id}`)
    symlinkSync(this.dir, this.shortLink)
    this.home = join(this.shortLink, 'g')
    this.source = join(this.dir, 'src')
    this.barrierDir = join(this.dir, 'barriers')
    for (const dir of [this.home, this.source, this.barrierDir]) mkdirSync(dir, { recursive: true })
  }

  /** The releases directory without the short link: ourod names its runner entry by its real path (Node resolves
   * symlinks in `import.meta.dirname`), so the host must serve that path. */
  private get realReleasesDir(): string {
    return join(this.dir, 'g', 'releases')
  }

  /** Whether a process command line is this run's: it names either path to the run. */
  private isOurs(commandLine: string): boolean {
    return commandLine.includes(this.dir) || commandLine.includes(this.shortLink)
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get dataDir(): string {
    return join(this.home, 'data')
  }

  /** The person's copy of the source: this working tree's server and contract, as one commit. */
  async createSource(): Promise<void> {
    for (const part of ['server', 'packages/contract']) cpSync(join(repoRoot, part), join(this.source, part), { recursive: true })
    symlinkSync(join(repoRoot, 'node_modules'), join(this.source, 'node_modules'))
    writeFileSync(join(this.source, '.gitignore'), 'node_modules\n')
    await this.git('init', '-q', '-b', 'main')
    await this.commitAll('the starting point')
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-c', 'user.name=journey', '-c', 'user.email=journey@invalid', ...args], { cwd: this.source })
    return stdout
  }

  async commitAll(message: string): Promise<string> {
    await this.git('add', '-A')
    await this.git('commit', '-q', '-m', message)
    return (await this.git('rev-parse', 'HEAD')).trim()
  }

  editSource(relativePath: string, from: string, to: string): void {
    const path = join(this.source, relativePath)
    const text = readFileSync(path, 'utf8')
    if (!text.includes(from)) throw new Error(`${relativePath} doesn't contain the text to replace`)
    writeFileSync(path, text.replace(from, to))
  }

  get runnerHostSocket(): string {
    return join(this.home, 'runner-host.sock')
  }

  /** As installed: runners start in a separate service, so they aren't the guardian's descendants. */
  async startRunnerHost(): Promise<number> {
    const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'guardian/src/runner-host.ts'), this.runnerHostSocket, this.realReleasesDir], {
      env: { PATH: isolatedPath, HOME: join(this.dir, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
    this.runnerHost = child
    await waitFor('the runner host to listen', () => {
      if (child.exitCode !== null) throw new Error(`the runner host exited: ${output}`)
      return output.includes('"event":"runner_host_listening"')
    })
    return child.pid!
  }

  /** What a service restart does on a Sprite: the guardian and every process under it are killed, detached or not. */
  async killGuardianService(): Promise<number[]> {
    const guardian = this.guardian!
    const exited = new Promise((done) => guardian.once('exit', done))
    const doomed = [guardian.pid!, ...await descendantsOf(guardian.pid!)]
    for (const pid of doomed) {
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
    await exited
    this.guardian = null
    this.output = ''
    return doomed
  }

  async start(): Promise<void> {
    if (this.port === 0) this.port = await freePort()
    const configPath = join(this.dir, 'guardian.json')
    writeFileSync(configPath, JSON.stringify({
      home: this.home,
      listenPort: this.port,
      sourceDir: this.source,
      sourceBranch: 'main',
      machineName: 'journey',
      ourodEnv: {
        OURO_DEFAULT_MODEL: 'stand-in',
        OURO_DEFAULT_FOLDER: join(this.dir, 'work'),
        OURO_TICK_MS: '100',
        OURO_HOST_HOLD: 'none',
        OURO_INTEGRATIONS_STAND_IN_DIR: join(this.dir, 'accounts'),
        OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_STANDIN_BARRIERS: this.barrierDir, OURO_CLI_RETRY_MS: '120000' }),
        ...(this.runnerHost ? { OURO_RUNNER_HOST_SOCKET: this.runnerHostSocket } : {}),
        ...this.extraOurodEnv,
      },
      timing: this.timing,
    }))
    const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'guardian/src/main.ts'), configPath], {
      env: { PATH: isolatedPath, HOME: join(this.dir, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    child.stderr!.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.guardian = child
    await waitFor('the guardian to listen', () => {
      if (child.exitCode !== null) throw new Error(`the guardian exited: ${this.output}`)
      return this.output.includes('"event":"listening"')
    })
  }

  cliEnv(): NodeJS.ProcessEnv {
    return { PATH: isolatedPath, HOME: join(this.dir, 'home'), OURO_SOCKET: join(this.dataDir, 'local.sock'), OURO_GUARDIAN_SOCKET: join(this.home, 'guardian.sock'), OURO_CLI_RETRY_MS: '60000' }
  }

  async cli(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(join(this.home, 'bin/ouro'), args, { env: this.cliEnv() })
    return stdout
  }

  async control(method: string, path: string, body: object | null = null): Promise<unknown> {
    return await new Promise((resolvePromise, reject) => {
      const outgoing = request({ socketPath: join(this.home, 'guardian.sock'), method, path, headers: { 'content-type': 'application/json' } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      })
      outgoing.on('error', reject)
      outgoing.end(body ? JSON.stringify(body) : undefined)
    })
  }

  async status(): Promise<{ active: string | null; activeCommit: string | null; lastGood: string | null; ourodPid: number | null; deploying: boolean }> {
    return await this.control('GET', '/status') as { active: string | null; activeCommit: string | null; lastGood: string | null; ourodPid: number | null; deploying: boolean }
  }

  deployments(): DeploymentRecord[] {
    const path = join(this.home, 'guardian/deployments.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as DeploymentRecord)
  }

  /** The final record of a deployment, once it reaches a terminal phase. */
  async deploymentOutcome(id: string, timeoutMs = 150_000): Promise<DeploymentRecord> {
    const terminal = ['live', 'build_failed', 'verification_failed', 'refused', 'superseded', 'rolled_back', 'rollback_unverified']
    return await waitFor(`deployment ${id} to finish`, () => this.deployments().filter((record) => record.id === id && terminal.includes(record.phase)).at(-1), timeoutMs)
  }

  async waitForFirstRelease(): Promise<DeploymentRecord> {
    const first = await waitFor('the first deployment', () => this.deployments()[0])
    return await this.deploymentOutcome(first.id)
  }

  async pairDevice(): Promise<AppClient> {
    const output = await this.cli('pair')
    const code = /code: (\S+)/.exec(output)![1]!
    const response = await fetch(`${this.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'journey-phone' }) })
    const paired = await response.json() as { deviceToken: string; deviceId: string }
    return new AppClient({ url: this.url } as never, paired.deviceToken, paired.deviceId)
  }

  barrierReached(name: string): boolean {
    return existsSync(join(this.barrierDir, `${name}.reached`))
  }

  releaseBarrier(name: string): void {
    writeFileSync(join(this.barrierDir, `${name}.release`), '')
  }

  /** Each runner of this run, with the process that started it. */
  async runnerParents(): Promise<Map<number, number>> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='])
    const runners = stdout.split('\n').filter((line) => this.isOurs(line) && line.includes('/runner-'))
    return new Map(runners.map((line) => line.trim().split(/\s+/)).map(([pid, ppid]) => [Number(pid), Number(ppid)]))
  }

  async runnerPids(): Promise<number[]> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    return stdout.split('\n').filter((line) => this.isOurs(line) && line.includes('/runner-')).map((line) => Number(line.trim().split(/\s+/)[0]))
  }

  async cleanup(): Promise<void> {
    const child = this.guardian
    if (child && child.exitCode === null) {
      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (this.runnerHost && this.runnerHost.exitCode === null) this.runnerHost.kill('SIGKILL')
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    for (const line of stdout.split('\n').filter((text) => this.isOurs(text))) {
      const pid = Number(line.trim().split(/\s+/)[0])
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
    rmSync(runnerSocketDirOf(this.dataDir), { recursive: true, force: true })
    rmSync(this.dir, { recursive: true, force: true })
    rmSync(this.shortLink, { force: true })
  }
}

async function descendantsOf(root: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))) {
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid!])
  }
  const found: number[] = []
  const pending = [root]
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) {
      found.push(child)
      pending.push(child)
    }
  }
  return found
}
