// Unsent text, per conversation and per server, surviving a kill and an update restart.
import type { DurableStore } from '../platform/ports.ts'

export class ServerDrafts {
  private readonly store: DurableStore
  private readonly keyPrefix: string
  private textByConversation = new Map<string, string>()

  constructor(store: DurableStore, serverId: string) {
    this.store = store
    this.keyPrefix = `draft/${serverId}/`
  }

  async load() {
    for (const { key, value } of await this.store.readKeysWithPrefix(this.keyPrefix)) {
      this.textByConversation.set(key.slice(this.keyPrefix.length), value)
    }
  }

  textOf(conversationId: string) { return this.textByConversation.get(conversationId) ?? '' }

  /** The text is current at once; a failed save only loses the draft if the app is then killed. */
  setText(conversationId: string, text: string) {
    const key = this.keyPrefix + conversationId
    if (text) {
      this.textByConversation.set(conversationId, text)
      void this.store.write(key, text).catch(() => {})
    } else {
      this.textByConversation.delete(conversationId)
      void this.store.remove(key).catch(() => {})
    }
  }
}
