// Holding the host awake. A Sprite pauses as soon as no request to it is open, even with an agent mid-turn (its calls out
// don't count). Its Tasks API, on a local socket, holds it awake: PUT /v1/tasks/<name> {"expire":"5m"} holds or renews,
// DELETE lets it sleep. A host that never sleeps needs none of it.
import { request } from 'node:http'

export interface HostHold {
  /** It pauses when idle: work needs a hold, and other machines mustn't keep it awake. */
  readonly sleeps: boolean
  /** Holds the host awake for a while, or renews the hold. False: the host refused, or couldn't be asked. */
  hold(): Promise<boolean>
  /** Lets it sleep. */
  release(): Promise<void>
}

export const neverSleeps: HostHold = { sleeps: false, hold: async () => true, release: async () => {} }

const CALL_TIMEOUT_MS = 3_000

/** The HTTP status, or null when the socket didn't answer. */
function call(socketPath: string, method: 'PUT' | 'DELETE', path: string, body: string | null): Promise<number | null> {
  return new Promise((resolveStatus) => {
    const headers: Record<string, string | number> = { host: 'sprite' }
    if (body !== null) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    const sent = request({ socketPath, path, method, headers, timeout: CALL_TIMEOUT_MS }, (response) => {
      response.resume()
      response.on('end', () => resolveStatus(response.statusCode ?? null))
    })
    sent.on('timeout', () => sent.destroy())
    sent.on('error', () => resolveStatus(null))
    sent.end(body ?? undefined)
  })
}

/** Holds through a Sprite's Tasks API, as task `taskName`. */
export function spriteTasksHold(socketPath: string, taskName: string): HostHold {
  const path = `/v1/tasks/${encodeURIComponent(taskName)}`
  // One call at a time, in order: a release still on its way must not land after a hold that acknowledged work.
  let previous: Promise<unknown> = Promise.resolve()
  const inOrder = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = previous.then(operation)
    previous = next.catch(() => undefined)
    return next
  }
  return {
    sleeps: true,
    hold: () => inOrder(async () => (await call(socketPath, 'PUT', path, JSON.stringify({ expire: '5m' }))) === 200),
    release: () => inOrder(async () => { await call(socketPath, 'DELETE', path, null) }),
  }
}
