// Apple Push Notification service, straight from this machine: HTTP/2 with a token signed by the person's own APNs key.
// Without a key configured, nothing is pushed and the app shows that notifications aren't set up.
import { connect } from 'node:http2'
import type { ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PushPayload, PushSubject, PushTokenRegistration } from '@ouro/contract'

export interface ApnsKey {
  teamId: string
  keyId: string
  keyFile: string
}

export interface ApnsNotification {
  subject: PushSubject
  /** Null: a silent background push. */
  alert: { title: string; body: string } | null
  audible: boolean
  timeSensitive: boolean
  badge: number
  category: 'ask' | null
  /** A later push with the same id replaces this one on the phone: one banner per burst. */
  collapseId: string | null
  threadId: string | null
}

/**
 * - `delivered`: APNs took it.
 * - `token_gone`: the token is no longer valid, so stop using it.
 * - `failed`: anything else; nothing to change.
 */
export type PushOutcome = { kind: 'delivered' } | { kind: 'token_gone' } | { kind: 'failed'; detail: string }

/** A phone to push to: its device id on this server, and its APNs registration. */
export interface PushTarget {
  deviceId: string
  registration: PushTokenRegistration
}

export type SendPush = (target: PushTarget, notification: ApnsNotification) => Promise<PushOutcome>

const PROVIDER_TOKEN_LIFETIME_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 15_000

/** `gatewayOverride`: one gateway for both environments, for tests against a fake. */
export function apnsSender(key: ApnsKey, gatewayOverride: string | null): SendPush {
  const privateKey = createPrivateKey(readFileSync(key.keyFile))
  let providerToken: { jwt: string; madeAt: number } | null = null
  const sessions = new Map<string, ClientHttp2Session>()

  const tokenNow = (): string => {
    const now = Date.now()
    if (providerToken && now - providerToken.madeAt < PROVIDER_TOKEN_LIFETIME_MS) return providerToken.jwt
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: key.keyId })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: key.teamId, iat: Math.floor(now / 1000) })).toString('base64url')
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    providerToken = { jwt: `${header}.${claims}.${signature}`, madeAt: now }
    return providerToken.jwt
  }

  const sessionFor = (gateway: string): ClientHttp2Session => {
    const existing = sessions.get(gateway)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(gateway)
    session.on('error', () => sessions.delete(gateway))
    session.unref()
    sessions.set(gateway, session)
    return session
  }

  return ({ deviceId, registration }, notification) => new Promise((resolve) => {
    const gateway = gatewayOverride ?? (registration.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com')
    const background = notification.alert === null
    const aps: Record<string, unknown> = { badge: notification.badge }
    if (background) aps['content-available'] = 1
    if (notification.alert) aps.alert = notification.alert
    if (notification.audible) aps.sound = 'default'
    if (notification.category) aps.category = notification.category
    if (notification.threadId) aps['thread-id'] = notification.threadId
    if (!background) aps['interruption-level'] = notification.timeSensitive ? 'time-sensitive' : notification.audible ? 'active' : 'passive'
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${registration.token}`,
      authorization: `bearer ${tokenNow()}`,
      'apns-topic': registration.bundleId,
      'apns-push-type': background ? 'background' : 'alert',
      'apns-priority': background ? '5' : '10',
    }
    if (notification.collapseId) headers['apns-collapse-id'] = notification.collapseId
    let request
    try {
      request = sessionFor(gateway).request(headers)
    } catch (error) {
      resolve({ kind: 'failed', detail: (error as Error).message })
      return
    }
    let status = 0
    let body = ''
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close())
    request.on('response', (responseHeaders) => { status = Number(responseHeaders[':status']) })
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('error', (error) => resolve({ kind: 'failed', detail: error.message }))
    request.on('close', () => {
      if (status === 200) return resolve({ kind: 'delivered' })
      const reason = (() => {
        try {
          return String((JSON.parse(body) as { reason?: unknown }).reason ?? '')
        } catch {
          return body.slice(0, 200)
        }
      })()
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic') return resolve({ kind: 'token_gone' })
      resolve({ kind: 'failed', detail: `APNs ${status || 'no answer'}: ${reason}` })
    })
    const ouro: PushPayload = { deviceId, subject: notification.subject }
    request.end(JSON.stringify({ aps, ouro }))
  })
}
