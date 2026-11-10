// The read side of the API: a snapshot, then one ordered stream of changes from its cursor.
import { z } from 'zod'
import { Address } from './address.ts'
import { AgentEntity } from './agent.ts'
import {
  AskEntity, ChatEntity, DeviceEntity, GoalEntity, PersonEntity, ReadStateEntity, ServerEntity, SummaryEntity, SummaryRecord,
} from './entities.ts'
import { MessageEntity } from './message.ts'
import { ComputerEntity, RemoteAgentEntity, RemoteAskEntity } from './computers.ts'
import { IntegrationEntity } from './integrations.ts'
import { NotificationSettingsEntity } from './notifications.ts'
import { PublishedUpdate } from './updates.ts'

/** Who is looking. Addresses in every entity are absolute, so "mine" means `from === viewer.address`. */
export const Viewer = z.object({
  address: Address,
  personId: z.string(),
  personName: z.string(),
  isOwner: z.boolean(),
  deviceId: z.string(),
  deviceName: z.string(),
})
export type Viewer = z.infer<typeof Viewer>

export const Snapshot = z.object({
  /** A new epoch means the change log was reset: discard everything and take a new snapshot. */
  epoch: z.string(),
  cursor: z.number().int().nonnegative(),
  viewer: Viewer,
  server: ServerEntity,
  agents: z.array(AgentEntity),
  chats: z.array(ChatEntity),
  readStates: z.array(ReadStateEntity),
  asks: z.array(AskEntity),
  goals: z.array(GoalEntity),
  summaries: z.array(SummaryEntity),
  people: z.array(PersonEntity),
  devices: z.array(DeviceEntity),
  notificationSettings: NotificationSettingsEntity,
  integrations: z.array(IntegrationEntity),
  computers: z.array(ComputerEntity),
  remoteAgents: z.array(RemoteAgentEntity),
  remoteAsks: z.array(RemoteAskEntity),
})
export type Snapshot = z.infer<typeof Snapshot>

const upsert = <E extends string, S extends z.ZodType>(entity: E, value: S) =>
  z.object({ cursor: z.number().int().positive(), entity: z.literal(entity), id: z.string(), op: z.literal('upsert'), value })

// A value is always the entity's latest state, so a client that missed several changes to one entity sees one.
export const EntityUpsert = z.discriminatedUnion('entity', [
  upsert('server', ServerEntity),
  upsert('agent', AgentEntity),
  upsert('message', MessageEntity),
  upsert('chat', ChatEntity),
  upsert('read_state', ReadStateEntity),
  upsert('ask', AskEntity),
  upsert('goal', GoalEntity),
  upsert('summary', SummaryEntity),
  upsert('person', PersonEntity),
  upsert('device', DeviceEntity),
  upsert('notification_settings', NotificationSettingsEntity),
  upsert('integration', IntegrationEntity),
  upsert('computer', ComputerEntity),
  upsert('remote_agent', RemoteAgentEntity),
  upsert('remote_ask', RemoteAskEntity),
])
export type EntityUpsert = z.infer<typeof EntityUpsert>

export const EntityDeletion = z.object({
  cursor: z.number().int().positive(),
  entity: z.enum(['server', 'agent', 'message', 'chat', 'read_state', 'ask', 'goal', 'summary', 'person', 'device', 'notification_settings', 'integration', 'computer', 'remote_agent', 'remote_ask']),
  id: z.string(),
  op: z.literal('delete'),
})
export type EntityDeletion = z.infer<typeof EntityDeletion>

export const Change = z.union([EntityUpsert, EntityDeletion])
export type Change = z.infer<typeof Change>

/** The server writes an SSE comment at least this often, starting when the stream opens. Silence well past it means dead. */
export const CHANGES_HEARTBEAT_MS = 15_000

/** One frame of `GET /v2/changes?epoch=<epoch>&after=<cursor>`, as an SSE `data:` line. */
export const SyncFrame = z.discriminatedUnion('frame', [
  z.object({ frame: z.literal('change'), change: Change }),
  /** Everything up to `cursor` has been sent. Later frames are live. */
  z.object({ frame: z.literal('caught_up'), cursor: z.number().int().nonnegative() }),
  /** The given epoch is no longer current. The stream ends after this frame. */
  z.object({ frame: z.literal('resync_required'), epoch: z.string() }),
])
export type SyncFrame = z.infer<typeof SyncFrame>

export const HistoryPage = z.object({
  /** Oldest first. */
  messages: z.array(MessageEntity),
  /** Pass the first message's `seq` as `before` to continue. */
  hasOlder: z.boolean(),
})
export type HistoryPage = z.infer<typeof HistoryPage>

/** `GET /v2/agents/<id>/summaries?before=<number>&limit=<n>`. */
export const SummaryPage = z.object({
  /** Newest first. */
  summaries: z.array(SummaryRecord),
  /** Pass the last summary's `number` as `before` to continue. */
  hasOlder: z.boolean(),
})
export type SummaryPage = z.infer<typeof SummaryPage>

export const LogRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('incoming'), at: z.number().int(), from: Address, text: z.string() }),
  z.object({ kind: z.literal('text'), at: z.number().int(), text: z.string() }),
  z.object({ kind: z.literal('tool_use'), at: z.number().int(), toolName: z.string(), input: z.string() }),
  z.object({ kind: z.literal('tool_result'), at: z.number().int(), text: z.string(), isError: z.boolean() }),
  z.object({ kind: z.literal('notice'), at: z.number().int(), text: z.string() }),
])
export type LogRecord = z.infer<typeof LogRecord>

export const LogPage = z.object({
  records: z.array(LogRecord),
  /** Byte offsets into the agent's journal. Pass `endCursor` as `after` to follow, `startCursor` as `before` for earlier. */
  startCursor: z.number().int().nonnegative(),
  endCursor: z.number().int().nonnegative(),
  hasEarlier: z.boolean(),
})
export type LogPage = z.infer<typeof LogPage>

/** Unauthenticated, for pairing screens and for the guardian's probe of who is answering. */
export const ServerIdentity = z.object({
  app: z.literal('ouro'),
  machineName: z.string(),
  machineId: z.string(),
  releaseId: z.string(),
  apiVersion: z.literal(2),
  /** The newest phone update, so the guardian can check the live manifest from outside. */
  latestUpdate: PublishedUpdate.nullable(),
})
export type ServerIdentity = z.infer<typeof ServerIdentity>
