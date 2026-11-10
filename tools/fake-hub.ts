// A stand-in for the hub, for the app's tests: the hub contract with no computers behind it. A server walks through the
// provisioning steps on a timer and is then ready at a given address, with a pairing code from a given command (say,
// `ouro pair` against a journey's server), or a fixed one. Nothing is saved.
//
//   node tools/fake-hub.ts --port 8790 --invites alpha,beta [--step-ms 1000] [--server-address http://host:port]
//                          [--pair-command "OURO_SOCKET=… ouro pair | sed -n 's/^code: //p'"]
//
// Test controls, outside the contract: POST /fake-hub/fail-next {"step": "install", "why": "…"} makes the next server
// made fail at that step; POST /fake-hub/paired/<id> marks a server's code used.
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { parseArgs } from 'node:util'
import { CreateHostedServerRequest, HUB_API_PREFIX, httpStatusOfHubError, ProvisioningStep, SignupRequest } from '@ouro/contract'
import type { HostedServer, HubError, HubErrorCode } from '@ouro/contract'

export interface FakeHubOptions {
  port: number
  invites: string[]
  stepMs: number
  serverAddress: string
  /** Prints a pairing code and nothing else; null: a fixed code. */
  pairCommand: string | null
}

interface Account { id: string; name: string; token: string }
interface PlannedFailure { step: ProvisioningStep; why: string }
interface ServerRecord { server: HostedServer; accountId: string; startedAt: number; failure: PlannedFailure | null; pairing: { code: string; expiresAt: number } | null; paired: boolean }

const PAIRING_LIFETIME_MS = 30 * 60_000
const FIXED_PAIRING_CODE = 'FAKE-HUB-CODE'

class Refusal extends Error {
  readonly code: HubErrorCode
  constructor(code: HubErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface FakeHub {
  url: string
  close(): Promise<void>
}

export async function startFakeHub(options: FakeHubOptions): Promise<FakeHub> {
  const unusedInvites = new Set(options.invites)
  const accounts = new Map<string, Account>()
  const servers: ServerRecord[] = []
  let nextFailure: PlannedFailure | null = null

  const mintPairingCode = (): string => {
    if (options.pairCommand === null) return FIXED_PAIRING_CODE
    return execFileSync('/bin/sh', ['-c', options.pairCommand], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  }

  /** Where a server is now: provisioning moves on with time, and a ready one gets its code the first time it is seen. */
  const current = (record: ServerRecord): HostedServer => {
    if (record.server.status.state !== 'provisioning') return record.server
    const stepIndex = Math.floor((Date.now() - record.startedAt) / options.stepMs)
    const step = ProvisioningStep.options[stepIndex]
    if (record.failure && (step === undefined || ProvisioningStep.options.indexOf(record.failure.step) <= stepIndex)) {
      record.server = { ...record.server, status: { state: 'failed', why: record.failure.why } }
    } else if (step !== undefined) {
      record.server = { ...record.server, status: { state: 'provisioning', step } }
    } else {
      record.pairing = { code: mintPairingCode(), expiresAt: Date.now() + PAIRING_LIFETIME_MS }
      record.server = { ...record.server, status: { state: 'ready', address: options.serverAddress, pairing: record.pairing } }
    }
    return record.server
  }

  const withPairingState = (record: ServerRecord): HostedServer => {
    const server = current(record)
    if (server.status.state !== 'ready') return server
    const pairing = record.paired || (record.pairing !== null && record.pairing.expiresAt < Date.now()) ? null : record.pairing
    return { ...server, status: { ...server.status, pairing } }
  }

  const makeServer = (accountId: string, label: string, primary: boolean): ServerRecord => {
    const record: ServerRecord = {
      server: { id: `srv-${randomBytes(4).toString('hex')}`, label, createdAt: Date.now(), primary, status: { state: 'provisioning', step: 'create' } },
      accountId,
      startedAt: Date.now(),
      failure: nextFailure,
      pairing: null,
      paired: false,
    }
    nextFailure = null
    servers.push(record)
    return record
  }

  const accountOf = (request: IncomingMessage): Account => {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    const account = [...accounts.values()].find((candidate) => candidate.token === token)
    if (!account) throw new Refusal('unauthenticated', 'This sign-up is no longer valid.')
    return account
  }

  const route = async (request: IncomingMessage, body: unknown): Promise<unknown> => {
    const url = new URL(request.url ?? '/', 'http://hub')
    const method = request.method ?? 'GET'
    if (method === 'POST' && url.pathname === '/fake-hub/fail-next') {
      const { step, why } = body as { step: ProvisioningStep; why?: string }
      nextFailure = { step: ProvisioningStep.parse(step), why: why ?? 'Setting up your computer failed (fake hub).' }
      return {}
    }
    const paired = /^\/fake-hub\/paired\/([^/]+)$/.exec(url.pathname)
    if (method === 'POST' && paired) {
      const record = servers.find((candidate) => candidate.server.id === paired[1])
      if (!record) throw new Refusal('not_found', 'No such server.')
      record.paired = true
      return {}
    }
    if (!url.pathname.startsWith(HUB_API_PREFIX)) throw new Refusal('not_found', 'No such route.')
    const path = url.pathname.slice(HUB_API_PREFIX.length)
    if (method === 'POST' && path === '/signup') {
      const parsed = SignupRequest.safeParse(body)
      if (!parsed.success) throw new Refusal('invalid_request', 'Enter your invite code and your name.')
      if (!unusedInvites.delete(parsed.data.invite)) throw new Refusal('invite_invalid', 'That invite code is not valid, or was used already.')
      const account: Account = { id: randomUUID(), name: parsed.data.name, token: randomBytes(24).toString('hex') }
      accounts.set(account.id, account)
      makeServer(account.id, `${parsed.data.name}'s computer`, true)
      return { accountId: account.id, token: account.token, name: account.name }
    }
    const account = accountOf(request)
    const own = servers.filter((record) => record.accountId === account.id)
    if (method === 'GET' && path === '/servers') {
      return { servers: [...own].sort((a, b) => Number(b.server.primary) - Number(a.server.primary)).map(withPairingState) }
    }
    if (method === 'POST' && path === '/servers') {
      const parsed = CreateHostedServerRequest.safeParse(body)
      if (!parsed.success) throw new Refusal('invalid_request', 'Give the server a name.')
      return withPairingState(makeServer(account.id, parsed.data.label, false))
    }
    const one = /^\/servers\/([^/]+)$/.exec(path)
    if (method === 'GET' && one) {
      const record = own.find((candidate) => candidate.server.id === decodeURIComponent(one[1]!))
      if (!record) throw new Refusal('not_found', 'No such server.')
      return withPairingState(record)
    }
    throw new Refusal('not_found', 'No such route.')
  }

  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: unknown = undefined
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      } catch {
        return respond(response, 400, { error: { code: 'invalid_request', message: 'The request is not JSON.', retryable: false } } satisfies HubError)
      }
      route(request, body).then((value) => respond(response, 200, value), (error: unknown) => {
        const refusal = error instanceof Refusal ? error : new Refusal('internal', (error as Error).message)
        respond(response, httpStatusOfHubError[refusal.code], { error: { code: refusal.code, message: refusal.message, retryable: refusal.code === 'internal' } } satisfies HubError)
      })
    })
  })
  await new Promise<void>((resolveListen) => server.listen(options.port, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()) }),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      invites: { type: 'string', default: '' },
      'step-ms': { type: 'string', default: '1000' },
      'server-address': { type: 'string', default: 'http://127.0.0.1:1' },
      'pair-command': { type: 'string' },
    },
  })
  const hub = await startFakeHub({
    port: Number(values.port),
    invites: values.invites.split(',').filter(Boolean),
    stepMs: Number(values['step-ms']),
    serverAddress: values['server-address'],
    pairCommand: values['pair-command'] ?? null,
  })
  process.stdout.write(`${JSON.stringify({ event: 'listening', url: hub.url })}\n`)
}
