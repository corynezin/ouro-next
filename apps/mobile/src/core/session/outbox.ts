// One server's sends. An entry is saved before any network call and carries its idempotency key, so a retry, a kill or a
// lost answer can't duplicate a message. An outbox holds its server's credentials from construction and outlives that
// server's session: switching servers neither cancels a send nor can redirect it.
import { z } from 'zod'
import type { MessageEntity } from '@ouro/contract'
import type { Clock, DurableStore, IdSource } from '../platform/ports.ts'
import { failureText } from './serverApi.ts'
import type { ApiFailure, ApiResult, ServerApi } from './serverApi.ts'

const OutboxAttachment = z.object({
  /** Our own id for this file in this send, stable across retries. */
  localId: z.string(),
  uri: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  byteLength: z.number(),
  /** Set once uploaded, so a retry doesn't upload it again. */
  uploadedAttachmentId: z.string().nullable(),
})
export type OutboxAttachment = z.infer<typeof OutboxAttachment>

const OutboxDelivery = z.discriminatedUnion('state', [
  z.object({ state: z.literal('sending') }),
  z.object({ state: z.literal('failed'), reason: z.string() }),
])
export type OutboxDelivery = z.infer<typeof OutboxDelivery>

const OutboxDestination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), to: z.string(), answersAskId: z.string().nullable() }),
  z.object({ kind: z.literal('group'), chatId: z.string() }),
])
export type OutboxDestination = z.infer<typeof OutboxDestination>

const OutboxEntry = z.object({
  idempotencyKey: z.string(),
  destination: OutboxDestination,
  /** The screen its bubble shows on. A new agent's chat may not exist yet, so this isn't always a chat id. */
  conversationId: z.string(),
  text: z.string(),
  attachments: z.array(OutboxAttachment),
  createdAt: z.number(),
  delivery: OutboxDelivery,
})
export type OutboxEntry = z.infer<typeof OutboxEntry>

export type NewSend = Pick<OutboxEntry, 'destination' | 'conversationId' | 'text'> & {
  attachments: Omit<OutboxAttachment, 'uploadedAttachmentId'>[]
}

export const OUTBOX_KEY_PREFIX = 'outbox/'

export class ServerOutbox {
  private readonly store: DurableStore
  private readonly clock: Clock
  private readonly ids: IdSource
  private readonly keyPrefix: string
  private readonly api: ServerApi
  private entriesByKey = new Map<string, OutboxEntry>()
  /** Conversations with a delivery running: each delivers oldest first, so messages arrive in the order they were sent. */
  private delivering = new Set<string>()
  private changeListeners = new Set<() => void>()
  private acceptedListeners = new Set<(message: MessageEntity) => void>()

  constructor(deps: { store: DurableStore; clock: Clock; ids: IdSource; api: ServerApi }, serverId: string) {
    this.store = deps.store
    this.clock = deps.clock
    this.ids = deps.ids
    this.api = deps.api
    this.keyPrefix = `${OUTBOX_KEY_PREFIX}${serverId}/`
  }

  /** Reads what was saved and resumes unfinished sends: their idempotency keys make that safe. */
  async load() {
    for (const { value } of await this.store.readKeysWithPrefix(this.keyPrefix)) {
      const parsed = OutboxEntry.safeParse(parseJsonOrUndefined(value))
      if (parsed.success) this.entriesByKey.set(parsed.data.idempotencyKey, parsed.data)
    }
    this.changed()
    this.deliverAllWaiting()
  }

  get entries(): OutboxEntry[] { return sorted([...this.entriesByKey.values()]) }
  entriesIn(conversationId: string) { return this.entries.filter((entry) => entry.conversationId === conversationId) }

  subscribe(listener: () => void) {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }
  /** Tells a live session that the server accepted a message, before the entry disappears. */
  onAccepted(listener: (message: MessageEntity) => void) {
    this.acceptedListeners.add(listener)
    return () => { this.acceptedListeners.delete(listener) }
  }

  send(newSend: NewSend) {
    const entry: OutboxEntry = {
      idempotencyKey: this.ids.newId(),
      destination: newSend.destination,
      conversationId: newSend.conversationId,
      text: newSend.text,
      attachments: newSend.attachments.map((a) => ({ ...a, uploadedAttachmentId: null })),
      createdAt: this.clock.now(),
      delivery: { state: 'sending' },
    }
    this.entriesByKey.set(entry.idempotencyKey, entry)
    this.changed()
    void this.saveThenDeliver(entry)
    return entry.idempotencyKey
  }

  retry(idempotencyKey: string) {
    const entry = this.entriesByKey.get(idempotencyKey)
    if (!entry || entry.delivery.state !== 'failed') return
    const retrying = { ...entry, delivery: { state: 'sending' as const } }
    this.entriesByKey.set(idempotencyKey, retrying)
    this.changed()
    void this.saveThenDeliver(retrying)
  }

  /** Takes a failed entry back out, for Edit. Its text and files return to the composer, and this send is over. */
  async takeBack(idempotencyKey: string): Promise<OutboxEntry | null> {
    const entry = this.entriesByKey.get(idempotencyKey)
    if (!entry || entry.delivery.state !== 'failed') return null
    await this.remove(idempotencyKey)
    return entry
  }

  async discard(idempotencyKey: string) {
    const entry = this.entriesByKey.get(idempotencyKey)
    if (entry?.delivery.state === 'failed') await this.remove(idempotencyKey)
  }

  private async saveThenDeliver(entry: OutboxEntry) {
    try {
      await this.save(entry)
    } catch (error) {
      // An unsaved send must say so: nothing was sent, and it wouldn't survive a kill.
      this.markFailed(entry.idempotencyKey, error instanceof Error ? error.message : 'could not save the message')
      return
    }
    this.deliverAllWaiting()
  }

  private deliverAllWaiting() {
    for (const entry of this.entries) {
      if (entry.delivery.state === 'sending') void this.runConversation(entry.conversationId)
    }
  }

  private async runConversation(conversationId: string) {
    if (this.delivering.has(conversationId)) return
    this.delivering.add(conversationId)
    try {
      for (;;) {
        const next = this.entriesIn(conversationId).find((entry) => entry.delivery.state === 'sending')
        if (!next) return
        await this.deliver(next.idempotencyKey)
      }
    } finally {
      this.delivering.delete(conversationId)
    }
  }

  private async deliver(idempotencyKey: string) {
    const uploaded = await this.uploadAttachments(idempotencyKey)
    if (!uploaded.ok) return this.markFailed(idempotencyKey, uploadFailureText(uploaded.fileName, uploaded.failure))
    const result = await this.issueCommand(uploaded.entry)
    if (!result.ok) return this.failDelivery(idempotencyKey, result.failure)
    await this.accept(idempotencyKey, result.value.message)
  }

  private issueCommand({ destination, text, attachments, idempotencyKey }: OutboxEntry): Promise<ApiResult<{ message: MessageEntity }>> {
    const attachmentIds = attachments.flatMap((a) => (a.uploadedAttachmentId === null ? [] : [a.uploadedAttachmentId]))
    return destination.kind === 'direct'
      ? this.api.command('send_message', { to: destination.to, text, attachmentIds, wake: 'wake', answersAskId: destination.answersAskId }, idempotencyKey)
      : this.api.command('post_to_chat', { chatId: destination.chatId, text, attachmentIds }, idempotencyKey)
  }

  private async uploadAttachments(idempotencyKey: string): Promise<{ ok: true; entry: OutboxEntry } | { ok: false; failure: ApiFailure; fileName: string }> {
    let entry = this.entriesByKey.get(idempotencyKey)!
    for (const attachment of entry.attachments) {
      if (attachment.uploadedAttachmentId !== null) continue
      const result = await this.api.uploadAttachment({ uri: attachment.uri, fileName: attachment.fileName, mimeType: attachment.mimeType })
      if (!result.ok) return { ok: false, failure: result.failure, fileName: attachment.fileName }
      entry = {
        ...entry,
        attachments: entry.attachments.map((a) => (a.localId === attachment.localId ? { ...a, uploadedAttachmentId: result.value.id } : a)),
      }
      this.entriesByKey.set(idempotencyKey, entry)
      await this.save(entry)
      this.changed()
    }
    return { ok: true, entry }
  }

  private async accept(idempotencyKey: string, message: MessageEntity) {
    for (const listener of this.acceptedListeners) listener(message)
    await this.remove(idempotencyKey)
  }

  private failDelivery(idempotencyKey: string, failure: ApiFailure) {
    return this.markFailed(idempotencyKey, failureText(failure))
  }

  private markFailed(idempotencyKey: string, reason: string) {
    const entry = this.entriesByKey.get(idempotencyKey)
    if (!entry) return
    const failed: OutboxEntry = { ...entry, delivery: { state: 'failed', reason } }
    this.entriesByKey.set(idempotencyKey, failed)
    this.changed()
    // The in-memory state is already true. If this write fails, the entry resumes as "sending" after a restart, which is safe.
    void this.save(failed).catch(() => {})
  }

  private async save(entry: OutboxEntry) {
    await this.store.write(this.keyPrefix + entry.idempotencyKey, JSON.stringify(entry))
  }

  private async remove(idempotencyKey: string) {
    this.entriesByKey.delete(idempotencyKey)
    this.changed()
    await this.store.remove(this.keyPrefix + idempotencyKey)
  }

  /** The server was removed from this phone: its unsent messages go with it. */
  async forgetAll() {
    for (const key of [...this.entriesByKey.keys()]) await this.remove(key)
  }

  private changed() { for (const listener of this.changeListeners) listener() }
}

/** The entries still to show: once a message with an entry's key is listed, that message is its bubble, even if the
 *  command's own answer hasn't arrived. */
export function outboxEntriesNotYetListed(entries: readonly OutboxEntry[], messages: readonly MessageEntity[]) {
  const listedKeys = new Set(messages.flatMap((m) => (m.clientKey === null ? [] : [m.clientKey])))
  return entries.filter((entry) => !listedKeys.has(entry.idempotencyKey))
}

const sorted = (entries: OutboxEntry[]) => entries.sort((a, b) => a.createdAt - b.createdAt || a.idempotencyKey.localeCompare(b.idempotencyKey))

function parseJsonOrUndefined(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** Why a file didn't upload. An answer that says nothing names the file and its status, as the reference does (CHAT-73);
 * otherwise the reason is the server's or the connection's. */
export function uploadFailureText(fileName: string, failure: ApiFailure): string {
  return failure.kind === 'invalid_answer' ? `${fileName}: upload failed (${failure.status})` : failureText(failure)
}
