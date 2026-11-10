// Keeping a Sprite awake while the guardian deploys. A Sprite pauses when nothing reaches it from outside and nothing
// holds it; a deploy talks to its candidate over local sockets, which don't count, and the live server holds only for its
// own work. So the guardian holds the host itself, through the Sprite's Tasks API, from the build until the switch is
// confirmed or given up.
import { existsSync } from 'node:fs'
import { request } from 'node:http'

/** A hold lasts this long unless renewed: a guardian that dies mid-deploy doesn't keep the host up for long. */
const HOLD_EXPIRE = '5m'
const RENEW_MS = 60_000
const CALL_TIMEOUT_MS = 3_000

function call(socketPath: string, method: 'PUT' | 'DELETE', path: string, body: string | null): Promise<void> {
  return new Promise((done) => {
    const headers: Record<string, string | number> = { host: 'sprite' }
    if (body !== null) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    const sent = request({ socketPath, method, path, headers, timeout: CALL_TIMEOUT_MS }, (answer) => {
      answer.resume()
      answer.on('end', () => done())
    })
    sent.on('timeout', () => sent.destroy())
    sent.on('error', () => done())
    sent.end(body ?? undefined)
  })
}

/** The Tasks API socket, when this host is a Sprite that pauses: `OURO_HOST_HOLD` says outright, as it does for ourod. */
export function hostHoldSocket(env: Record<string, string | undefined>): string | null {
  const socketPath = env.OURO_SPRITE_API_SOCKET ?? '/.sprite/api.sock'
  const kind = env.OURO_HOST_HOLD ?? (existsSync(socketPath) ? 'sprite' : 'none')
  return kind === 'sprite' ? socketPath : null
}

/** Runs `work` with the host held awake, renewed until it ends; without a socket, just runs it. */
export async function holdingHostAwake<T>(socketPath: string | null, taskName: string, work: () => Promise<T>): Promise<T> {
  if (socketPath === null) return await work()
  const path = `/v1/tasks/${encodeURIComponent(taskName)}`
  const hold = () => call(socketPath, 'PUT', path, JSON.stringify({ expire: HOLD_EXPIRE }))
  await hold()
  const renewal = setInterval(() => void hold(), RENEW_MS)
  try {
    return await work()
  } finally {
    clearInterval(renewal)
    await call(socketPath, 'DELETE', path, null)
  }
}
