// Starts runners and talks to them. `ourod` restarts don't touch them: they run detached in their own process group and
// are found again by their config path. A socket closing says nothing by itself, so the process table is what confirms a
// runner is gone.
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { DataPaths } from './paths.ts'
import type { RunnerCommand, RunnerConfig, RunnerNotice } from './runner-protocol.ts'

export interface RunnerCallbacks {
  /** The runner's journal has more to read. */
  journalGrew(agentId: string, generation: number): void
  /** The connection closed. The runner may or may not be gone; ask `findRunnerProcess`. */
  disconnected(agentId: string, generation: number): void
}

interface RunnerConnection {
  generation: number
  socket: Socket
  connected: boolean
}

const CONNECT_PATIENCE_MS = 5_000
const CONNECT_RETRY_MS = 40

export function findRunnerProcess(configPath: string): { pid: number } | null {
  const table = execFileSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, stat, command] = match
    if (stat!.startsWith('Z')) continue
    if (command!.includes(configPath)) return { pid: Number(pid) }
  }
  return null
}

export class RunnerSupervisor {
  private readonly connections = new Map<string, RunnerConnection>()
  private readonly paths: DataPaths
  private readonly runnerEntry: string
  private readonly callbacks: RunnerCallbacks

  /** Where the runner host listens, when runners must outlive this process's service (see guardian/src/runner-host.ts). */
  private readonly runnerHostSocket: string | null

  constructor(paths: DataPaths, runnerEntry: string, callbacks: RunnerCallbacks, runnerHostSocket: string | null = null) {
    this.runnerHostSocket = runnerHostSocket
    this.paths = paths
    this.runnerEntry = runnerEntry
    this.callbacks = callbacks
  }

  launch(config: RunnerConfig): void {
    const configPath = this.paths.runnerConfig(config.agentId, config.generation)
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(this.paths.runnerSocketDir, { recursive: true, mode: 0o700 })
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    const env = { PATH: process.env.PATH ?? '', HOME: config.env.HOME ?? process.env.HOME ?? '' }
    if (this.runnerHostSocket) {
      this.launchThroughHost(config, configPath, env)
      return
    }
    const logFd = openSync(this.paths.runnerLog(config.agentId), 'a')
    try {
      const child = spawn(process.execPath, ['--no-warnings', this.runnerEntry, configPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      })
      child.on('error', () => this.callbacks.disconnected(config.agentId, config.generation))
      child.unref()
    } finally {
      closeSync(logFd)
    }
  }

  /** A failed request reads as a dropped connection, so reconciliation finds no runner and records the failed launch. */
  private launchThroughHost(config: RunnerConfig, configPath: string, env: Record<string, string>): void {
    const body = JSON.stringify({ entry: this.runnerEntry, configPath, logPath: this.paths.runnerLog(config.agentId), env })
    const outgoing = request({ socketPath: this.runnerHostSocket!, method: 'POST', path: '/spawn', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume()
      if (response.statusCode !== 200) this.callbacks.disconnected(config.agentId, config.generation)
    })
    outgoing.on('error', () => this.callbacks.disconnected(config.agentId, config.generation))
    outgoing.end(body)
  }

  wasLaunchAttempted(agentId: string, generation: number): boolean {
    return existsSync(this.paths.runnerConfig(agentId, generation))
  }

  findProcess(agentId: string, generation: number): { pid: number } | null {
    return findRunnerProcess(this.paths.runnerConfig(agentId, generation))
  }

  /** Whether a connection for this generation exists, or is being made. */
  isConnected(agentId: string, generation: number): boolean {
    return this.connections.get(agentId)?.generation === generation
  }

  /** Keeps trying for a short while, since a runner just launched takes a moment to open its socket. */
  connect(agentId: string, generation: number, onConnected: () => void): void {
    this.disconnect(agentId)
    this.attemptConnection(agentId, generation, onConnected, Date.now() + CONNECT_PATIENCE_MS)
  }

  private attemptConnection(agentId: string, generation: number, onConnected: () => void, patientUntil: number): void {
    const socket = connect(this.paths.runnerSocket(agentId, generation))
    const connection: RunnerConnection = { generation, socket, connected: false }
    this.connections.set(agentId, connection)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (this.connections.get(agentId) !== connection) return
      if (!connection.connected && Date.now() < patientUntil) {
        const retry = setTimeout(() => {
          if (this.connections.get(agentId) === connection) this.attemptConnection(agentId, generation, onConnected, patientUntil)
        }, CONNECT_RETRY_MS)
        retry.unref()
        return
      }
      this.connections.delete(agentId)
      this.callbacks.disconnected(agentId, generation)
    })
    const lines = createInterface({ input: socket })
    lines.on('error', () => socket.destroy())
    lines.on('line', (line) => {
      const notice = JSON.parse(line) as RunnerNotice
      if (notice.type === 'hello') {
        // A socket left by some other generation is not the runner we were looking for.
        if (notice.agentId !== agentId || notice.generation !== generation) {
          socket.destroy()
          return
        }
        connection.connected = true
        onConnected()
      }
      this.callbacks.journalGrew(agentId, generation)
    })
  }

  disconnect(agentId: string): void {
    const existing = this.connections.get(agentId)
    if (!existing) return
    this.connections.delete(agentId)
    existing.socket.destroy()
  }

  disconnectAll(): void {
    for (const agentId of [...this.connections.keys()]) this.disconnect(agentId)
  }

  /** Commands are best effort: `ourod` repeats whatever matters after it reconnects. */
  send(agentId: string, generation: number, command: RunnerCommand): void {
    const connection = this.connections.get(agentId)
    if (connection?.generation !== generation || !connection.connected) return
    connection.socket.write(`${JSON.stringify(command)}\n`)
  }

  signalStop(agentId: string, generation: number): void {
    const found = this.findProcess(agentId, generation)
    if (found) process.kill(found.pid, 'SIGTERM')
  }

  /** The runner and everything under it. Only its own process group, by the pid found from its own config path. */
  kill(agentId: string, generation: number): void {
    const found = this.findProcess(agentId, generation)
    if (!found) return
    try {
      process.kill(-found.pid, 'SIGKILL')
    } catch {
      process.kill(found.pid, 'SIGKILL')
    }
  }

  forgetGeneration(agentId: string, generation: number): void {
    rmSync(this.paths.runnerSocket(agentId, generation), { force: true })
  }
}
