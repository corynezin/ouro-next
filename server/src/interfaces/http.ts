// The HTTP API, on whichever listeners ourod opens. `network` listeners need a device token. The `local` socket is on this
// machine: an agent's credential makes it that agent, and no credential makes it the owner, because whoever reaches the
// socket already runs as the owner's user.
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AwsCredentialsBody, CHANGES_HEARTBEAT_MS, CreateMachineBody, SpritesTokenBody, ClaudeLoginFinishBody, GithubTokenBody, IdempotencyKey, MAX_ATTACHMENT_BYTES, PairRequest, SEARCH_DEFAULT_LIMIT, SecretKeyBody, UPDATE_ASSETS_PATH, UPDATE_MANIFEST_PATH, UPDATE_PROTOCOL_VERSION } from '@ouro/contract'
import { UPDATE_PLATFORM } from '../app/app-updates.ts'
import { fileTypeOf } from '../domain/file-type.ts'
import type { SyncFrame, Viewer } from '@ouro/contract'
import type { Caller, OuroCore } from '../app/core.ts'
import { CommandRefused } from '../app/failure.ts'
import type { Integrations } from '../app/integrations.ts'
import type { Machines } from '../app/machines.ts'
import { handlePeerRequest, isPeerPath, PEER_MOVE_PATH } from './peer.ts'
import type { z } from 'zod'

export type ListenerTrust = 'network' | 'local'

const JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024
const CHANGES_BATCH = 500

async function readBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    total += (chunk as Buffer).length
    if (total > limitBytes) throw new CommandRefused('attachment_too_large', `the limit is ${limitBytes} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, JSON_BODY_LIMIT_BYTES)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new CommandRefused('invalid_request', 'the body is not JSON')
  }
}

const PEER_BODY_LIMIT_BYTES = 1024 * 1024
/** A move carries the agent's model conversation, which can be long. */
const PEER_MOVE_BODY_LIMIT_BYTES = 256 * 1024 * 1024

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(body)}\n`)
}

function integerParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new CommandRefused('invalid_request', `${name} must be a whole number`)
  return value
}

/** Open change streams. They never end by themselves, so shutting down ends them, after ordinary requests are answered. */
export const openChangeStreams = new Set<ServerResponse>()

export interface RequestLogging {
  log: (event: string, fields: Record<string, unknown>) => void
  /** An answer that took this long is logged as slow. Change streams stay open by design and never count. */
  slowRequestMs: number
}

export function createApiHandler(core: OuroCore, trust: ListenerTrust, logging: RequestLogging): (request: IncomingMessage, response: ServerResponse) => void {
  const authenticate = (request: IncomingMessage): Caller => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (trust === 'local') {
      if (!bearer) return core.localOwnerCaller()
      const agent = core.authenticateAgent(bearer)
      if (!agent) throw new CommandRefused('unauthenticated', 'this credential belongs to an earlier run of the agent')
      return agent
    }
    if (!bearer) throw new CommandRefused('unauthenticated', 'pair this device first')
    const device = core.authenticateDevice(bearer)
    if (!device) throw new CommandRefused('unauthenticated', 'unknown or revoked device token')
    return device
  }

  const viewerOf = (caller: Caller): Viewer => core.viewerOf(caller.kind === 'person' ? caller : core.localOwnerCaller())

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://ouro.invalid')
    const method = request.method ?? 'GET'
    const path = url.pathname

    if (isPeerPath(path)) {
      const body = (await readBody(request, path === PEER_MOVE_PATH ? PEER_MOVE_BODY_LIMIT_BYTES : PEER_BODY_LIMIT_BYTES)).toString()
      const answered = await handlePeerRequest(core.peers, { method, path: request.url ?? path, body, header: (name) => headerOf(request, name) })
      return replyJson(response, answered.status, answered.body)
    }
    if (method === 'GET' && path === '/v2/identity') return replyJson(response, 200, core.identity())
    // Open on purpose: an update is the person's own app and holds no secrets (docs/architecture.md, Live self-update).
    if (method === 'GET' && path === UPDATE_MANIFEST_PATH) return serveManifest(core, request, response)
    const asset = new RegExp(`^${UPDATE_ASSETS_PATH}/(\\d+)/([^/]+)$`).exec(path)
    if (method === 'GET' && asset) return serveUpdateAsset(core, Number(asset[1]), decodeURIComponent(asset[2]!), response)
    if (method === 'POST' && path === '/v2/pair') {
      const parsed = PairRequest.safeParse(await readJson(request))
      if (!parsed.success) throw new CommandRefused('invalid_request', parsed.error.message)
      return replyJson(response, 200, core.pair(parsed.data.code, parsed.data.deviceName))
    }

    const caller = authenticate(request)

    if (path.startsWith('/v2/internal/')) {
      // Registering an update is for anyone on this machine, agents included; the rest is for the guardian.
      const allowed = trust === 'local' && (caller.kind === 'person' || path === '/v2/internal/updates')
      if (!allowed) throw new CommandRefused('forbidden', 'this is for the guardian on this machine')
      const body = await readJson(request) as { text?: string; alsoToAgent?: string | null; exportDir?: string; runtimeVersion?: string; commit?: string | null }
      switch (path) {
        case '/v2/internal/updates':
          if (typeof body.exportDir !== 'string' || typeof body.runtimeVersion !== 'string') throw new CommandRefused('invalid_request', 'exportDir and runtimeVersion are needed')
          return replyJson(response, 200, core.registerAppUpdate({ exportDir: body.exportDir, runtimeVersion: body.runtimeVersion, commit: body.commit ?? null }))
        case '/v2/internal/probe-credential': return replyJson(response, 200, core.issueProbeCredential())
        case '/v2/internal/release-confirmed':
          core.confirmRelease()
          return replyJson(response, 200, {})
        case '/v2/internal/system-notice':
          core.postSystemNotice(String(body.text ?? ''), body.alsoToAgent ?? null)
          return replyJson(response, 200, {})
      }
    }

    if (method === 'GET' && path === '/v2/snapshot') return replyJson(response, 200, core.snapshot(viewerOf(caller)))
    if (method === 'GET' && path === '/v2/changes') return streamChanges(core, viewerOf(caller), caller, url, request, response)

    const command = /^\/v2\/commands\/([a-z_]+)$/.exec(path)
    if (command && method === 'POST') {
      const body = await readJson(request) as { idempotencyKey?: unknown; input?: unknown }
      const key = IdempotencyKey.safeParse(body.idempotencyKey)
      if (!key.success) throw new CommandRefused('invalid_request', 'a command needs an idempotencyKey of at least 8 characters')
      const prepared = await core.prepareCommand(caller, command[1]!, key.data, body.input)
      return replyJson(response, 200, core.executeCommand(caller, command[1]!, key.data, body.input, prepared))
    }

    if (path === '/v2/machines' || path.startsWith('/v2/machines/') || path.startsWith('/v2/integrations/sprites')) {
      if (caller.kind !== 'person' || !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner makes servers')
      if (!core.machines) throw new CommandRefused('not_found', 'this server makes no servers')
      return replyJson(response, 200, await machineAction(core.machines, method, path, request))
    }

    if (path.startsWith('/v2/integrations/')) {
      if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'accounts are set up from the app')
      return replyJson(response, 200, await integrationAction(core.integrations, method, path.slice('/v2/integrations/'.length), request))
    }

    if (path === '/v2/tailscale') {
      if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'Tailscale is set up from the app')
      switch (method) {
        case 'GET': return replyJson(response, 200, await core.tailscale.status())
        case 'POST': return replyJson(response, 200, await core.tailscale.connect())
        case 'DELETE': return replyJson(response, 200, await core.tailscale.remove())
      }
    }

    if (method === 'GET' && path === '/v2/search') {
      return replyJson(response, 200, core.search(url.searchParams.get('q') ?? '', integerParam(url, 'limit') ?? SEARCH_DEFAULT_LIMIT))
    }

    const history = /^\/v2\/chats\/([^/]+)\/messages$/.exec(path)
    if (history && method === 'GET') {
      return replyJson(response, 200, core.chatHistory(decodeURIComponent(history[1]!), integerParam(url, 'before'), integerParam(url, 'limit') ?? 50))
    }

    const log = /^\/v2\/agents\/([^/]+)\/log$/.exec(path)
    if (log && method === 'GET') {
      return replyJson(response, 200, core.agentLog(decodeURIComponent(log[1]!), { after: integerParam(url, 'after'), before: integerParam(url, 'before') }))
    }

    const remoteLog = /^\/v2\/remote-agents\/([^/]+)\/log$/.exec(path)
    if (remoteLog && method === 'GET') {
      if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner reads logs on other computers')
      return replyJson(response, 200, await core.remoteAgentLog(decodeURIComponent(remoteLog[1]!), { after: integerParam(url, 'after'), before: integerParam(url, 'before') }))
    }

    const summaries = /^\/v2\/agents\/([^/]+)\/summaries$/.exec(path)
    if (summaries && method === 'GET') {
      return replyJson(response, 200, core.agentSummaries(decodeURIComponent(summaries[1]!), integerParam(url, 'before'), integerParam(url, 'limit') ?? 20))
    }

    const explanation = /^\/v2\/agents\/([^/]+)\/explanation$/.exec(path)
    if (explanation && method === 'GET') {
      return replyJson(response, 200, core.agentExplanation(decodeURIComponent(explanation[1]!), integerParam(url, 'limit') ?? 50))
    }

    if (path === '/v2/attachments' && method === 'POST') {
      const bytes = await readBody(request, MAX_ATTACHMENT_BYTES)
      const fileName = decodeURIComponent(String(request.headers['x-file-name'] ?? 'file'))
      const mimeType = fileTypeOf(request.headers['content-type'], fileName)
      return replyJson(response, 200, core.saveAttachment(bytes, fileName, mimeType))
    }

    const attachment = /^\/v2\/attachments\/([0-9a-f]{64})$/.exec(path)
    if (attachment && method === 'GET') {
      const found = core.store.attachmentById(attachment[1]!)
      if (!found) throw new CommandRefused('not_found', 'no such attachment')
      const filePath = core.attachmentPath(found.id)
      response.writeHead(200, {
        'content-type': found.mimeType,
        'content-length': statSync(filePath).size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.fileName)}`,
        'cache-control': 'private, max-age=31536000, immutable',
      })
      createReadStream(filePath).pipe(response)
      return
    }

    throw new CommandRefused('not_found', `no such endpoint: ${method} ${path}`)
  }

  return (request, response) => {
    const receivedAt = performance.now()
    // The path only: a query can carry what someone searched for.
    const path = new URL(request.url ?? '/', 'http://ouro.invalid').pathname
    const method = request.method ?? 'GET'
    response.on('finish', () => {
      const elapsedMs = Math.round(performance.now() - receivedAt)
      if (path !== '/v2/changes' && elapsedMs >= logging.slowRequestMs) logging.log('request_slow', { method, path, status: response.statusCode, elapsedMs })
    })
    route(request, response).catch((error: unknown) => {
      if (!(error instanceof CommandRefused)) {
        logging.log('request_failed', { method, path, elapsedMs: Math.round(performance.now() - receivedAt), error: (error as Error).stack ?? String(error) })
      }
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof CommandRefused) return replyJson(response, error.httpStatus, { error: error.toApiError() })
      replyJson(response, 500, { error: { code: 'internal', message: 'the server hit an unexpected error', retryable: true } })
    })
  }
}

function serveManifest(core: OuroCore, request: IncomingMessage, response: ServerResponse): void {
  const platform = String(request.headers['expo-platform'] ?? '')
  const runtimeVersion = String(request.headers['expo-runtime-version'] ?? '')
  if (platform !== UPDATE_PLATFORM || runtimeVersion === '') throw new CommandRefused('invalid_request', `expo-platform must be ${UPDATE_PLATFORM}, with an expo-runtime-version`)
  const update = core.appUpdates.latest(runtimeVersion)
  const protocolHeaders = { 'expo-protocol-version': UPDATE_PROTOCOL_VERSION, 'expo-sfv-version': '0', 'cache-control': 'private, max-age=0' }
  if (!update) {
    response.writeHead(204, protocolHeaders)
    response.end()
    return
  }
  // The address the phone used, so asset URLs reach the same server by the same route.
  const host = request.headers.host ?? 'localhost'
  const manifest = core.appUpdates.manifestOf(update, `http://${host}`)
  response.writeHead(200, { ...protocolHeaders, 'content-type': 'application/json' })
  response.end(JSON.stringify(manifest))
}

function serveUpdateAsset(core: OuroCore, updateNumber: number, fileName: string, response: ServerResponse): void {
  const file = core.appUpdates.assetFile(updateNumber, fileName)
  if (!file) throw new CommandRefused('not_found', 'no such update asset')
  response.writeHead(200, { 'content-type': file.contentType, 'content-length': statSync(file.path).size, 'cache-control': 'public, max-age=31536000, immutable' })
  createReadStream(file.path).pipe(response)
}

/** Sends everything after the client's cursor, then follows. Revoking the device cuts the stream at once. */
function streamChanges(core: OuroCore, viewer: Viewer, caller: Caller, url: URL, request: IncomingMessage, response: ServerResponse): void {
  const writeFrame = (frame: SyncFrame, id: number | null) => {
    response.write(`${id === null ? '' : `id: ${id}\n`}data: ${JSON.stringify(frame)}\n\n`)
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  // Headers and a first comment go out at once, so the client's silence timer starts from something it received.
  response.flushHeaders()
  response.write(': open\n\n')

  const clientEpoch = url.searchParams.get('epoch')
  if (clientEpoch !== null && clientEpoch !== core.epoch()) {
    writeFrame({ frame: 'resync_required', epoch: core.epoch() }, null)
    response.end()
    return
  }

  let cursor = integerParam(url, 'after') ?? 0
  let caughtUpSent = false
  const pump = () => {
    if (response.destroyed) return
    for (;;) {
      const batch = core.changesAfter(cursor, viewer, CHANGES_BATCH)
      for (const change of batch) {
        writeFrame({ frame: 'change', change }, change.cursor)
        cursor = change.cursor
      }
      if (batch.length < CHANGES_BATCH) break
    }
    if (!caughtUpSent) {
      caughtUpSent = true
      writeFrame({ frame: 'caught_up', cursor }, null)
    }
  }

  const unsubscribeChanges = core.onChange(pump)
  const unsubscribeRevocation = core.onDeviceDisconnected((deviceId) => {
    if (caller.kind === 'person' && caller.deviceId === deviceId) response.destroy()
  })
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), CHANGES_HEARTBEAT_MS)
  heartbeat.unref()
  openChangeStreams.add(response)
  request.on('close', () => {
    openChangeStreams.delete(response)
    clearInterval(heartbeat)
    unsubscribeChanges()
    unsubscribeRevocation()
  })
  pump()
}

/** New servers, and the Sprites account they can be made on. The token passes straight through: never logged. */
async function machineAction(machines: Machines, method: string, path: string, request: IncomingMessage): Promise<unknown> {
  const body = <S extends z.ZodType>(schema: S) => async (): Promise<z.infer<S>> => {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) throw new CommandRefused('invalid_request', 'that request is missing what this action needs')
    return parsed.data
  }
  const one = /^\/v2\/machines\/([^/]+)$/.exec(path)
  if (one && method === 'GET') return await machines.get(decodeURIComponent(one[1]!))
  if (one && method === 'DELETE') {
    await machines.remove(decodeURIComponent(one[1]!))
    return {}
  }
  switch (`${method} ${path}`) {
    case 'GET /v2/machines': return await machines.list()
    case 'POST /v2/machines': {
      const { provider, label } = await body(CreateMachineBody)()
      return await machines.create(provider, label)
    }
    case 'GET /v2/integrations/sprites': return await machines.spritesStatus()
    case 'POST /v2/integrations/sprites/token': return await machines.spritesSetToken((await body(SpritesTokenBody)()).token)
    case 'POST /v2/integrations/sprites/disconnect': return await machines.spritesDisconnect()
    default: throw new CommandRefused('not_found', `no such route: ${method} ${path}`)
  }
}

/** The accounts' routes. Codes, keys and tokens pass straight to the provider's tool: never stored here or logged. */
async function integrationAction(integrations: Integrations, method: string, action: string, request: IncomingMessage): Promise<unknown> {
  const body = <S extends z.ZodType>(schema: S) => async (): Promise<z.infer<S>> => {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) throw new CommandRefused('invalid_request', 'that request is missing what this action needs')
    return parsed.data
  }
  switch (`${method} ${action}`) {
    case 'POST claude/login/start': return await integrations.claudeLoginStart()
    case 'POST claude/login/finish': return await integrations.claudeLoginFinish((await body(ClaudeLoginFinishBody)()).code)
    case 'POST claude/api_key': return await integrations.claudeSetApiKey((await body(SecretKeyBody)()).key)
    case 'DELETE claude/api_key': return await integrations.claudeClearApiKey()
    case 'POST chatgpt/login/start': return await integrations.chatgptLoginStart()
    case 'POST chatgpt/sign_out': return await integrations.chatgptSignOut()
    case 'POST openrouter/key': return await integrations.openrouterSetKey((await body(SecretKeyBody)()).key)
    case 'DELETE openrouter/key': return await integrations.openrouterClearKey()
    case 'POST github/token': return await integrations.githubSetToken((await body(GithubTokenBody)()).token)
    case 'POST github/disconnect': return await integrations.githubDisconnect()
    case 'GET aws': return await integrations.awsStatus()
    case 'POST aws/credentials': return await integrations.awsSetCredentials(await body(AwsCredentialsBody)())
    case 'POST aws/disconnect': return await integrations.awsDisconnect()
    default: throw new CommandRefused('not_found', `no such account action: ${method} ${action}`)
  }
}
