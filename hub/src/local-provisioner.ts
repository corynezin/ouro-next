// Computers on the hub's own machine: each is a directory with the person's copy of the source, a runner host and a
// guardian on a port of its own, set up as `scripts/install-run-sprite.sh` sets up a Sprite. For development and
// journeys, and for a hub that hosts on one large machine. Computers outlive the hub: their processes are detached.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CommandOutput, Snapshot } from '@ouro/contract'
import { BASE_BRANCH } from './distribution.ts'
import type { ComputerOrder, Provisioner } from './provisioning.ts'
import type { PairingRecord } from './store.ts'

const execFileAsync = promisify(execFile)

export interface LocalProvisionerConfig {
  /** One directory per computer. Keep this path short: each computer's sockets are under it. */
  computersDir: string
  /** The git repository distribution commits are taken from. */
  distributionSource: string
  /** Run in a computer's new copy of the source to install its dependencies. */
  installCommand: string
  /** The host phones reach computers at; each computer has its own port. */
  publicHost: string
  /** Given to each computer's guardian as they are. */
  guardian: { ourodEnv: Record<string, string>; timing: Record<string, number> }
  /** How long a computer's first release may take to build, pass its checks and go live. */
  firstReleaseDeadlineMs: number
}

export const DEFAULT_INSTALL_COMMAND = 'npm ci --no-audit --no-fund --loglevel=error'

interface ComputerPaths {
  dir: string
  computerFile: string
  source: string
  home: string
  userHome: string
  stable: string
  config: string
  servicesFile: string
  installedLock: string
  logs: string
  pid(service: ServiceName): string
  log(service: ServiceName): string
  runnerHostSocket: string
  guardianSocket: string
  localSocket: string
}

type ServiceName = 'runner-host' | 'guardian'

/** Set at `create`, kept for the computer's life. */
interface ComputerFile {
  port: number
}

/** Set at `setup`: the stable copies the services run from, which releases never replace. */
interface ServicesFile {
  guardianDir: string
  runnerHostFile: string
}

interface GuardianStatus {
  active: string | null
  deploying: boolean
}

class LocalStepFailure extends Error {}

/** Services run without another Ouro's command shims, as the installer does. */
const servicePath = (): string => (process.env.PATH ?? '').split(':').filter((entry) => !entry.includes('.claude-inbox')).join(':')

/** A machine name as addresses use it: lowercase words and dashes. */
export function machineNameOf(label: string): string {
  const words = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return words.length > 0 ? words : 'computer'
}

async function run(command: string, args: string[], options: { cwd: string; what: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    throw new LocalStepFailure(`${options.what} failed: ${(failure.stderr || failure.message).trim().slice(-1500)}`)
  }
}

const git = (cwd: string, what: string, ...args: string[]) => run('git', ['-c', 'user.name=Ouro', '-c', 'user.email=ouro@invalid', ...args], { cwd, what })

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

function writeAtomically(path: string, text: string): void {
  writeFileSync(`${path}.partial`, text)
  renameSync(`${path}.partial`, path)
}

function socketRequest<T>(socketPath: string, method: string, path: string, body: object | null): Promise<T> {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode ?? 0) >= 300) return reject(new Error(`${method} ${path} answered ${response.statusCode}: ${text.slice(0, 500)}`))
        try {
          resolveRequest(JSON.parse(text) as T)
        } catch {
          reject(new Error(`${method} ${path} answered something unreadable: ${text.slice(0, 200)}`))
        }
      })
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error(`${method} ${path} timed out`)))
    outgoing.on('error', reject)
    outgoing.end(body ? JSON.stringify(body) : undefined)
  })
}

export class LocalProvisioner implements Provisioner {
  private readonly config: LocalProvisionerConfig

  constructor(config: LocalProvisionerConfig) {
    this.config = config
  }

  /** Where a computer's files are. Its services' pids are in files here, so whoever stops a computer stops only its own. */
  pathsOf(serverId: string): ComputerPaths {
    const dir = join(this.config.computersDir, serverId)
    const home = join(dir, 'g')
    return {
      dir,
      computerFile: join(dir, 'computer.json'),
      source: join(dir, 'source'),
      home,
      userHome: join(dir, 'home'),
      stable: join(dir, 'stable'),
      config: join(dir, 'guardian.json'),
      servicesFile: join(dir, 'services.json'),
      installedLock: join(dir, 'installed-lock'),
      logs: join(dir, 'logs'),
      pid: (service) => join(dir, `${service}.pid`),
      log: (service) => join(dir, 'logs', `${service}.log`),
      runnerHostSocket: join(home, 'runner-host.sock'),
      guardianSocket: join(home, 'guardian.sock'),
      localSocket: join(home, 'data', 'local.sock'),
    }
  }

  private computer(paths: ComputerPaths): ComputerFile {
    return JSON.parse(readFileSync(paths.computerFile, 'utf8')) as ComputerFile
  }

  async create(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    if (existsSync(paths.computerFile)) return
    for (const dir of [paths.dir, paths.home, paths.userHome, paths.stable, paths.logs]) mkdirSync(dir, { recursive: true })
    writeAtomically(paths.computerFile, `${JSON.stringify({ port: await freePort() } satisfies ComputerFile)}\n`)
  }

  async upload(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    if (existsSync(join(paths.source, '.git'))) return
    const partial = `${paths.source}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    // The person's own repository, which their agents edit: the starting commit, a root commit, with no remote. It is
    // also where `ouro-base` starts, so bases merge into the person's branch from there.
    await git(partial, 'making the source a repository', 'init', '-q', '-b', 'main')
    await git(partial, 'fetching Ouro', 'fetch', '-q', '--no-tags', this.config.distributionSource, order.distributionCommit)
    await git(partial, 'checking out Ouro', 'checkout', '-q', '-B', 'main', order.distributionCommit)
    await git(partial, 'starting the bases branch', 'branch', BASE_BRANCH, order.distributionCommit)
    renameSync(partial, paths.source)
  }

  async install(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    const lockFile = join(paths.source, 'package-lock.json')
    const lockHash = createHash('sha256').update(existsSync(lockFile) ? readFileSync(lockFile) : '').digest('hex')
    if (existsSync(paths.installedLock) && readFileSync(paths.installedLock, 'utf8') === lockHash) return
    await run('/bin/sh', ['-c', this.config.installCommand], { cwd: paths.source, what: 'installing dependencies', env: { PATH: servicePath(), HOME: paths.userHome } })
    writeAtomically(paths.installedLock, lockHash)
  }

  async setup(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    const guardianTree = await git(paths.source, 'finding the guardian', 'rev-parse', 'HEAD:guardian')
    const guardianDir = join(paths.stable, `guardian-${guardianTree}`)
    if (!existsSync(guardianDir)) {
      const partial = `${guardianDir}.partial`
      rmSync(partial, { recursive: true, force: true })
      mkdirSync(partial, { recursive: true })
      const archive = join(paths.stable, 'guardian.tar')
      await git(paths.source, 'exporting the guardian', 'archive', '--format=tar', `--output=${archive}`, 'HEAD:guardian')
      await run('tar', ['-xf', archive, '-C', partial], { cwd: paths.stable, what: 'unpacking the guardian' })
      rmSync(archive, { force: true })
      renameSync(partial, guardianDir)
    }
    const hostBlob = await git(paths.source, 'finding the runner host', 'rev-parse', 'HEAD:guardian/src/runner-host.ts')
    const runnerHostDir = join(paths.stable, `runner-host-${hostBlob}`)
    if (!existsSync(runnerHostDir)) {
      const partial = `${runnerHostDir}.partial`
      rmSync(partial, { recursive: true, force: true })
      mkdirSync(partial, { recursive: true })
      writeFileSync(join(partial, 'runner-host.ts'), await git(paths.source, 'exporting the runner host', 'show', 'HEAD:guardian/src/runner-host.ts'))
      writeFileSync(join(partial, 'package.json'), '{ "type": "module" }\n')
      renameSync(partial, runnerHostDir)
    }
    writeAtomically(paths.servicesFile, `${JSON.stringify({ guardianDir, runnerHostFile: join(runnerHostDir, 'runner-host.ts') } satisfies ServicesFile)}\n`)

    const { port } = this.computer(paths)
    writeAtomically(paths.config, `${JSON.stringify({
      home: paths.home,
      listenPort: port,
      sourceDir: paths.source,
      sourceBranch: 'main',
      machineName: machineNameOf(order.label),
      publicUrl: this.addressOf(port),
      ourodEnv: { ...this.config.guardian.ourodEnv, OURO_RUNNER_HOST_SOCKET: paths.runnerHostSocket },
      timing: this.config.guardian.timing,
    }, null, 2)}\n`)
  }

  async service(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    const services = JSON.parse(readFileSync(paths.servicesFile, 'utf8')) as ServicesFile
    // The runner host is given the releases directory by its real path: ourod names its runner entry that way.
    mkdirSync(join(paths.home, 'releases'), { recursive: true })
    if (!this.isRunning(paths, 'runner-host')) {
      rmSync(paths.runnerHostSocket, { force: true })
      this.startService(paths, 'runner-host', [services.runnerHostFile, paths.runnerHostSocket, realpathSync(join(paths.home, 'releases'))])
      await this.waitFor(paths, 'runner-host', 30_000, async () => existsSync(paths.runnerHostSocket))
    }
    if (!this.isRunning(paths, 'guardian')) {
      this.startService(paths, 'guardian', [join(services.guardianDir, 'src/main.ts'), paths.config])
    }
    await this.waitFor(paths, 'guardian', this.config.firstReleaseDeadlineMs, async () => {
      const status = await socketRequest<GuardianStatus>(paths.guardianSocket, 'GET', '/status', null).catch(() => null)
      if (status === null) return false
      if (status.active !== null && !status.deploying) return true
      if (status.active === null && !status.deploying) this.throwIfFirstReleaseFailed(paths)
      return false
    })
  }

  async address(order: ComputerOrder): Promise<string> {
    return this.addressOf(this.computer(this.pathsOf(order.serverId)).port)
  }

  async startPairing(order: ComputerOrder): Promise<PairingRecord> {
    const paths = this.pathsOf(order.serverId)
    const started = await socketRequest<CommandOutput<'start_pairing'>>(paths.localSocket, 'POST', '/v2/commands/start_pairing', {
      idempotencyKey: `hub-pairing-${order.serverId}-${Date.now()}`,
      input: { inviteePersonName: null },
    })
    return { code: started.code, expiresAt: started.expiresAt }
  }

  async hasPairedPhone(order: ComputerOrder): Promise<boolean> {
    const snapshot = await socketRequest<Snapshot>(this.pathsOf(order.serverId).localSocket, 'GET', '/v2/snapshot', null)
    return snapshot.devices.some((device) => device.personId === snapshot.viewer.personId)
  }

  /** Stops this computer's own services, by the pids it recorded, and removes its files. */
  async destroy(order: ComputerOrder): Promise<void> {
    const paths = this.pathsOf(order.serverId)
    for (const service of ['guardian', 'runner-host'] as const) {
      if (this.isRunning(paths, service)) process.kill(Number(readFileSync(paths.pid(service), 'utf8')), 'SIGTERM')
    }
    rmSync(paths.dir, { recursive: true, force: true })
  }

  private addressOf(port: number): string {
    return `http://${this.config.publicHost}:${port}`
  }

  /** Whether the service's recorded process is alive and is this computer's. */
  private isRunning(paths: ComputerPaths, service: ServiceName): boolean {
    let pid: number
    try {
      pid = Number(readFileSync(paths.pid(service), 'utf8'))
      process.kill(pid, 0)
    } catch {
      return false
    }
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(paths.dir)
    } catch {
      // No /proc here: a live process with the recorded pid is taken as the service.
      return true
    }
  }

  private startService(paths: ComputerPaths, service: ServiceName, args: string[]): void {
    const log = openSync(paths.log(service), 'a')
    const child = spawn(process.execPath, ['--no-warnings', ...args], {
      cwd: paths.dir,
      detached: true,
      stdio: ['ignore', log, log],
      env: { PATH: servicePath(), HOME: paths.userHome },
    })
    child.unref()
    writeAtomically(paths.pid(service), String(child.pid))
  }

  private async waitFor(paths: ComputerPaths, service: ServiceName, timeoutMs: number, ready: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await ready()) return
      if (!this.isRunning(paths, service)) throw new LocalStepFailure(`the ${service} stopped: ${this.logTail(paths, service)}`)
      await new Promise((done) => setTimeout(done, 250))
    }
    throw new LocalStepFailure(`the ${service} wasn't ready within ${timeoutMs} ms: ${this.logTail(paths, service)}`)
  }

  private throwIfFirstReleaseFailed(paths: ComputerPaths): void {
    const deployments = join(paths.home, 'guardian/deployments.jsonl')
    if (!existsSync(deployments)) return
    const records = readFileSync(deployments, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { phase: string; reason: string | null; endedAt: number | null })
    const last = records.at(-1)
    if (last && last.endedAt !== null && last.phase !== 'live') throw new LocalStepFailure(`its first release ended ${last.phase}: ${last.reason ?? 'no reason given'}`)
  }

  private logTail(paths: ComputerPaths, service: ServiceName): string {
    try {
      return readFileSync(paths.log(service), 'utf8').slice(-1500)
    } catch {
      return 'no log'
    }
  }
}
