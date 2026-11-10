// Pushes to people's phones. Called after a commit with what happened; the decision of what to push is the domain's.
// Without APNs configured it does nothing: everything still reaches the app through sync.
import { createHash } from 'node:crypto'
import { chatHandle } from '@ouro/contract'
import type { AskLevel, AskSnooze, PushSubject } from '@ouro/contract'
import type { ApnsNotification, SendPush } from '../adapters/apns.ts'
import { mentionedMembers, personNames } from '../domain/chat.ts'
import { askRenotifyDue, decidePush, isInQuietHours } from '../domain/push.ts'
import type { PushEvent } from '../domain/push.ts'
import type { PersonRow, Store } from '../store/store.ts'

const BODY_MAX_CHARS = 400

export interface NotifierConfig {
  store: Store
  now: () => number
  /** Null when this machine has no APNs key. */
  send: SendPush | null
  commit: (body: () => void) => void
  /** The direct chat between an agent and a person, created if missing, for asks that didn't come with a message. */
  directChatOf: (agentId: string, personAddress: string) => string
  log: (event: string, fields: Record<string, unknown>) => void
}

export class Notifier {
  private readonly config: NotifierConfig
  /** Person and source (an agent, or a room) → when they were last alerted about it, for bursts. Lost on restart: at worst one extra banner. */
  private readonly lastAlertAt = new Map<string, number>()

  constructor(config: NotifierConfig) {
    this.config = config
  }

  /** A message was posted. Each person in its chat other than the sender may get a push. */
  messagePosted(messageId: string, skipPushTokenHashes: ReadonlySet<string>): void {
    const { store } = this.config
    const message = store.messageById(messageId)
    // A message that poses an ask is pushed as the ask, with its actions.
    if (!message || message.posesAskId !== null) return
    const chat = store.chatEntity(message.chatId)
    if (!chat) return
    const fromAgent = store.activeAgentByName(message.from)
    for (const member of chat.members) {
      if (member.address === message.from) continue
      const person = store.personByAddress(member.address)
      if (!person) continue
      const event: PushEvent = {
        kind: 'message',
        agentId: fromAgent?.id ?? null,
        chat: chat.kind,
        mentionsPerson: chat.kind === 'group' && mentionedMembers(message.text, [{ address: person.address, names: personNames(person) }]).has(person.address),
        at: message.at,
      }
      const subject: PushSubject = { kind: 'message', chatId: chat.id, messageId: message.id, agentId: chat.kind === 'direct' ? fromAgent?.id ?? null : null }
      const title = chat.kind === 'group' ? `${message.from} in ${chatHandle(chat)}` : message.from
      this.alert(person, event, chat.kind === 'group' ? `room:${chat.id}` : `from:${message.from}`, subject, { title, body: message.text }, null, skipPushTokenHashes)
    }
  }

  /** An ask opened, or an ask's reminder came due. */
  askToNotify(askId: string): void {
    const { store } = this.config
    const ask = store.openAskById(askId)
    if (!ask) return
    const person = store.personByAddress(ask.to)
    if (!person) return
    const chatId = store.chatOfAsk(ask.id) ?? this.config.directChatOf(ask.agentId, person.address)
    const event: PushEvent = { kind: 'ask', agentId: ask.agentId, level: ask.level }
    const subject: PushSubject = { kind: 'ask', askId: ask.id, chatId, agentId: ask.agentId, agentAddress: ask.agentName }
    this.config.commit(() => store.setAskNotifiedAt(ask.id, this.config.now()))
    this.alert(person, event, `from:${ask.agentName}`, subject, { title: ask.agentName, body: ask.text }, 'ask', new Set())
  }

  /** An ask of an agent on another computer reached this one, or its reminder came due here. Pushed as its message, so a
   * tap opens the chat, to the phones its own computer doesn't push. */
  remoteAskToNotify(askId: string): void {
    const { store } = this.config
    const ask = store.remoteAskById(askId)
    const person = store.ownerPerson()
    const messageId = store.messageIdPosingAsk(askId)
    if (!ask || !person || !messageId) return
    const event: PushEvent = { kind: 'ask', agentId: null, level: ask.level }
    const subject: PushSubject = { kind: 'message', chatId: ask.chatId, messageId, agentId: null }
    this.config.commit(() => store.setRemoteAskNotifiedAt(ask.id, this.config.now()))
    this.alert(person, event, `from:${ask.address}`, subject, { title: ask.address, body: ask.text }, null, new Set(store.remoteAskSenderPushTokenHashes(ask.id)))
  }

  /** Asks, and copies of asks from other computers, unanswered for their level's interval, or whose snooze has ended since
   * they were last pushed. */
  remindDueAsks(): void {
    const now = this.config.now()
    for (const ask of this.config.store.asksLastNotifiedBefore(now)) {
      if (reminderDue(ask, now)) this.askToNotify(ask.id)
    }
    for (const copy of this.config.store.remoteAsksLastNotifiedBefore(now)) {
      if (reminderDue(copy, now)) this.remoteAskToNotify(copy.id)
    }
  }

  /** A new phone update: a silent push so phones can fetch it in the background. */
  updatePublished(updateNumber: number): void {
    for (const person of this.config.store.listPeople()) {
      this.deliver(person, { subject: { kind: 'update_available', updateNumber }, alert: null, audible: false, timeSensitive: false, badge: this.badgeOf(person), category: null, collapseId: null, threadId: null }, new Set())
    }
  }

  private alert(person: PersonRow, event: PushEvent, source: string, subject: PushSubject, alert: { title: string; body: string }, category: 'ask' | null, skipPushTokenHashes: ReadonlySet<string>): void {
    const { store } = this.config
    const now = this.config.now()
    const settings = store.notificationSettingsOf(person.id)
    const burstKey = `${person.id}|${source}`
    const decision = decidePush(settings, event, now, this.lastAlertAt.get(burstKey) ?? null, isInQuietHours(settings.quietHours, now))
    if (decision.kind === 'none') return
    this.lastAlertAt.set(burstKey, now)
    const body = alert.body.length > BODY_MAX_CHARS ? `${alert.body.slice(0, BODY_MAX_CHARS - 1)}…` : alert.body
    this.deliver(person, {
      subject,
      alert: { title: alert.title, body },
      audible: decision.audible,
      timeSensitive: decision.timeSensitive,
      badge: this.badgeOf(person),
      category,
      // One banner per burst from one agent or room; an ask keeps its own.
      collapseId: category === 'ask' ? null : source.slice(0, 64),
      threadId: 'chatId' in subject ? subject.chatId : null,
    }, skipPushTokenHashes)
  }

  private deliver(person: PersonRow, notification: ApnsNotification, skipPushTokenHashes: ReadonlySet<string>): void {
    const { send, store } = this.config
    if (!send) return
    for (const target of store.pushTargetsOf(person.id)) {
      if (skipPushTokenHashes.has(pushTokenHash(target.registration.token))) continue
      void send(target, notification).then((outcome) => {
        if (outcome.kind === 'token_gone') this.config.commit(() => store.setDevicePushToken(target.deviceId, null))
        if (outcome.kind !== 'delivered') this.config.log('push_failed', { deviceId: target.deviceId, outcome })
      })
    }
  }

  /** Unread across the person's chats with agents. */
  private badgeOf(person: PersonRow): number {
    return this.config.store.unreadWithAgents(person)
  }
}

/** How a phone's push token is named to other computers: see PUSH_TOKEN_HASHES in the contract. */
export function pushTokenHash(token: string): string {
  return createHash('sha256').update(token.toLowerCase()).digest('hex')
}

function reminderDue(ask: { level: AskLevel; snooze: AskSnooze | null; lastNotifiedAt: number }, now: number): boolean {
  const snooze = ask.snooze
  if (snooze !== null) {
    if (snooze.kind !== 'until' || snooze.at > now) return false
    // The snooze ended after the last push: remind now, as asked.
    if (snooze.at > ask.lastNotifiedAt) return true
  }
  return askRenotifyDue(ask.level, ask.lastNotifiedAt, now)
}
