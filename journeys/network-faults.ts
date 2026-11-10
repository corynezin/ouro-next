// The network between two running computers, for journeys that break it. Each computer's peer address points at a link
// that forwards to its server. A link can be cut, as a partition is: nothing connects. It can lose the answer to a request
// that did arrive, as an acknowledgement lost in transit is. And it can send a request on twice, as a replay is. The app
// talks to each server directly, past its link.
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { freePort } from './harness.ts'

/** A request as the link saw it, and what became of it. */
export interface LinkEvent {
  method: string
  path: string
  outcome: 'forwarded' | 'answer_lost' | 'replayed'
  /** The server's status for the request, and for its replay if it had one. */
  statuses: number[]
}

interface Fault {
  /** Peer API paths it applies to, such as `/peer/v1/messages`. */
  path: string
  kind: 'lose_answer' | 'replay'
  remaining: number
  /** Only requests whose body has this text; null: any. */
  carrying: string | null
}

export class NetworkLink {
  readonly events: LinkEvent[] = []
  private readonly faults: Fault[] = []
  private readonly sockets = new Set<Socket>()
  private server: Server | null = null
  private port = 0
  private target = ''

  /** Listens; answers its URL, to be the computer's peer address before its server starts. */
  async start(): Promise<string> {
    this.port = await freePort()
    await this.listen()
    return this.url
  }

  /** Where it forwards: the server's own URL, once it is known. */
  forwardTo(target: string): void {
    this.target = target
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** A partition: nothing listens, so a connection is refused and the sender knows nothing arrived. */
  async cut(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((closed) => server.close(() => closed()))
  }

  async heal(): Promise<void> {
    if (!this.server) await this.listen()
  }

  /** The next `count` requests to `path` reach the server, and their answers are lost on the way back; with `carrying`,
   * only requests whose body has that text. */
  loseAnswers(path: string, count = 1, carrying: string | null = null): void {
    this.faults.push({ path, kind: 'lose_answer', remaining: count, carrying })
  }

  /** The next `count` requests to `path` reach the server twice, exactly as sent; the sender hears the first answer. */
  replay(path: string, count = 1): void {
    this.faults.push({ path, kind: 'replay', remaining: count, carrying: null })
  }

  async stop(): Promise<void> {
    await this.cut()
  }

  private async listen(): Promise<void> {
    const server = createServer((incoming, answer) => void this.handle(incoming, answer))
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((listening) => server.listen(this.port, '127.0.0.1', listening))
    this.server = server
  }

  private takeFault(path: string, body: Buffer): Fault | null {
    const fault = this.faults.find((candidate) => candidate.path === path && candidate.remaining > 0 && (candidate.carrying === null || body.includes(candidate.carrying))) ?? null
    if (fault) fault.remaining -= 1
    return fault
  }

  private async handle(incoming: IncomingMessage, answer: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const path = (incoming.url ?? '/').split('?')[0]!
    const fault = this.takeFault(path, body)
    let first: Awaited<ReturnType<NetworkLink['forward']>>
    try {
      first = await this.forward(incoming, body)
    } catch {
      // The server itself isn't answering: the link passes that on as a dropped connection.
      answer.socket?.destroy()
      return
    }
    if (fault?.kind === 'lose_answer') {
      this.events.push({ method: incoming.method!, path, outcome: 'answer_lost', statuses: [first.status] })
      // The connection was made and the request taken: the sender can't tell whether it arrived.
      answer.socket?.destroy()
      return
    }
    const statuses = [first.status]
    if (fault?.kind === 'replay') statuses.push((await this.forward(incoming, body)).status)
    this.events.push({ method: incoming.method!, path, outcome: fault?.kind === 'replay' ? 'replayed' : 'forwarded', statuses })
    answer.writeHead(first.status, first.headers)
    answer.end(first.body)
  }

  private forward(incoming: IncomingMessage, body: Buffer): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string' && name !== 'host' && name !== 'connection') headers[name] = value
    return new Promise((done, failed) => {
      const outgoing = httpRequest(new URL(incoming.url ?? '/', this.target), { method: incoming.method, headers }, (response) => {
        const parts: Buffer[] = []
        response.on('data', (chunk: Buffer) => parts.push(chunk))
        response.on('end', () => {
          const answerHeaders: Record<string, string> = {}
          const contentType = response.headers['content-type']
          if (contentType) answerHeaders['content-type'] = contentType
          done({ status: response.statusCode ?? 502, headers: answerHeaders, body: Buffer.concat(parts) })
        })
      })
      outgoing.on('error', failed)
      outgoing.end(body)
    })
  }
}
