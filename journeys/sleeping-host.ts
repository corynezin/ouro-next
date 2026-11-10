// A stand-in for a host that pauses when idle, as a Sprite does. Everything from outside reaches the server through its
// front door; once no request is open and nothing holds it, it freezes the server (SIGSTOP), and the next request thaws
// it (SIGCONT). Its Tasks API, on a socket, takes holds the way a Sprite's does, and can be made to refuse them.
import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { connect, createServer } from 'node:net'
import type { Server } from 'node:net'
import { rmSync } from 'node:fs'
import { freePort } from './harness.ts'
import type { JourneyRun } from './harness.ts'

/** A Sprite pauses as soon as it can; a little later here, so a request's answer has left before the freeze. */
const IDLE_BEFORE_FREEZE_MS = 300

export type HostEvent = 'hold' | 'hold_refused' | 'release' | 'freeze' | 'thaw'

export class SleepingHost {
  readonly socketPath = `/tmp/ouro-host-${randomBytes(4).toString('hex')}.sock`
  /** Holds are refused while true, as a host that can't keep itself awake would. */
  refuseHolds = false
  readonly events: HostEvent[] = []
  private readonly run: JourneyRun
  private readonly holds = new Map<string, number>()
  private tasksApi: HttpServer | null = null
  private frontDoor: Server | null = null
  private watcher: NodeJS.Timeout | null = null
  /** A connection open through the front door counts as a request open: a Sprite stays up for those. */
  private openRequests = 0
  private readonly connections = new Set<{ destroy: () => void }>()
  /** Null until a first request has come through: a host that is starting the server is awake for it. */
  private lastRequestAt: number | null = null
  private frozenPid: number | null = null

  constructor(run: JourneyRun) {
    this.run = run
  }

  /** Before the server starts: from then on it sleeps here. */
  async attach(): Promise<void> {
    this.tasksApi = createHttpServer((request, response) => {
      const task = decodeURIComponent((request.url ?? '').replace(/^\/v1\/tasks\//, ''))
      request.resume()
      request.on('end', () => {
        if (request.method === 'PUT') {
          if (this.refuseHolds) {
            this.events.push('hold_refused')
            response.writeHead(503).end()
            return
          }
          this.holds.set(task, Date.now() + 5 * 60_000)
          this.events.push('hold')
          response.writeHead(200).end('{}')
          return
        }
        this.holds.delete(task)
        this.events.push('release')
        response.writeHead(204).end()
      })
    })
    await new Promise<void>((done) => this.tasksApi!.listen(this.socketPath, done))

    this.frontDoor = createServer((incoming) => {
      this.openRequests += 1
      this.thaw()
      const outgoing = connect(this.run.serverPort, '127.0.0.1')
      this.connections.add(incoming)
      incoming.pipe(outgoing).pipe(incoming)
      const closed = () => {
        this.openRequests -= 1
        this.lastRequestAt = Date.now()
        this.connections.delete(incoming)
        incoming.destroy()
        outgoing.destroy()
      }
      let ended = false
      const endOnce = () => { if (!ended) { ended = true; closed() } }
      incoming.on('close', endOnce)
      outgoing.on('close', endOnce)
      incoming.on('error', endOnce)
      outgoing.on('error', endOnce)
    })
    const port = await freePort()
    await new Promise<void>((done) => this.frontDoor!.listen(port, '127.0.0.1', done))
    this.run.reachThrough(`http://127.0.0.1:${port}`)
    this.run.addServerEnv({ OURO_HOST_HOLD: 'sprite', OURO_SPRITE_API_SOCKET: this.socketPath })
    this.watcher = setInterval(() => this.freezeIfIdle(), 50)
  }

  get frozen(): boolean {
    return this.frozenPid !== null
  }

  get held(): boolean {
    const now = Date.now()
    return [...this.holds.values()].some((expiresAt) => expiresAt > now)
  }

  count(event: HostEvent): number {
    return this.events.filter((candidate) => candidate === event).length
  }

  private freezeIfIdle(): void {
    const pid = this.run.serverPid
    if (pid === null || this.frozenPid !== null || this.openRequests > 0 || this.held) return
    if (this.lastRequestAt === null || Date.now() - this.lastRequestAt < IDLE_BEFORE_FREEZE_MS) return
    process.kill(pid, 'SIGSTOP')
    this.frozenPid = pid
    this.events.push('freeze')
  }

  private thaw(): void {
    if (this.frozenPid === null) return
    try { process.kill(this.frozenPid, 'SIGCONT') } catch { /* it is gone */ }
    this.frozenPid = null
    this.events.push('thaw')
  }

  /** Keeps the server awake from now on, so it can be stopped and cleaned up as usual. */
  async detach(): Promise<void> {
    if (this.watcher) clearInterval(this.watcher)
    this.thaw()
    for (const connection of this.connections) connection.destroy()
    await new Promise((done) => this.frontDoor?.close(done) ?? done(null))
    await new Promise((done) => this.tasksApi?.close(done) ?? done(null))
    rmSync(this.socketPath, { force: true })
  }
}
