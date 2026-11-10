// The hub's HTTP API under `/hub/v1`, as the contract's `HUB_ROUTES` describe it. Sign-up and reading bases need no
// token; every other route takes the account's token as a bearer token.
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { CreateHostedServerRequest, HUB_API_PREFIX, httpStatusOfHubError, PublishBaseRequest, SignupRequest } from '@ouro/contract'
import type { HubError } from '@ouro/contract'
import type { HubBases } from './bases.ts'
import { HubRefusal } from './hub.ts'
import type { Hub } from './hub.ts'

const MAX_BODY_BYTES = 64 * 1024
/** A base's files come in the request, base64 encoded. */
const MAX_PUBLISH_BODY_BYTES = 64 * 1024 * 1024

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new HubRefusal('invalid_request', 'The request is too large.')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HubRefusal('invalid_request', 'The request is not JSON.')
  }
}

const bearerOf = (request: IncomingMessage): string | null => /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? null

type Answer =
  | { kind: 'json'; value: unknown }
  | { kind: 'nothing' }
  | { kind: 'file'; path: string; contentType: string }

const json = (value: unknown): Answer => ({ kind: 'json', value })

const baseNumberOf = (text: string): number => {
  if (!/^[1-9][0-9]{0,8}$/.test(text)) throw new HubRefusal('not_found', `There is no base ${text}.`)
  return Number(text)
}

interface HubServices {
  hub: Hub
  bases: HubBases
}

async function route({ hub, bases }: HubServices, request: IncomingMessage): Promise<Answer> {
  const url = new URL(request.url ?? '/', 'http://hub')
  const method = request.method ?? 'GET'
  if (!url.pathname.startsWith(`${HUB_API_PREFIX}/`)) throw new HubRefusal('not_found', 'No such route.')
  const path = url.pathname.slice(HUB_API_PREFIX.length)
  const publishing = method === 'POST' && path === '/bases'
  const body = await readJson(request, publishing ? MAX_PUBLISH_BODY_BYTES : MAX_BODY_BYTES)

  if (method === 'POST' && path === '/signup') {
    const parsed = SignupRequest.safeParse(body)
    if (!parsed.success) throw new HubRefusal('invalid_request', 'Enter your invite code and your name.')
    return json(await hub.signUp(parsed.data.invite, parsed.data.name))
  }
  if (method === 'GET' && path === '/bases/latest') {
    const latest = bases.latest()
    return latest ? json(latest) : { kind: 'nothing' }
  }
  const files = /^\/bases\/([^/]+)\/files$/.exec(path)
  if (method === 'GET' && files) return { kind: 'file', path: bases.filesOf(baseNumberOf(files[1]!)), contentType: 'application/x-tar' }

  const account = hub.accountOf(bearerOf(request))
  if (method === 'GET' && path === '/servers') return json({ servers: await hub.listServers(account) })
  if (method === 'POST' && path === '/servers') {
    const parsed = CreateHostedServerRequest.safeParse(body)
    if (!parsed.success) throw new HubRefusal('invalid_request', 'Give the server a name of up to 60 characters.')
    return json(await hub.createServer(account, parsed.data.label))
  }
  const one = /^\/servers\/([^/]+)$/.exec(path)
  if (method === 'GET' && one) return json(await hub.getServer(account, decodeURIComponent(one[1]!)))
  if (method === 'DELETE' && one) {
    await hub.deleteServer(account, decodeURIComponent(one[1]!))
    return { kind: 'nothing' }
  }
  if (publishing) {
    const parsed = PublishBaseRequest.safeParse(body)
    if (!parsed.success) throw new HubRefusal('invalid_request', 'A base needs notes, its tree hash and its files.')
    return json(await bases.publish(account, parsed.data))
  }
  const withdraw = /^\/bases\/([^/]+)\/withdraw$/.exec(path)
  if (method === 'POST' && withdraw) return json(bases.withdraw(account, baseNumberOf(withdraw[1]!)))
  throw new HubRefusal('not_found', 'No such route.')
}

const refusalOf = (code: HubError['error']['code'], message: string): HubError => ({ error: { code, message, retryable: code === 'internal' || code === 'hub_full' } })
const INTERNAL_MESSAGE = 'Something went wrong on the hub. Try again.'

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function answer(response: ServerResponse, answered: Answer, logInternal: (error: Error) => void): void {
  switch (answered.kind) {
    case 'json':
      return respond(response, 200, answered.value)
    case 'nothing':
      response.writeHead(204, { 'cache-control': 'no-store' })
      return void response.end()
    case 'file': {
      const stream = createReadStream(answered.path)
      stream.once('open', () => {
        response.writeHead(200, { 'content-type': answered.contentType })
        stream.pipe(response)
      })
      stream.once('error', (error) => {
        logInternal(error)
        if (response.headersSent) response.destroy()
        else respond(response, httpStatusOfHubError.internal, refusalOf('internal', INTERNAL_MESSAGE))
      })
    }
  }
}

export function hubHttpServer(services: HubServices, logInternal: (error: Error) => void): Server {
  return createServer((request, response) => {
    route(services, request).then((answered) => answer(response, answered, logInternal), (error: unknown) => {
      const refusal = error instanceof HubRefusal ? error : null
      if (!refusal) logInternal(error instanceof Error ? error : new Error(String(error)))
      const code = refusal?.code ?? 'internal'
      respond(response, httpStatusOfHubError[code], refusalOf(code, refusal?.message ?? INTERNAL_MESSAGE))
    })
  })
}
