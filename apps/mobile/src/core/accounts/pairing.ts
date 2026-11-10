// Turning what a person pastes or types into a server, and exchanging a code for a token.
import { DEFAULT_SERVER_PORT, ErrorResponse, PairRequest, PairResponse } from '@ouro/contract'
import type { Network } from '../platform/ports.ts'
import { reasonOf } from '../session/serverApi.ts'

/** "100.64.1.2", "100.64.1.2:8790", "mac.tail1234.ts.net" or a full URL, as a base URL. Null if it can't be one. */
export function serverUrlFromInput(input: string): string | null {
  let text = input.trim().replace(/\/+$/, '')
  if (!text) return null
  if (!text.includes('://')) {
    const host = text.split('/')[0]!
    const hasPort = host.includes(':')
    const isIpAddress = /^[\d.]+$/.test(host.split(':')[0]!)
    text = (isIpAddress || hasPort ? 'http://' : 'https://') + text + (isIpAddress && !hasPort ? `:${DEFAULT_SERVER_PORT}` : '')
  }
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) && url.host ? text : null
  } catch {
    return null
  }
}

/** `<any scheme>://pair?url=…&code=…`. Any scheme, because the link may come from another build of the CLI or app. */
export function parsePairLink(link: string): { url: string; code: string } | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/pair\?(.*)$/i.exec(link.trim())
  if (!match) return null
  const query = new URLSearchParams(match[1])
  const url = serverUrlFromInput(query.get('url') ?? '')
  const code = query.get('code') ?? ''
  return url && code ? { url, code } : null
}

/** `<any scheme>://invite?code=…`, which fills in the invite code on Welcome. */
export function parseInviteLink(link: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/invite\?(.*)$/i.exec(link.trim())
  return match ? new URLSearchParams(match[1]).get('code') : null
}

export type PairResult = { ok: true; paired: PairResponse } | { ok: false; reason: string }

export const DEVICE_NAME = 'Ouro (iPhone)'

export async function pairWithServer(network: Network, url: string, code: string): Promise<PairResult> {
  const request = PairRequest.parse({ code, deviceName: DEVICE_NAME })
  try {
    const response = await network.request({
      method: 'POST',
      url: `${url}/v2/pair`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: new AbortController().signal,
    })
    const body = parseJson(response.text)
    if (response.status >= 200 && response.status < 300) {
      const paired = PairResponse.safeParse(body)
      return paired.success ? { ok: true, paired: paired.data } : { ok: false, reason: 'malformed response' }
    }
    const refusal = ErrorResponse.safeParse(body)
    return { ok: false, reason: refusal.success ? refusal.data.error.message : `pairing failed (${response.status})` }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
