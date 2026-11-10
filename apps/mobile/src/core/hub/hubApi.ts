// The hosted service's API, typed from `contract`'s hub.ts. Never throws: every outcome is a value, and every answer is
// validated.
import { CreateHostedServerRequest, HUB_API_PREFIX, HostedServer, HostedServerList, SignupRequest, SignupResult } from '@ouro/contract'
import { z } from 'zod'
import type { Clock, Network } from '../platform/ports.ts'
import { reasonOf } from '../session/serverApi.ts'

export type HubFailure =
  /** The account's token is no longer accepted: this sign-up is over. */
  | { kind: 'unauthenticated' }
  /** The hub answered with a refusal; its message is fit to show. `code` is the hub's, which may be one this app doesn't
   * know yet (such as hub_full): the hub changes apart from the app. */
  | { kind: 'refused'; code: string; message: string; retryable: boolean }
  /** No answer, or none in time. */
  | { kind: 'unreachable'; reason: string }
  /** Something answered that doesn't match the contract. */
  | { kind: 'invalid_answer'; status: number }

/** What a failure says to the owner; `fallback` names the request when the hub gave no words of its own. */
export function hubFailureText(failure: HubFailure, fallback: string): string {
  switch (failure.kind) {
    case 'unreachable': return `Can't reach the server (${failure.reason}). Check your connection and try again.`
    case 'refused': return failure.message || fallback
    case 'unauthenticated': return HUB_SIGNED_OUT_TEXT
    case 'invalid_answer': return fallback
  }
}

export const HUB_SIGNED_OUT_TEXT = 'This sign-up is no longer valid. Start over with your invite code.'

export type HubResult<T> = { ok: true; value: T } | { ok: false; failure: HubFailure }

const TIMEOUT_MS = 30_000
const PROXY_UNREACHABLE_STATUSES = [502, 503, 504]

/** The contract's HubError with any code: a refusal this app can't name is still the hub's, with a message to show. */
const HubRefusal = z.object({ error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }) })

export class HubApi {
  private readonly network: Network
  private readonly clock: Clock
  private readonly hubUrl: string

  constructor(deps: { network: Network; clock: Clock }, hubUrl: string) {
    this.network = deps.network
    this.clock = deps.clock
    this.hubUrl = hubUrl.replace(/\/+$/, '')
  }

  signup(request: SignupRequest) {
    return this.exchange('POST', '/signup', null, SignupRequest.parse(request), SignupResult)
  }

  listServers(token: string) {
    return this.exchange('GET', '/servers', token, null, HostedServerList)
  }

  createServer(token: string, request: CreateHostedServerRequest) {
    return this.exchange('POST', '/servers', token, CreateHostedServerRequest.parse(request), HostedServer)
  }

  getServer(token: string, serverId: string) {
    return this.exchange('GET', `/servers/${encodeURIComponent(serverId)}`, token, null, HostedServer)
  }

  private async exchange<S extends z.ZodType>(method: 'GET' | 'POST', path: string, token: string | null, body: object | null, schema: S): Promise<HubResult<z.infer<S>>> {
    const controller = new AbortController()
    const cancelTimer = this.clock.setTimer(TIMEOUT_MS, () => controller.abort())
    try {
      const response = await this.network.request({
        method,
        url: `${this.hubUrl}${HUB_API_PREFIX}${path}`,
        headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === null ? {} : { 'content-type': 'application/json' }) },
        body: body === null ? null : JSON.stringify(body),
        signal: controller.signal,
      })
      return interpretHubResponse(response.status, response.text, schema)
    } catch (error) {
      return { ok: false, failure: { kind: 'unreachable', reason: controller.signal.aborted ? 'timed out' : reasonOf(error) } }
    } finally {
      cancelTimer()
    }
  }
}

export function interpretHubResponse<S extends z.ZodType>(status: number, text: string, schema: S): HubResult<z.infer<S>> {
  const json = parseJson(text)
  if (status >= 200 && status < 300) {
    const parsed = schema.safeParse(json)
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: { kind: 'invalid_answer', status } }
  }
  const refusal = HubRefusal.safeParse(json)
  // A proxy in front of the hub answers these in its own words when the hub is down or restarting.
  if (!refusal.success && PROXY_UNREACHABLE_STATUSES.includes(status)) return { ok: false, failure: { kind: 'unreachable', reason: `HTTP ${status}` } }
  if (!refusal.success) return { ok: false, failure: { kind: 'invalid_answer', status } }
  const { code, message, retryable } = refusal.data.error
  if (code === 'unauthenticated') return { ok: false, failure: { kind: 'unauthenticated' } }
  return { ok: false, failure: { kind: 'refused', code, message, retryable } }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
