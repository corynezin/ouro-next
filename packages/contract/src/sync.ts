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

/** Why an agent has no model requests to show: it isn't on Claude Code, it hasn't started a conversation, or the
 * conversation's transcript isn't on this computer. The app words each. */
export const ContextUnavailable = z.enum(['not_claude_code', 'no_conversation', 'transcript_missing'])
export type ContextUnavailable = z.infer<typeof ContextUnavailable>

/** How many requests a Context list page holds when the app doesn't say. */
export const CONTEXT_PAGE_DEFAULT_LIMIT = 50

/** `GET /v2/agents/<id>/context?before=<n>&limit=<k>`: one row per model request the agent made. Tokens are exact, from the API's own usage. */
export const ContextRequestRow = z.object({
  n: z.number().int().nonnegative(),
  at: z.number().int(),
  model: z.string(),
  messageCount: z.number().int(),
  /** Everything sent: uncached + cache read + cache written. Null when the request got no usage back. */
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
})
export type ContextRequestRow = z.infer<typeof ContextRequestRow>

export const ContextList = z.object({
  /** Newest first. */
  requests: z.array(ContextRequestRow),
  /** Pass the last request's `n` as `before` to continue. */
  hasOlder: z.boolean(),
  /** Why there is nothing to show, when there is nothing. */
  unavailable: ContextUnavailable.nullable(),
})
export type ContextList = z.infer<typeof ContextList>

/** What a request's input tokens went on. The app colours and words each. */
export const ContextCategory = z.enum(['system', 'tools', 'system_reminders', 'user_text', 'attachments', 'assistant_text', 'tool_calls', 'tool_results', 'thinking'])
export type ContextCategory = z.infer<typeof ContextCategory>

/** A block's kind as the API names it; `other` for kinds this viewer doesn't know, named in the block's label. */
export const ContextBlockKind = z.enum(['text', 'thinking', 'tool_use', 'tool_result', 'image', 'document', 'other'])
export type ContextBlockKind = z.infer<typeof ContextBlockKind>

export const ContextBlock = z.object({
  type: ContextBlockKind,
  /** A tool's name, or for `other` the API's own name for the block. */
  label: z.string(),
  text: z.string(),
  /** Estimated; see ContextDetail.exact. */
  tokens: z.number().int(),
  truncated: z.boolean(),
})
export type ContextBlock = z.infer<typeof ContextBlock>

/** `system`: what Claude Code adds mid-conversation (reminders, tools that became available), sent as messages of their own. */
export const ContextRole = z.enum(['user', 'assistant', 'system'])
export type ContextRole = z.infer<typeof ContextRole>

/** One message sent with a request, or one the transcript doesn't hold. */
export const ContextMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), role: ContextRole, blocks: z.array(ContextBlock) }),
  z.object({ kind: z.literal('unresolved') }),
])
export type ContextMessage = z.infer<typeof ContextMessage>

export const ContextBlockPart = z.enum(['system', 'message', 'response'])
export type ContextBlockPart = z.infer<typeof ContextBlockPart>
/** Where a block sits in a request: system block `item`; block `block` of message `item`; or block `block` of the reply. */
export const ContextBlockPlace = z.object({ part: ContextBlockPart, item: z.number().int().nonnegative(), block: z.number().int().nonnegative() })
export type ContextBlockPlace = z.infer<typeof ContextBlockPlace>

/** `GET /v2/agents/<id>/context/<n>/text?part=system|message|response&i=<item>&k=<block>`: one block, uncut. */
export const ContextBlockText = z.object({ text: z.string() })
export type ContextBlockText = z.infer<typeof ContextBlockText>

/** `GET /v2/agents/<id>/context/<n>`: everything sent with request n, and what came back. */
export const ContextDetail = z.object({
  n: z.number().int(),
  at: z.number().int(),
  model: z.string(),
  usage: z.object({ uncached: z.number().int(), cacheRead: z.number().int(), cacheWrite: z.number().int(), output: z.number().int(), totalInput: z.number().int() }).nullable(),
  /** True when the per-item counts were scaled to the API's reported input total; false when they are raw estimates. */
  exact: z.boolean(),
  totalInput: z.number().int(),
  categories: z.array(z.object({ name: ContextCategory, tokens: z.number().int() })),
  system: z.array(ContextBlock),
  tools: z.array(z.object({ name: z.string(), description: z.string(), tokens: z.number().int() })),
  messages: z.array(ContextMessage),
  response: z.array(ContextBlock),
})
export type ContextDetail = z.infer<typeof ContextDetail>

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
