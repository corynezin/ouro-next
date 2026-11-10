// The listening port. It belongs to the guardian, so a phone's address outlives every release. While ourod is switching,
// new requests wait here for a moment instead of failing.
import { createServer, request } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

const CONNECT_RETRY_MS = 50
const HOLD_LIMIT_MS = 45_000

function connectWhenAvailable(socketPath: string, holdUntil: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(socketPath)
      socket.once('connect', () => {
        socket.removeAllListeners('error')
        resolve(socket)
      })
      socket.once('error', (error) => {
        socket.destroy()
        if (Date.now() >= holdUntil) reject(error)
        else setTimeout(attempt, CONNECT_RETRY_MS)
      })
    }
    attempt()
  })
}


const RETRY_LIMIT = 3
const COMMAND_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * What may be sent again if the server goes away before answering: reads, and commands, which carry idempotency keys so a
 * repeat returns the first result. Anything else, such as an upload, is answered with a retryable refusal instead.
 */
function isSafeToRepeat(incoming: IncomingMessage): boolean {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return true
  return incoming.method === 'POST' && (incoming.url ?? '').startsWith('/v2/commands/')
}

async function readWholeBody(incoming: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of incoming) {
    total += (chunk as Buffer).length
    if (total > COMMAND_BODY_LIMIT_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function replyStarting(outgoing: ServerResponse, message: string): void {
  outgoing.writeHead(503, { 'content-type': 'application/json' })
  outgoing.end(JSON.stringify({ error: { code: 'server_starting', message, retryable: true } }))
}

export function startProxy(input: { port: number; upstreamSocket: string; onListening: () => void }): Server {
  /** `body` is the whole request body for a request safe to repeat, and null for one that streams through once. */
  const forward = (incoming: IncomingMessage, outgoing: ServerResponse, body: Buffer | null, attempt: number): void => {
    connectWhenAvailable(input.upstreamSocket, Date.now() + HOLD_LIMIT_MS).then((socket) => {
      const upstream = request({ createConnection: () => socket, method: incoming.method, path: incoming.url, headers: incoming.headers }, (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(outgoing)
        answer.on('error', () => outgoing.destroy())
      })
      upstream.on('error', () => {
        if (outgoing.headersSent) {
          outgoing.destroy()
        } else if (body !== null && attempt < RETRY_LIMIT && !outgoing.destroyed) {
          // The server went away before answering, as one does when it is replaced.
          setTimeout(() => forward(incoming, outgoing, body, attempt + 1), CONNECT_RETRY_MS)
        } else {
          replyStarting(outgoing, 'the server is restarting')
        }
      })
      if (body !== null) upstream.end(body)
      else incoming.pipe(upstream)
      outgoing.on('close', () => upstream.destroy())
    }).catch(() => replyStarting(outgoing, 'the server is not answering'))
  }

  const server = createServer((incoming, outgoing) => {
    if (!isSafeToRepeat(incoming)) return forward(incoming, outgoing, null, 0)
    readWholeBody(incoming).then((body) => {
      if (body === null) {
        outgoing.writeHead(413, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: { code: 'invalid_request', message: 'a command body is at most 1 MB', retryable: false } }))
        return
      }
      forward(incoming, outgoing, body, 0)
    }).catch(() => outgoing.destroy())
  })
  server.listen(input.port, '0.0.0.0', input.onListening)
  return server
}
