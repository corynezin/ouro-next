// Machine to machine: `/peer/v1`. Every route but /join and /network-join is signed by a known peer's key, and every one but /hello and
// /forget is refused from a peer this server can't work with, or that may not do what the route does (domain/networks.ts).
import { PEER_API_PREFIX, PeerJoinRequest, PeerNetworkJoinRequest } from '@ouro/contract'
import type { PeerError } from '@ouro/contract'
import { PeerRequestRefused } from '../app/peers.ts'
import type { Peers, PeerRow } from '../app/peers.ts'
import type { PeerAction } from '../domain/networks.ts'

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

type PeerRoute = (peers: Peers, peer: PeerRow, body: () => unknown) => unknown

/** Signed routes taken even from a peer this server can't work with: so any two versions can see each other and part. */
const ALWAYS_ROUTES: Record<string, PeerRoute> = {
  '/hello': (peers, peer, body) => peers.receiveHello(peer, body()),
  '/forget': (peers, peer) => {
    peers.receiveForget(peer)
    return {}
  },
}

/** Every other signed route, all POST, each with what it does (see peerMay): a route is taken only when the peer may. */
const WORKING_ROUTES: Record<string, { action: PeerAction; handle: PeerRoute }> = {
  '/control': { action: 'control', handle: (peers, peer, body) => peers.receiveControl(peer, body()) },
  '/create-agent': { action: 'create_agent', handle: (peers, peer, body) => peers.receiveCreateAgent(peer, body()) },
  '/move-check': { action: 'move', handle: (peers, peer, body) => peers.receiveMoveCheck(peer, body()) },
  '/move': { action: 'move', handle: (peers, peer, body) => peers.receiveMove(peer, body()) },
  '/agents': { action: 'see_agents', handle: (peers, peer) => peers.receiveAgentsRequest(peer) },
  '/log': { action: 'read_log', handle: (peers, peer, body) => peers.receiveLogRequest(peer, body()) },
  '/memory': { action: 'pull_memory', handle: (peers, peer, body) => peers.receiveMemoryRequest(peer, body()) },
  '/group-updates': { action: 'group', handle: (peers, peer, body) => peers.receiveGroupUpdate(peer, body()) },
  '/owner-messages': { action: 'message', handle: (peers, peer, body) => peers.receiveOwnerMessage(peer, body()) },
  '/owner-asks': { action: 'message', handle: (peers, peer, body) => peers.receiveOwnerAsk(peer, body()) },
  '/owner-ask-snoozes': { action: 'snooze_ask', handle: (peers, peer, body) => peers.receiveAskSnooze(peer, body()) },
  '/group-posts': { action: 'group', handle: (peers, peer, body) => peers.receiveGroupPost(peer, body()) },
  '/pull': { action: 'pull', handle: (peers, peer, body) => peers.receivePull(peer, body()) },
  '/memory-push': { action: 'push_memory', handle: (peers, peer, body) => peers.receiveMemoryPush(peer, body()) },
  '/claude-token': { action: 'sign_in', handle: (peers, peer, body) => peers.receiveClaudeToken(peer, body()) },
  '/messages': { action: 'message', handle: (peers, peer, body) => peers.receiveMessage(peer, body()) },
}

/** Each working route's action, for tests that check each one is decided. */
export const PEER_ROUTE_ACTIONS: Readonly<Record<string, PeerAction>> = Object.fromEntries(Object.entries(WORKING_ROUTES).map(([route, { action }]) => [route, action]))

/** Every route that must be signed, for tests that walk them all. */
export const SIGNED_PEER_ROUTES: readonly string[] = [...Object.keys(ALWAYS_ROUTES), ...Object.keys(WORKING_ROUTES)]
/** The routes whose credential is an invite's code instead. */
export const UNSIGNED_PEER_ROUTES: readonly string[] = ['/join', '/network-join']

async function answer(peers: Peers, request: PeerHttpRequest): Promise<unknown> {
  const route = new URL(request.path, 'http://peer.invalid').pathname.slice(PEER_API_PREFIX.length)
  if (request.method === 'POST' && route === '/join') {
    const join = PeerJoinRequest.safeParse(parseBody(request.body))
    if (!join.success) throw new PeerRequestRefused('invalid_request', 'not a join request')
    return peers.acceptJoin(join.data)
  }
  if (request.method === 'POST' && route === '/network-join') {
    const join = PeerNetworkJoinRequest.safeParse(parseBody(request.body))
    if (!join.success) throw new PeerRequestRefused('invalid_request', 'not a network join request')
    return peers.acceptNetworkJoin(join.data)
  }
  // Signature and network first, before the body is looked at.
  const peer = peers.verify(request)
  const body = () => parseBody(request.body)
  const always = Object.hasOwn(ALWAYS_ROUTES, route) ? ALWAYS_ROUTES[route] : undefined
  if (request.method === 'POST' && always) return always(peers, peer, body)
  peers.requireWorksWith(peer)
  const working = Object.hasOwn(WORKING_ROUTES, route) ? WORKING_ROUTES[route] : undefined
  if (request.method === 'POST' && working) {
    peers.requireMay(working.action, peer)
    return working.handle(peers, peer, body)
  }
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
