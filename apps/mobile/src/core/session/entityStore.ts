// Everything known about one server. Entities are replaced, never edited, so a selector can compare by identity and one
// agent's change doesn't re-render a list of others.
import type {
  AgentEntity, AskEntity, Change, ChatEntity, ComputerEntity, DeviceEntity, EntityKind, EntityOfKind, GoalEntity, HistoryPage, IntegrationEntity,
  IntegrationProvider, MessageEntity, NotificationSettingsEntity, PersonEntity, ReadStateEntity, RemoteAgentEntity, RemoteAskEntity, ServerEntity, Snapshot,
  SummaryEntity, Viewer,
} from '@ouro/contract'

/** What is loaded of one chat. Created by the first history page: changes to a chat nobody has opened aren't kept. */
export interface ChatTimeline {
  /** Oldest first, by `seq`. Replaced on each change. */
  messages: readonly MessageEntity[]
  /** There are messages older than the first one here. */
  hasOlder: boolean
}

type EntityMaps = { [K in Exclude<EntityKind, 'server' | 'message'>]: Map<string, EntityOfKind<K>> }

export class EntityStore {
  private entities: EntityMaps = emptyEntities()
  private timelines = new Map<string, ChatTimeline>()
  private serverEntity: ServerEntity | null = null
  private viewerEntity: Viewer | null = null
  private snapshotEpoch: string | null = null
  private appliedCursor = 0
  private listeners = new Set<() => void>()
  private notifyScheduled = false

  get epoch() { return this.snapshotEpoch }
  get cursor() { return this.appliedCursor }
  get viewer() { return this.viewerEntity }
  get server() { return this.serverEntity }
  get agents(): ReadonlyMap<string, AgentEntity> { return this.entities.agent }
  get chats(): ReadonlyMap<string, ChatEntity> { return this.entities.chat }
  get readStates(): ReadonlyMap<string, ReadStateEntity> { return this.entities.read_state }
  get asks(): ReadonlyMap<string, AskEntity> { return this.entities.ask }
  get goals(): ReadonlyMap<string, GoalEntity> { return this.entities.goal }
  get summaries(): ReadonlyMap<string, SummaryEntity> { return this.entities.summary }
  get people(): ReadonlyMap<string, PersonEntity> { return this.entities.person }
  get devices(): ReadonlyMap<string, DeviceEntity> { return this.entities.device }
  get computers(): ReadonlyMap<string, ComputerEntity> { return this.entities.computer }
  get remoteAgents(): ReadonlyMap<string, RemoteAgentEntity> { return this.entities.remote_agent }
  get remoteAsks(): ReadonlyMap<string, RemoteAskEntity> { return this.entities.remote_ask }
  /** The viewer's own; the server sends only theirs. */
  get notificationSettings(): NotificationSettingsEntity | undefined {
    return this.viewerEntity ? this.entities.notification_settings.get(this.viewerEntity.personId) : undefined
  }
  /** Absent until the server has first asked that provider's tool. */
  integration<P extends IntegrationProvider>(provider: P): Extract<IntegrationEntity, { provider: P }> | null {
    // The id is the provider, so the entity under it is that provider's.
    return (this.entities.integration.get(provider) ?? null) as Extract<IntegrationEntity, { provider: P }> | null
  }
  timeline(chatId: string): ChatTimeline | undefined { return this.timelines.get(chatId) }
  readStateOfChat(chatId: string) {
    for (const readState of this.entities.read_state.values()) if (readState.chatId === chatId) return readState
    return undefined
  }

  /** A snapshot replaces everything. Timelines survive only if the epoch hasn't changed: their history is still valid. */
  applySnapshot(snapshot: Snapshot) {
    if (this.snapshotEpoch !== null && this.snapshotEpoch !== snapshot.epoch) this.timelines = new Map()
    this.snapshotEpoch = snapshot.epoch
    this.appliedCursor = snapshot.cursor
    this.viewerEntity = snapshot.viewer
    this.serverEntity = snapshot.server
    this.entities = {
      agent: byId(snapshot.agents),
      chat: byId(snapshot.chats),
      read_state: byId(snapshot.readStates),
      ask: byId(snapshot.asks),
      goal: byId(snapshot.goals),
      summary: byId(snapshot.summaries),
      person: byId(snapshot.people),
      device: byId(snapshot.devices),
      notification_settings: byId([snapshot.notificationSettings]),
      integration: byId(snapshot.integrations),
      computer: byId(snapshot.computers),
      remote_agent: byId(snapshot.remoteAgents),
      remote_ask: byId(snapshot.remoteAsks),
    }
    this.changed()
  }

  /** Applying a change at or before the cursor does nothing, so a replay after a reconnect can't apply twice. */
  applyChange(change: Change) {
    if (change.cursor <= this.appliedCursor) return
    this.appliedCursor = change.cursor
    if (change.op === 'upsert') this.applyUpsert(change)
    else this.applyDeletion(change.entity, change.id)
    this.changed()
  }

  private applyUpsert(change: Extract<Change, { op: 'upsert' }>) {
    switch (change.entity) {
      case 'server': this.serverEntity = change.value; return
      case 'message': this.putTimelineMessage(change.value); return
      case 'agent': this.entities.agent.set(change.id, change.value); return
      case 'chat': this.entities.chat.set(change.id, change.value); return
      case 'read_state': this.entities.read_state.set(change.id, change.value); return
      case 'ask': this.entities.ask.set(change.id, change.value); return
      case 'goal': this.entities.goal.set(change.id, change.value); return
      case 'summary': this.entities.summary.set(change.id, change.value); return
      case 'person': this.entities.person.set(change.id, change.value); return
      case 'device': this.entities.device.set(change.id, change.value); return
      case 'notification_settings': this.entities.notification_settings.set(change.id, change.value); return
      case 'integration': this.entities.integration.set(change.id, change.value); return
      case 'computer': this.entities.computer.set(change.id, change.value); return
      case 'remote_agent': this.entities.remote_agent.set(change.id, change.value); return
      case 'remote_ask': this.entities.remote_ask.set(change.id, change.value); return
    }
  }

  private applyDeletion(kind: EntityKind, id: string) {
    if (kind === 'server') return // a singleton: the server can't delete itself
    if (kind === 'message') {
      for (const [chatId, timeline] of this.timelines) {
        if (timeline.messages.some((m) => m.id === id)) {
          this.timelines.set(chatId, { ...timeline, messages: timeline.messages.filter((m) => m.id !== id) })
        }
      }
      return
    }
    this.entities[kind].delete(id)
  }

  /** A command's own answer: an agent it just created, say. Changes carry the same fact and may have arrived first. */
  putAgentIfAbsent(agent: AgentEntity) {
    if (this.entities.agent.has(agent.id)) return
    this.entities.agent.set(agent.id, agent)
    this.changed()
  }

  /** A command's answer is older than or equal to whatever changes delivered, so it never overwrites. */
  putMessageIfAbsent(message: MessageEntity) {
    const timeline = this.timelines.get(message.chatId)
    if (!timeline || timeline.messages.some((m) => m.id === message.id)) return
    this.putTimelineMessage(message)
    this.changed()
  }

  applyHistoryPage(chatId: string, page: HistoryPage, kind: 'latest' | 'older') {
    const current = this.timelines.get(chatId)
    // After a long absence the latest page may not join up with what's loaded: keep the page, drop what can't be connected.
    const joins = current && (kind === 'older' || !page.hasOlder || !isDetached(current.messages, page.messages))
    const kept = joins ? current.messages : []
    const merged = mergeBySeq(kept, page.messages)
    const hasOlder = kind === 'older' || !joins ? page.hasOlder : current.hasOlder
    this.timelines.set(chatId, { messages: merged, hasOlder })
    this.changed()
  }

  private putTimelineMessage(message: MessageEntity) {
    const timeline = this.timelines.get(message.chatId)
    if (!timeline) return
    this.timelines.set(message.chatId, { ...timeline, messages: mergeBySeq(timeline.messages, [message]) })
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed() {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      for (const listener of this.listeners) listener()
    })
  }
}

function emptyEntities(): EntityMaps {
  return {
    agent: new Map(), chat: new Map(), read_state: new Map(), ask: new Map(), goal: new Map(), summary: new Map(), person: new Map(), device: new Map(), notification_settings: new Map(), integration: new Map(), computer: new Map(), remote_agent: new Map(), remote_ask: new Map(),
  }
}

function byId<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item]))
}

function isDetached(loaded: readonly MessageEntity[], page: readonly MessageEntity[]) {
  const newestLoaded = loaded.at(-1)
  const oldestOfPage = page[0]
  return !!newestLoaded && !!oldestOfPage && oldestOfPage.seq > newestLoaded.seq
}

/** `incoming` wins over `existing` for the same message: it's the newer read. */
export function mergeBySeq(existing: readonly MessageEntity[], incoming: readonly MessageEntity[]): readonly MessageEntity[] {
  if (incoming.length === 1) {
    const message = incoming[0]!
    const newest = existing.at(-1)
    if (!newest || message.seq > newest.seq) return [...existing, message]
  }
  const bySeq = new Map(existing.map((m) => [m.seq, m]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
