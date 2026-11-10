// Notifications on this phone. The server decides what to push and when; the phone registers its token with each server
// once that server's stream is live, keeps the icon badge, quiets pushes about what is on screen, and acts on taps and
// on the ask buttons (Reply, Snooze 1 hour) for whichever saved server sent the push.
import { PushPayload } from '@ouro/contract'
import type { PushSubject } from '@ouro/contract'
import type { AppCore } from '../appCore.ts'
import type { NotificationPermission, PushPlatform } from '../platform/ports.ts'
import { failureText } from '../session/serverApi.ts'
import type { EntityStore } from '../session/entityStore.ts'
import type { ServerSession } from '../session/serverSession.ts'

export const SNOOZE_FROM_NOTIFICATION_MS = 60 * 60 * 1000

/** Where a tap leads, under the Agents list. A group push leads to its room. */
export type PushPlace = { kind: 'agent_chat'; agentId: string } | { kind: 'room'; chatId: string }
export interface PushOpening { serverId: string; place: PushPlace }

/** What the person did with a notification. Reply and Snooze are the ask category's buttons and don't open the app. */
export type PushResponse = { kind: 'opened' } | { kind: 'replied'; text: string } | { kind: 'snoozed' }

/** The Settings button's result. */
export type AllowOutcome =
  | { kind: 'on' }
  /** The token is saved there all the same, so pushes start once the server has a key. */
  | { kind: 'server_has_no_apns_key' }
  | { kind: 'off_in_ios_settings' }
  | { kind: 'no_server' }
  | { kind: 'failed'; reason: string }

export const PUSH_TOKEN_WAIT_MS = 20_000
export const NO_PUSH_TOKEN = 'iOS gave this phone no push token. Try again later.'

export function allowOutcomeText(outcome: AllowOutcome): string {
  switch (outcome.kind) {
    case 'on': return 'Notifications are on for this phone.'
    case 'server_has_no_apns_key': return 'This server has no APNs key yet, so it can’t send notifications.'
    case 'off_in_ios_settings': return 'Notifications are off for Ouro (Settings → Notifications).'
    case 'no_server': return 'Pair with a server first.'
    case 'failed': return outcome.reason
  }
}

/** The `ouro` object beside `aps`, or null for a push that isn't ours or is from an older or newer server. */
export function pushPayloadOf(userInfo: Readonly<Record<string, unknown>>): PushPayload | null {
  const parsed = PushPayload.safeParse(userInfo.ouro)
  return parsed.success ? parsed.data : null
}

export function placeOf(subject: PushSubject): PushPlace | null {
  switch (subject.kind) {
    case 'message': return subject.agentId === null ? { kind: 'room', chatId: subject.chatId } : { kind: 'agent_chat', agentId: subject.agentId }
    case 'ask': return { kind: 'agent_chat', agentId: subject.agentId }
    case 'update_available': return null
  }
}

export interface PushCenterDeps {
  core: AppCore
  platform: PushPlatform
  /** The icon badge: unread in chats with agents on the active server. */
  badgeCountOf: (store: EntityStore) => number
  checkForUpdate: () => void
}

export class PushCenter {
  private readonly deps: PushCenterDeps
  /** Sessions whose server has this phone's token. A new session registers again: the token may have changed. */
  private readonly registered = new WeakSet<ServerSession>()
  private watchedSession: ServerSession | null = null
  private unwatchSession: (() => void) | null = null
  private lastBadge: number | null = null
  private pendingOpening: PushOpening | null = null
  private listeners = new Set<() => void>()
  private cleanups: (() => void)[] = []

  constructor(deps: PushCenterDeps) {
    this.deps = deps
  }

  start() {
    this.cleanups.push(this.deps.core.subscribe(() => this.followActiveSession()))
    this.followActiveSession()
  }

  stop() {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.unwatchSession?.()
    this.unwatchSession = null
    this.watchedSession = null
  }

  /** The tap waiting for navigation to show it. */
  get opening() { return this.pendingOpening }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Called once navigation shows it. */
  takeOpening(): PushOpening | null {
    const opening = this.pendingOpening
    this.pendingOpening = null
    return opening
  }

  // ---- registering ----

  /** The Settings button: the only place that shows the system prompt. Registers with the active server. */
  async allowOnThisPhone(): Promise<AllowOutcome> {
    const session = this.deps.core.activeSession
    if (!session) return { kind: 'no_server' }
    const permission = await this.deps.platform.requestPermission().catch((): NotificationPermission => 'denied')
    if (permission !== 'granted') return { kind: 'off_in_ios_settings' }
    return this.register(session)
  }

  private followActiveSession() {
    const session = this.deps.core.activeSession
    if (session === this.watchedSession) return
    this.unwatchSession?.()
    this.watchedSession = session
    this.unwatchSession = null
    if (!session) return
    const onConnection = () => { if (session.connection.phase === 'live') void this.registerIfAllowed(session) }
    const unsubscribeConnection = session.subscribeToConnection(onConnection)
    const unsubscribeStore = session.store.subscribe(() => this.updateBadge(session))
    // A push sets the icon badge itself while the app is away, so the last count set here may no longer be on the icon.
    const unsubscribeForeground = this.deps.core.deps.lifecycle.onForeground(() => this.resetBadge(session))
    this.unwatchSession = () => { unsubscribeConnection(); unsubscribeStore(); unsubscribeForeground() }
    onConnection()
    this.updateBadge(session)
  }

  /** Never prompts: a phone that hasn't allowed notifications waits for the Settings button. */
  private async registerIfAllowed(session: ServerSession) {
    if (this.registered.has(session)) return
    const permission = await this.deps.platform.permission().catch((): NotificationPermission => 'not_asked')
    if (permission === 'granted') await this.register(session)
  }

  private async register(session: ServerSession): Promise<AllowOutcome> {
    let registration
    try {
      registration = await this.tokenWithin(PUSH_TOKEN_WAIT_MS)
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    if (registration === null) return { kind: 'failed', reason: NO_PUSH_TOKEN }
    const result = await session.command('register_push_token', registration)
    if (!result.ok) return { kind: 'failed', reason: failureText(result.failure) }
    this.registered.add(session)
    return result.value.apnsConfigured ? { kind: 'on' } : { kind: 'server_has_no_apns_key' }
  }

  /** iOS may never answer (a simulator without APNs doesn't), and the Settings button must still say something. Null: no answer in time. */
  private tokenWithin(waitMs: number) {
    return new Promise<Awaited<ReturnType<PushPlatform['registration']>> | null>((resolve, reject) => {
      const cancel = this.deps.core.deps.clock.setTimer(waitMs, () => resolve(null))
      this.deps.platform.registration().then((registration) => { cancel(); resolve(registration) }, (error: unknown) => { cancel(); reject(error) })
    })
  }

  private resetBadge(session: ServerSession) {
    this.lastBadge = null
    this.updateBadge(session)
  }

  private updateBadge(session: ServerSession) {
    // Before the first snapshot the store is empty, and 0 would clear a badge that is still right.
    if (session.isDisposed || !session.store.viewer) return
    const count = this.deps.badgeCountOf(session.store)
    if (count === this.lastBadge) return
    this.lastBadge = count
    this.deps.platform.setBadge(count).catch(() => {})
  }

  // ---- arriving ----

  /** A push arrived while the app is open. False to keep it quiet: it's about the conversation on screen. */
  async shouldPresent(payload: PushPayload): Promise<boolean> {
    if (payload.subject.kind === 'update_available') return false
    const session = this.deps.core.activeSession
    if (!session || !this.deps.core.deps.lifecycle.isActive() || !session.isChatOpen(payload.subject.chatId)) return true
    const server = await this.deps.core.serverOfDevice(payload.deviceId).catch(() => null)
    return server?.id !== session.serverId
  }

  /** Any push that reached the app, in the foreground or woken in the background. */
  received(payload: PushPayload) {
    if (payload.subject.kind === 'update_available') this.deps.checkForUpdate()
    // The push carried its own badge; put the app's count back on the icon.
    const session = this.deps.core.activeSession
    if (session) this.resetBadge(session)
  }

  // ---- responding ----

  async responded(payload: PushPayload, response: PushResponse): Promise<void> {
    const { core } = this.deps
    const server = await core.serverOfDevice(payload.deviceId).catch(() => null)
    if (!server) return
    const { subject } = payload
    switch (response.kind) {
      case 'opened': {
        const place = placeOf(subject)
        if (!place) return
        if (core.activeSession?.serverId !== server.id && !(await core.switchTo(server))) return
        this.pendingOpening = { serverId: server.id, place }
        this.changed()
        return
      }
      case 'replied': {
        const text = response.text.trim()
        if (subject.kind !== 'ask' || !text) return
        await core.sendFrom(server, {
          destination: { kind: 'direct', to: subject.agentAddress, answersAskId: subject.askId },
          conversationId: subject.agentId,
          text,
          attachments: [],
        })
        return
      }
      case 'snoozed': {
        if (subject.kind !== 'ask') return
        const at = core.deps.clock.now() + SNOOZE_FROM_NOTIFICATION_MS
        await core.commandErrorOn(server, 'snooze_ask', { askId: subject.askId, snooze: { kind: 'until', at } })
        return
      }
    }
  }

  private changed() { for (const listener of this.listeners) listener() }
}
