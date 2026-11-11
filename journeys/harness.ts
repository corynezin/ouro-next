// Runs the real server and real runners as real processes, each run in its own directory, and cleans up only what it
// started. A journey talks to the server the way the app and agents do: HTTP for the app, the `ouro` command for the rest.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AttachmentRef, commands, SearchPage, Snapshot, SummaryPage, SyncFrame } from '@ouro/contract'
import type { AgentEntity, Change, CommandName, CommandOutput, ErrorResponse, HistoryPage, MessageEntity } from '@ouro/contract'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { runnerSocketDirOf } from '../server/src/adapters/paths.ts'
import { holdJourneyLock, MACHINE_JOURNEY_LOCK } from '../tools/journey-lock.ts'

// One journey process at a time on this machine, whoever runs it: see tools/journey-lock.ts.
await holdJourneyLock({
  path: MACHINE_JOURNEY_LOCK,
  pollMs: 500,
  onWait: (holder) => process.stderr.write(`waiting for the machine's journey lock (${MACHINE_JOURNEY_LOCK}), held by ${holder ? `pid ${holder.pid}: ${holder.command}` : 'a process starting up'}\n`),
})

const execFileAsync = promisify(execFile)

// The tools of the live system this build runs alongside must not be reachable from anything a journey starts.
const isolatedPath = (process.env.PATH ?? '').split(':').filter((entry) => !entry.includes('.claude-inbox')).join(':')
const repoRoot = resolve(import.meta.dirname, '..')

export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

export interface StartedServer {
  /** From launching the process to answering, as seen from outside. */
  wallMs: number
  /** The server's own measure, from its first line of code. */
  listening: { elapsedMs: number }
}

export class JourneyRun {
  readonly dir: string
  readonly dataDir: string
  readonly homeDir: string
  readonly barrierDir: string
  readonly clockFile: string
  private readonly shortLink: string
  private server: ChildProcess | null = null
  private port = 0
  private readonly extraEnv: Record<string, string>
  private serverLog = ''

  constructor(options: { env?: Record<string, string> } = {}) {
    const id = randomBytes(4).toString('hex')
    this.dir = join(repoRoot, 'runs', `j-${id}`)
    mkdirSync(this.dir, { recursive: true })
    // Sockets live under the data directory, and a socket path has a limit of about 104 bytes: reach it through a short
    // link, so a checkout at a long path still works. The files stay in `dir`.
    this.shortLink = join('/tmp', `ouro-j-${id}`)
    symlinkSync(this.dir, this.shortLink)
    this.dataDir = join(this.shortLink, 'data')
    this.homeDir = join(this.dir, 'home')
    this.barrierDir = join(this.dir, 'barriers')
    this.clockFile = join(this.dir, 'clock-offset-ms')
    for (const dir of [this.dataDir, this.homeDir, this.barrierDir]) mkdirSync(dir, { recursive: true })
    this.extraEnv = { ...options.env }
  }

  /** For settings that live in the run's own directory, such as key files: they apply from the next start. */
  addServerEnv(env: Record<string, string>): void {
    Object.assign(this.extraEnv, env)
  }

  /** Every structured line the server has printed, in order. */
  serverEvents(): Array<Record<string, unknown> & { event: string }> {
    return this.serverLog.split('\n').flatMap((line) => {
      if (!line.startsWith('{')) return []
      try {
        return [JSON.parse(line) as Record<string, unknown> & { event: string }]
      } catch {
        return []
      }
    })
  }

  /** The stand-in accounts: see standInIntegrationTools. */
  get accountsDir(): string {
    return join(this.dir, 'accounts')
  }

  /** The stand-in Tailscale: see standInTailscale. */
  get tailscaleDir(): string {
    return join(this.dir, 'tailscale')
  }

  get url(): string {
    return this.frontDoor ?? `http://127.0.0.1:${this.port}`
  }

  /** The port the server itself listens on, once started. */
  get serverPort(): number {
    return this.port
  }

  get serverPid(): number | null {
    return this.server?.pid ?? null
  }

  private frontDoor: string | null = null

  /** Everything from outside, the app and other computers, reaches the server through `url`, such as a host's own
   * front door. */
  reachThrough(url: string): void {
    this.frontDoor = url
    this.addServerEnv({ OURO_PEER_ADDRESS: url })
  }

  private cliEnv(): NodeJS.ProcessEnv {
    return { PATH: isolatedPath, HOME: this.homeDir, OURO_SOCKET: join(this.dataDir, 'local.sock'), OURO_CLI_RETRY_MS: '30000' }
  }

  async startServer(): Promise<StartedServer> {
    assert.equal(this.server, null, 'a server is already running in this run')
    if (this.port === 0) this.port = await freePort()
    const launchedAt = performance.now()
    const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'server/src/bin/ourod.ts')], {
      env: {
        PATH: isolatedPath,
        HOME: this.homeDir,
        OURO_DATA: this.dataDir,
        OURO_APP_LISTEN: `tcp:${this.port}`,
        OURO_PEER_ADDRESS: `http://127.0.0.1:${this.port}`,
        OURO_MACHINE_NAME: 'journey',
        OURO_DEFAULT_MODEL: 'stand-in',
        OURO_DEFAULT_FOLDER: join(this.dir, 'work'),
        OURO_CLOCK_FILE: this.clockFile,
        OURO_TICK_MS: '100',
        // Never this Sprite's own hold: a journey that sleeps brings its own host.
        OURO_HOST_HOLD: 'none',
        OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_STANDIN_BARRIERS: this.barrierDir, OURO_CLI_RETRY_MS: '60000' }),
        // Never this machine's real accounts.
        OURO_INTEGRATIONS_STAND_IN_DIR: this.accountsDir,
        // Never this machine's network.
        OURO_TAILSCALE_STAND_IN_DIR: this.tailscaleDir,
        ...this.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.server = child
    let stdout = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      this.serverLog += chunk.toString()
    })
    child.stderr!.on('data', (chunk: Buffer) => { this.serverLog += chunk.toString() })
    // When it doesn't listen in time, what it printed is the only clue to why (seen only on a loaded CI machine).
    const listening = await waitFor('the server to listen', () => {
      if (child.exitCode !== null) throw new Error(`ourod exited with ${child.exitCode}:\n${this.serverLog}`)
      const line = stdout.split('\n').find((text) => text.includes('"event":"listening"'))
      return line ? JSON.parse(line) as { elapsedMs: number } : null
    }).catch((error: Error) => {
      if (child.exitCode !== null) throw error
      throw new Error(`${error.message} (pid ${child.pid}, ${Math.round(performance.now() - launchedAt)} ms after launch); it printed:\n${this.serverLog.slice(-4000) || '(nothing)'}`)
    })
    await waitFor('the server to answer', async () => (await fetch(`${this.url}/v2/identity`).catch(() => null))?.status === 200, 20_000)
    return { wallMs: Math.round(performance.now() - launchedAt), listening }
  }

  async killServer(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const child = this.server
    if (!child) return
    this.server = null
    const exited = new Promise((done) => child.once('exit', done))
    child.kill(signal)
    await exited
  }

  log(): string {
    return this.serverLog
  }

  /** The real command-line client. Rejects if it exits non-zero. */
  async cli(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(join(repoRoot, 'server/bin/ouro'), args, { env: this.cliEnv() })
    return stdout
  }

  /** `ouro pair` as a shell command that prints only the code: what the fake hub runs for a ready server's pairing. */
  pairCodeCommand(): string {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const env = Object.entries(this.cliEnv()).map(([name, value]) => `${name}=${quote(String(value))}`).join(' ')
    return `env ${env} ${quote(join(repoRoot, 'server/bin/ouro'))} pair | sed -n 's/^code: //p'`
  }

  // The app's side

  async pairDevice(deviceName = 'test-phone'): Promise<AppClient> {
    const output = await this.cli('pair')
    const code = /code: (\S+)/.exec(output)![1]!
    const response = await fetch(`${this.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName }) })
    assert.equal(response.status, 200)
    const paired = await response.json() as { deviceToken: string; deviceId: string }
    return new AppClient(this, paired.deviceToken, paired.deviceId)
  }

  // Test controls

  /** An agent's prompt cache lifetime, read from the server's database: the app isn't shown it. */
  promptCacheLifetimeOf(agentName: string): string | null {
    const db = new DatabaseSync(join(this.dataDir, 'ouro.db'), { readOnly: true })
    try {
      const row = db.prepare("SELECT prompt_cache_lifetime FROM agents WHERE name = ? AND state_name NOT IN ('moved', 'archived')").get(agentName) as { prompt_cache_lifetime: string } | undefined
      return row?.prompt_cache_lifetime ?? null
    } finally {
      db.close()
    }
  }

  /** With the server stopped: an agent's failed messages put back in its queue, as releases before failures were kept
   * left a crash loop's messages. */
  leaveFailedDeliveriesQueued(agentName: string): void {
    const db = new DatabaseSync(join(this.dataDir, 'ouro.db'))
    try {
      const queued = JSON.stringify({ state: 'queued', since: Date.now(), possiblySeen: true })
      db.prepare("UPDATE deliveries SET state_name = 'queued', state_json = ? WHERE state_name = 'failed' AND agent_id IN (SELECT id FROM agents WHERE name = ?)").run(queued, agentName)
      db.prepare('UPDATE agents SET last_turn_failure_json = NULL WHERE name = ?').run(agentName)
    } finally {
      db.close()
    }
  }

  barrierReached(name: string): boolean {
    return existsSync(join(this.barrierDir, `${name}.reached`))
  }

  releaseBarrier(name: string): void {
    writeFileSync(join(this.barrierDir, `${name}.release`), '')
  }

  advanceClock(byMs: number): void {
    const current = existsSync(this.clockFile) ? Number(readFileSync(this.clockFile, 'utf8')) : 0
    writeFileSync(this.clockFile, String(current + byMs))
  }

  /** PID of this run's runner for an agent and generation, from the process table, by its config path. */
  async runnerPid(agentId: string, generation: number): Promise<number | null> {
    const configPath = join(this.dataDir, 'agents', agentId, `runner-${generation}.json`)
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    const line = stdout.split('\n').find((text) => text.includes(configPath))
    return line ? Number(line.trim().split(/\s+/)[0]) : null
  }

  private async liveRunnerPids(): Promise<number[]> {
    const agentsDir = join(this.dataDir, 'agents')
    if (!existsSync(agentsDir)) return []
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    return stdout.split('\n').filter((line) => line.includes(agentsDir)).map((line) => Number(line.trim().split(/\s+/)[0]))
  }

  /** Stops only what this run started, then removes its directory. */
  async cleanup(): Promise<void> {
    await this.killServer('SIGKILL')
    for (const pid of await this.liveRunnerPids()) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    rmSync(runnerSocketDirOf(this.dataDir), { recursive: true, force: true })
    rmSync(this.dir, { recursive: true, force: true })
    rmSync(this.shortLink, { force: true })
  }

  /** How many other run directories exist, for checking that parallel runs don't clean up each other. */
  static runDirectoryCount(): number {
    const runs = join(repoRoot, 'runs')
    return existsSync(runs) ? readdirSync(runs).length : 0
  }
}

const RETRYABLE_WINDOW_MS = 30_000

export class CommandFailed extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(`${code}: ${message}`)
    this.status = status
    this.code = code
  }
}

export class AppClient {
  readonly run: { url: string }
  readonly token: string
  readonly deviceId: string
  private keyCounter = 0

  constructor(run: { url: string }, token: string, deviceId: string) {
    this.run = run
    this.token = token
    this.deviceId = deviceId
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` }
  }

  /**
   * Like the app: a refusal marked retryable, or a connection that dropped, is tried again for a bounded time. Only those:
   * any other failure fails the journey.
   */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const deadline = Date.now() + RETRYABLE_WINDOW_MS
    for (;;) {
      let response: Response | null = null
      try {
        response = await fetch(`${this.run.url}${path}`, { ...init, headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) } })
      } catch (error) {
        if (Date.now() > deadline) throw error
      }
      if (response) {
        if (response.status !== 503) return response
        const body = await response.clone().json().catch(() => null) as ErrorResponse | null
        if (!body?.error.retryable || Date.now() > deadline) return response
      }
      await new Promise((done) => setTimeout(done, 100))
    }
  }

  async snapshot(): Promise<Snapshot> {
    const response = await this.request('/v2/snapshot')
    if (response.status !== 200) throw new CommandFailed(response.status, 'snapshot', await response.text())
    return Snapshot.parse(await response.json())
  }

  async command<N extends CommandName>(name: N, input: unknown, idempotencyKey = `journey-key-${randomBytes(6).toString('hex')}-${this.keyCounter++}`): Promise<CommandOutput<N>> {
    const response = await this.request(`/v2/commands/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey, input }),
    })
    const body = await response.json() as unknown
    if (response.status !== 200) {
      const { error } = body as ErrorResponse
      throw new CommandFailed(response.status, error.code, error.message)
    }
    // Contract tier: every server answer is validated against the contract.
    return commands[name].output.parse(body) as CommandOutput<N>
  }

  async history(chatId: string, before?: number, limit = 50): Promise<HistoryPage> {
    const query = new URLSearchParams({ limit: String(limit), ...(before === undefined ? {} : { before: String(before) }) })
    const response = await this.request(`/v2/chats/${chatId}/messages?${query}`)
    assert.equal(response.status, 200)
    return await response.json() as HistoryPage
  }

  async summaries(agentId: string, before?: number, limit = 20): Promise<SummaryPage> {
    const query = new URLSearchParams({ limit: String(limit), ...(before === undefined ? {} : { before: String(before) }) })
    const response = await this.request(`/v2/agents/${agentId}/summaries?${query}`)
    assert.equal(response.status, 200)
    return SummaryPage.parse(await response.json())
  }

  /** A page of the log of an agent on another computer, read through this server: its status and body. */
  async remoteLog(remoteAgentId: string, position: { after?: number; before?: number } = {}): Promise<{ status: number; body: unknown }> {
    const query = new URLSearchParams(Object.entries(position).map(([key, value]): [string, string] => [key, String(value)]))
    const response = await this.request(`/v2/remote-agents/${encodeURIComponent(remoteAgentId)}/log?${query}`)
    return { status: response.status, body: await response.json() }
  }

  async search(query: string, limit?: number): Promise<SearchPage> {
    const params = new URLSearchParams({ q: query, ...(limit === undefined ? {} : { limit: String(limit) }) })
    const response = await this.request(`/v2/search?${params}`)
    assert.equal(response.status, 200)
    return SearchPage.parse(await response.json())
  }

  /** Uploads a file for a message, as the phone does. Returns the status and, when it's taken, the attachment. */
  async upload(fileName: string, bytes: Uint8Array, mimeType: string): Promise<{ status: number; attachment: AttachmentRef | null }> {
    const response = await this.request('/v2/attachments', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(fileName), 'content-type': mimeType }, body: new Uint8Array(bytes) })
    if (response.status !== 200) {
      await response.body?.cancel()
      return { status: response.status, attachment: null }
    }
    return { status: response.status, attachment: AttachmentRef.parse(await response.json()) }
  }

  async download(attachmentId: string): Promise<Buffer> {
    const response = await this.request(`/v2/attachments/${attachmentId}`)
    assert.equal(response.status, 200)
    return Buffer.from(await response.arrayBuffer())
  }

  /** An account route: they carry secrets, so they aren't commands. */
  async integration(method: 'GET' | 'POST' | 'DELETE', action: string, body?: object): Promise<{ status: number; body: unknown }> {
    const response = await this.request(`/v2/integrations/${action}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }

  /** This server's Tailscale: GET reads it, POST connects, DELETE removes. */
  async tailscale(method: 'GET' | 'POST' | 'DELETE'): Promise<{ status: number; body: unknown }> {
    const response = await this.request('/v2/tailscale', { method })
    return { status: response.status, body: await response.json() }
  }

  async agent(name: string): Promise<AgentEntity> {
    const snapshot = await this.snapshot()
    const found = snapshot.agents.find((agent) => agent.name === name && agent.state.state !== 'archived')
    assert.ok(found, `no agent named ${name}`)
    return found
  }

  async directChatWith(agentName: string): Promise<string> {
    const snapshot = await this.snapshot()
    const chat = snapshot.chats.find((candidate) => candidate.kind === 'direct'
      && candidate.members.some((member) => member.address === snapshot.viewer.address)
      && candidate.members.some((member) => member.address === agentName))
    assert.ok(chat, `no direct chat with ${agentName}`)
    return chat.id
  }

  /** The messages of a direct chat, oldest first. */
  async conversation(agentName: string): Promise<MessageEntity[]> {
    return (await this.history(await this.directChatWith(agentName))).messages
  }

  /** Reads `/v2/changes` the way the app does, collecting frames until closed. */
  openChanges(after: number, epoch: string): ChangeStream {
    return new ChangeStream(`${this.run.url}/v2/changes?epoch=${epoch}&after=${after}`, this.headers)
  }
}

export class ChangeStream {
  readonly frames: SyncFrame[] = []
  closedWith: string | null = null
  private readonly abort = new AbortController()

  constructor(url: string, headers: Record<string, string>) {
    void this.read(url, headers)
  }

  private async read(url: string, headers: Record<string, string>): Promise<void> {
    try {
      const response = await fetch(url, { headers, signal: this.abort.signal })
      if (response.status !== 200 || !response.body) {
        this.closedWith = `status ${response.status}`
        return
      }
      let buffered = ''
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += Buffer.from(chunk).toString('utf8')
        for (;;) {
          const boundary = buffered.indexOf('\n\n')
          if (boundary < 0) break
          const event = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          const data = event.split('\n').find((line) => line.startsWith('data: '))
          if (data) this.frames.push(SyncFrame.parse(JSON.parse(data.slice('data: '.length))))
        }
      }
      this.closedWith = 'ended'
    } catch (error) {
      this.closedWith = `error: ${(error as Error).message}`
    }
  }

  changes(): Change[] {
    return this.frames.flatMap((frame) => (frame.frame === 'change' ? [frame.change] : []))
  }

  close(): void {
    this.abort.abort()
  }
}

export const standInScript = (...steps: object[]): string => `standin:${JSON.stringify(steps)}`
