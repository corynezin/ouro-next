// One server's HTTP API, typed from `contract`. Never throws: every outcome is a value, and every answer is validated.
import {
  AttachmentRef, AwsActionResult, AwsIntegrationState, ChatgptLoginStart, ClaudeLoginStart, CommandRequest, commands, ErrorResponse, HistoryPage,
  IntegrationActionResult, LogPage, SearchPage, Snapshot, SummaryPage, SyncFrame,
} from '@ouro/contract'
import type { ApiError, AwsCredentialsBody, CommandInput, CommandName, CommandOutput } from '@ouro/contract'
import type { z } from 'zod'
import { TailscaleStatus } from '@ouro/contract'
import type { Clock, HttpRequest, HttpResponse, HttpStream, IdSource, Network } from '../platform/ports.ts'

export interface ServerEndpoint { url: string; token: string }

export type ApiFailure =
  /** The server answered with a typed refusal. */
  | { kind: 'refused'; status: number; error: ApiError }
  /** The token is no longer accepted. */
  | { kind: 'unauthenticated'; status: number }
  /** The proxy in front of the machine answered: it's starting up, restoring or briefly unreachable. */
  | { kind: 'machine_unreachable'; status: number }
  /** No answer. A command may still have been accepted, so retry it with the same key. */
  | { kind: 'no_answer'; reason: string }
  | { kind: 'timed_out' }
  /** Something answered that doesn't match the contract. */
  | { kind: 'invalid_answer'; status: number; reason: string }
  | { kind: 'cancelled' }

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure }

const MACHINE_UNREACHABLE_STATUSES = [502, 503, 504]
const READ_TIMEOUT_MS = 30_000
/** Commands are idempotent, so giving up on a silent one is safe, and "sending…" must not be shown forever. */
const COMMAND_TIMEOUT_MS = 60_000
export const STOP_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

export function failureText(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'refused': return failure.error.message
    case 'unauthenticated': return 'This server is not paired (or was revoked).'
    // The reference's words for both: the platform's own error ("fetch failed: Could not connect…") means nothing to the owner.
    case 'machine_unreachable':
    case 'no_answer': return "Couldn't reach your Ouro machine. Try again in a few seconds."
    case 'timed_out': return 'request timed out'
    case 'invalid_answer': return 'malformed response'
    case 'cancelled': return 'request cancelled'
  }
}

export class ServerApi {
  private readonly network: Network
  private readonly clock: Clock
  private readonly ids: IdSource
  readonly endpoint: ServerEndpoint
  /** Aborting it cancels everything this client has open. */
  private readonly signal: AbortSignal

  constructor(deps: { network: Network; clock: Clock; ids: IdSource }, endpoint: ServerEndpoint, signal: AbortSignal) {
    this.network = deps.network
    this.clock = deps.clock
    this.ids = deps.ids
    this.endpoint = endpoint
    this.signal = signal
  }

  private headers(hasJsonBody: boolean): Record<string, string> {
    return {
      authorization: `Bearer ${this.endpoint.token}`,
      ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
    }
  }

  private url(path: string) { return `${this.endpoint.url}${path}` }

  private withTimeout(timeoutMs: number) {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (this.signal.aborted) cancel()
    else this.signal.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const cancelTimer = this.clock.setTimer(timeoutMs, () => { timedOut = true; cancel() })
    return {
      signal: controller.signal,
      didTimeOut: () => timedOut,
      finish: () => { cancelTimer(); this.signal.removeEventListener('abort', cancel) },
    }
  }

  private async exchange<S extends z.ZodType>(
    send: (signal: AbortSignal) => Promise<HttpResponse>,
    timeoutMs: number,
    schema: S,
  ): Promise<ApiResult<z.infer<S>>> {
    const timeout = this.withTimeout(timeoutMs)
    try {
      return interpretResponse(await send(timeout.signal), schema)
    } catch (error) {
      if (timeout.didTimeOut()) return { ok: false, failure: { kind: 'timed_out' } }
      if (this.signal.aborted) return { ok: false, failure: { kind: 'cancelled' } }
      return { ok: false, failure: { kind: 'no_answer', reason: reasonOf(error) } }
    } finally {
      timeout.finish()
    }
  }

  private read<S extends z.ZodType>(path: string, schema: S) {
    return this.exchange((signal) => this.network.request({
      method: 'GET', url: this.url(path), headers: this.headers(false), body: null, signal,
    }), READ_TIMEOUT_MS, schema)
  }

  snapshot() { return this.read('/v2/snapshot', Snapshot) }

  history(chatId: string, page: { beforeSeq: number | null; limit: number }) {
    const before = page.beforeSeq === null ? '' : `&before=${page.beforeSeq}`
    return this.read(`/v2/chats/${encodeURIComponent(chatId)}/messages?limit=${page.limit}${before}`, HistoryPage)
  }

  log(agentId: string, position: { before: number } | { after: number } | null) {
    const query = !position ? '' : 'before' in position ? `?before=${position.before}` : `?after=${position.after}`
    return this.read(`/v2/agents/${encodeURIComponent(agentId)}/log${query}`, LogPage)
  }

  /** Newest first, from before summary number `beforeNumber` when given. */
  summaries(agentId: string, page: { beforeNumber: number | null; limit: number }) {
    const before = page.beforeNumber === null ? '' : `&before=${page.beforeNumber}`
    return this.read(`/v2/agents/${encodeURIComponent(agentId)}/summaries?limit=${page.limit}${before}`, SummaryPage)
  }

  /** Messages holding every word of `query`, newest first. */
  search(query: string, limit: number) {
    return this.read(`/v2/search?q=${encodeURIComponent(query)}&limit=${limit}`, SearchPage)
  }

  /** An account route. Not a command: a secret in its body must not be kept in an idempotency record. */
  private integrationRoute<S extends z.ZodType>(method: 'GET' | 'POST' | 'DELETE', action: string, body: object | null, schema: S) {
    return this.exchange((signal) => this.network.request({
      method, url: this.url(`/v2/integrations/${action}`), headers: this.headers(body !== null),
      body: body === null ? null : JSON.stringify(body), signal,
    }), COMMAND_TIMEOUT_MS, schema)
  }

  claudeLoginStart() { return this.integrationRoute('POST', 'claude/login/start', null, ClaudeLoginStart) }
  claudeLoginFinish(code: string) { return this.integrationRoute('POST', 'claude/login/finish', { code }, IntegrationActionResult) }
  claudeSetApiKey(key: string) { return this.integrationRoute('POST', 'claude/api_key', { key }, IntegrationActionResult) }
  chatgptLoginStart() { return this.integrationRoute('POST', 'chatgpt/login/start', null, ChatgptLoginStart) }
  chatgptSignOut() { return this.integrationRoute('POST', 'chatgpt/sign_out', null, IntegrationActionResult) }
  openrouterSetKey(key: string) { return this.integrationRoute('POST', 'openrouter/key', { key }, IntegrationActionResult) }
  openrouterClearKey() { return this.integrationRoute('DELETE', 'openrouter/key', null, IntegrationActionResult) }
  githubSetToken(token: string) { return this.integrationRoute('POST', 'github/token', { token }, IntegrationActionResult) }
  githubDisconnect() { return this.integrationRoute('POST', 'github/disconnect', null, IntegrationActionResult) }
  awsStatus() { return this.integrationRoute('GET', 'aws', null, AwsIntegrationState) }
  awsSetCredentials(credentials: AwsCredentialsBody) { return this.integrationRoute('POST', 'aws/credentials', credentials, AwsActionResult) }
  awsDisconnect() { return this.integrationRoute('POST', 'aws/disconnect', null, AwsActionResult) }

  /** Reissuing with the same key returns the first result and repeats nothing. */
  command<N extends CommandName>(name: N, input: CommandInput<N>, idempotencyKey: string): Promise<ApiResult<CommandOutput<N>>> {
    const definition = commands[name]
    const body = JSON.stringify(CommandRequest(definition.input).parse({ idempotencyKey, input }))
    return this.exchange((signal) => this.network.request({
      method: 'POST', url: this.url(`/v2/commands/${name}`), headers: this.headers(true), body, signal,
    }), COMMAND_TIMEOUT_MS, definition.output) as Promise<ApiResult<CommandOutput<N>>>
  }

  /** Runs a command with a new key, retrying with that same key while the proxy says the machine is down. */
  async commandRetryingWhileUnreachable<N extends CommandName>(name: N, input: CommandInput<N>, attempts: number): Promise<ApiResult<CommandOutput<N>>> {
    const key = this.ids.newId()
    for (let attempt = 1; ; attempt++) {
      const result = await this.command(name, input, key)
      if (result.ok || result.failure.kind !== 'machine_unreachable' || attempt >= attempts) return result
      await this.sleep(RETRY_DELAY_MS)
      if (this.signal.aborted) return { ok: false, failure: { kind: 'cancelled' } }
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const cancelTimer = this.clock.setTimer(ms, finish)
      const signal = this.signal
      signal.addEventListener('abort', finish, { once: true })
      function finish() {
        cancelTimer()
        signal.removeEventListener('abort', finish)
        resolve()
      }
    })
  }

  uploadAttachment(file: { uri: string; fileName: string; mimeType: string }) {
    return this.exchange((signal) => this.network.uploadFile({
      url: this.url('/v2/attachments'),
      fileUri: file.uri,
      headers: {
        ...this.headers(false),
        'content-type': file.mimeType || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.fileName),
      },
      signal,
    }), COMMAND_TIMEOUT_MS * 5, AttachmentRef)
  }

  attachmentUrl(attachmentId: string) { return this.url(`/v2/attachments/${encodeURIComponent(attachmentId)}`) }
  authorizationHeaders() { return this.headers(false) }

  /** This server's Tailscale: GET reads where it stands, POST starts connecting, DELETE starts removing. Each answers at
   * once with the status; the work runs on. A route, not a command: it acts on the host, not the store. */
  tailscale(method: 'GET' | 'POST' | 'DELETE') {
    return this.exchange((signal) => this.network.request({
      method, url: this.url('/v2/tailscale'), headers: this.headers(false), body: null, signal,
    }), method === 'GET' ? READ_TIMEOUT_MS : COMMAND_TIMEOUT_MS, TailscaleStatus)
  }

  openChanges(epoch: string, afterCursor: number, signal: AbortSignal): Promise<HttpStream> {
    const request: HttpRequest = {
      method: 'GET',
      url: this.url(`/v2/changes?epoch=${encodeURIComponent(epoch)}&after=${afterCursor}`),
      headers: { ...this.headers(false), accept: 'text/event-stream' },
      body: null,
      signal,
    }
    return this.network.openStream(request)
  }
}

export const syncFrameOf = (payload: string) => SyncFrame.parse(JSON.parse(payload))

export function interpretResponse<S extends z.ZodType>(response: HttpResponse, schema: S): ApiResult<z.infer<S>> {
  const { status, text } = response
  if (status >= 200 && status < 300) {
    const parsed = schema.safeParse(parseJson(text))
    if (parsed.success) return { ok: true, value: parsed.data }
    return { ok: false, failure: { kind: 'invalid_answer', status, reason: parsed.error.message } }
  }
  if (status === 401) return { ok: false, failure: { kind: 'unauthenticated', status } }
  if (MACHINE_UNREACHABLE_STATUSES.includes(status)) {
    // The server itself can also answer 503 with a typed, retryable refusal, which says more than the proxy would.
    const typed = ErrorResponse.safeParse(parseJson(text))
    if (typed.success) return { ok: false, failure: { kind: 'refused', status, error: typed.data.error } }
    return { ok: false, failure: { kind: 'machine_unreachable', status } }
  }
  const refusal = ErrorResponse.safeParse(parseJson(text))
  if (refusal.success) return { ok: false, failure: { kind: 'refused', status, error: refusal.data.error } }
  return { ok: false, failure: { kind: 'invalid_answer', status, reason: `HTTP ${status}` } }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

export const reasonOf = (error: unknown) => (error instanceof Error && error.message) || 'network error'
