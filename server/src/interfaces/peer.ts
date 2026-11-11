// Machine to machine: `/peer/v1`. Every route but /join is signed by a known peer's key, and every one but /hello and
// /forget is refused from a peer this server can't work with.
import { PEER_API_PREFIX, PeerJoinRequest } from '@ouro/contract'
import type { PeerError } from '@ouro/contract'
import { PeerRequestRefused } from '../app/peers.ts'
import type { Peers } from '../app/peers.ts'

export interface PeerHttpRequest {
  method: string
  /** With its query, as signed. */
  path: string
  body: string
  header: (name: string) => string | undefined
}

export const isPeerPath = (path: string): boolean => path.startsWith(`${PEER_API_PREFIX}/`)
export const PEER_MOVE_PATH = `${PEER_API_PREFIX}/move`

const statusOfRefusal: Record<PeerRequestRefused['code'], number> = {
  unauthenticated: 401,
  invite_invalid: 403,
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  incompatible: 409,
  host_hold_refused: 503,
}

function parseBody(body: string): unknown {
  try {
    return body === '' ? undefined : JSON.parse(body) as unknown
  } catch {
    throw new PeerRequestRefused('invalid_request', 'the body is not JSON')
  }
}

async function answer(peers: Peers, request: PeerHttpRequest): Promise<unknown> {
  const route = new URL(request.path, 'http://peer.invalid').pathname.slice(PEER_API_PREFIX.length)
  if (request.method === 'POST' && route === '/join') {
    const join = PeerJoinRequest.safeParse(parseBody(request.body))
    if (!join.success) throw new PeerRequestRefused('invalid_request', 'not a join request')
    return peers.acceptJoin(join.data)
  }
  const peer = peers.verify(request)
  if (request.method === 'POST' && route === '/hello') return peers.receiveHello(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/forget') {
    peers.receiveForget(peer)
    return {}
  }
  peers.requireWorksWith(peer)
  if (request.method === 'POST' && route === '/control') return peers.receiveControl(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/create-agent') return peers.receiveCreateAgent(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/move-check') return peers.receiveMoveCheck(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/move') return peers.receiveMove(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/agents') return peers.receiveAgentsRequest(peer)
  if (request.method === 'POST' && route === '/log') return peers.receiveLogRequest(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/memory') return peers.receiveMemoryRequest(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/group-updates') return peers.receiveGroupUpdate(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/owner-messages') return peers.receiveOwnerMessage(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/owner-asks') return peers.receiveOwnerAsk(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/owner-ask-snoozes') return peers.receiveAskSnooze(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/group-posts') return peers.receiveGroupPost(peer, parseBody(request.body))
  if (request.method === 'POST' && route === '/messages') return peers.receiveMessage(peer, parseBody(request.body))
  throw new PeerRequestRefused('not_found', 'no such peer route')
}

/** Answers a peer request: its status and JSON body. */
export async function handlePeerRequest(peers: Peers, request: PeerHttpRequest): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await answer(peers, request) }
  } catch (error) {
    if (!(error instanceof PeerRequestRefused)) throw error
    return { status: statusOfRefusal[error.code], body: { error: { code: error.code, message: error.message } } satisfies PeerError }
  }
}
