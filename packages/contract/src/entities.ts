// Everything but agents and messages that travels through the change log.
import { z } from 'zod'
import { Address } from './address.ts'
import { AgentEntity, AskLevel, AskSnooze, ModelId } from './agent.ts'
import { MessageEntity } from './message.ts'
import { ComputerEntity, RemoteAgentEntity, RemoteAskEntity } from './computers.ts'
import { IntegrationEntity } from './integrations.ts'
import { NotificationSettingsEntity } from './notifications.ts'
import { BaseStatus, SourceBackup } from './bases.ts'
import { PlanUsage, windowLabel } from './usage.ts'

export const ChatMember = z.object({ address: Address, joinedAt: z.number().int() })
export type ChatMember = z.infer<typeof ChatMember>

export const MessagePreview = z.object({ seq: z.number().int(), from: Address, at: z.number().int(), text: z.string() })
export type MessagePreview = z.infer<typeof MessagePreview>

export const ChatEntity = z.object({
  id: z.string(),
  kind: z.enum(['direct', 'group']),
  /** Group chats have a name. A direct chat is named by its other member. */
  title: z.string().nullable(),
  members: z.array(ChatMember),
  createdBy: Address,
  createdAt: z.number().int(),
  homeMachine: z.string(),
  latestMessage: MessagePreview.nullable(),
})
export type ChatEntity = z.infer<typeof ChatEntity>

/** A group's name as people write it: one name per machine. */
export const ChatTitle = z.string().trim().min(1).max(60)

/**
 * How agents and the command line name a group: `#` and its title as one lowercase word, or its id when it has no title.
 * Titles are unique by handle on their machine.
 */
export function chatHandle(chat: Pick<ChatEntity, 'id' | 'title'>): string {
  return `#${chat.title === null ? chat.id : chat.title.trim().toLowerCase().replace(/\s+/g, '-')}`
}

/** One viewer's place in one chat. Visible only to that viewer. */
export const ReadStateEntity = z.object({
  id: z.string(),
  chatId: z.string(),
  readThroughSeq: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
})
export type ReadStateEntity = z.infer<typeof ReadStateEntity>

export const AskSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent') }),
  /** Raised by the system for a problem; closed by the system when the cause clears. */
  z.object({ kind: z.literal('system'), problem: z.enum(['logged_out', 'budget', 'usage_limit', 'credits', 'no_slot', 'goal', 'crash_loop', 'no_progress']) }),
])
export type AskSource = z.infer<typeof AskSource>

export const AskEntity = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  /** Who is being asked. */
  to: Address,
  level: AskLevel,
  text: z.string(),
  choices: z.array(z.string().max(80)).max(6),
  source: AskSource,
  at: z.number().int(),
  /** Null means not snoozed. */
  snooze: AskSnooze.nullable(),
})
export type AskEntity = z.infer<typeof AskEntity>

/** Why an active goal isn't cycling right now. */
export const GoalWait = z.discriminatedUnion('kind', [
  /** Interrupted: cycles resume after the next real message. */
  z.object({ kind: z.literal('next_message_after_interrupt') }),
  /** Recent cycles failed: the next waits longer. */
  z.object({ kind: z.literal('backoff'), until: z.number().int(), consecutiveFailures: z.number().int().positive() }),
  /** The agent can't run now, such as when it's held or deliberately stopped. */
  z.object({ kind: z.literal('agent_unavailable') }),
  /** The plan's window is used past what goal cycles may take, until it resets: what's left is for people's messages. */
  z.object({ kind: z.literal('plan_usage'), windowMinutes: z.number().int().positive(), usedFraction: z.number().min(0), resetsAt: z.number().int() }),
])
export type GoalWait = z.infer<typeof GoalWait>

/** The words for why a goal is waiting, shared by the app and the CLI. */
export function goalWaitText(wait: GoalWait): string {
  switch (wait.kind) {
    case 'next_message_after_interrupt': return 'interrupted, until the next message'
    case 'backoff': return `${wait.consecutiveFailures} failed cycle${wait.consecutiveFailures === 1 ? '' : 's'}, retrying later`
    case 'agent_unavailable': return "the agent can't run now"
    case 'plan_usage': return `${windowLabel(wait.windowMinutes)} usage ${Math.round(wait.usedFraction * 100)}%, until it resets`
  }
}

export const GoalStatus = z.discriminatedUnion('status', [
  /** `nextCycleAt` is null while a cycle runs, or while waiting for the agent to go idle. */
  z.object({ status: z.literal('active'), waitingFor: GoalWait.nullable(), nextCycleAt: z.number().int().nullable(), cycleRunning: z.boolean() }),
  z.object({ status: z.literal('paused'), by: Address, reason: z.string().nullable(), at: z.number().int() }),
  z.object({ status: z.literal('complete'), at: z.number().int(), summary: z.string() }),
])
export type GoalStatus = z.infer<typeof GoalStatus>

export const GoalKind = z.discriminatedUnion('kind', [
  /** Completes when the agent says it's done. */
  z.object({ kind: z.literal('finishing') }),
  /** Never completes. Done is refused. */
  z.object({ kind: z.literal('open_ended') }),
  /** Completes only when this command, run in the agent's folder, succeeds. */
  z.object({ kind: z.literal('checked'), checkCommand: z.string().min(1) }),
])
export type GoalKind = z.infer<typeof GoalKind>

export const MIN_GOAL_INTERVAL_SECONDS = 5
export const MAX_GOAL_INTERVAL_SECONDS = 7 * 24 * 60 * 60
export const DEFAULT_GOAL_INTERVAL_SECONDS = 30

export const GoalInterval = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default'), seconds: z.number().int().positive() }),
  z.object({ kind: z.literal('chosen'), seconds: z.number().int().min(MIN_GOAL_INTERVAL_SECONDS).max(MAX_GOAL_INTERVAL_SECONDS) }),
])
export type GoalInterval = z.infer<typeof GoalInterval>

export const GoalEntity = z.object({
  /** One per agent, so this is the agent's id. */
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  kind: GoalKind,
  status: GoalStatus,
  cycleCount: z.number().int().nonnegative(),
  interval: GoalInterval,
  /** Spent on cycles since the goal was set. */
  costUsd: z.number(),
  setBy: Address,
  setAt: z.number().int(),
  /** The agent's own notes, kept in its notes file. They survive replacing and clearing the goal. */
  notes: z.string(),
})
export type GoalEntity = z.infer<typeof GoalEntity>

/** What an agent had been doing, written by a cheap model. */
export const SummaryRecord = z.object({
  /** The agent's first summary is 1, then 2, and so on. */
  number: z.number().int().positive(),
  at: z.number().int(),
  /** Fits one row on a phone. */
  line: z.string(),
  details: z.array(z.string()),
  /** When the newest activity it covers happened: anything after is not in it. */
  coversThroughAt: z.number().int(),
})
export type SummaryRecord = z.infer<typeof SummaryRecord>

export const SummaryEntity = z.object({
  /** One per agent, so this is the agent's id. Older summaries are a paged read. */
  id: z.string(),
  agentId: z.string(),
  latest: SummaryRecord.nullable(),
  live: z.object({ at: z.number().int(), line: z.string(), coversThroughAt: z.number().int() }).nullable(),
  /** Set while the most recent attempt failed. */
  lastFailure: z.object({ at: z.number().int(), message: z.string() }).nullable(),
})
export type SummaryEntity = z.infer<typeof SummaryEntity>

export const PersonEntity = z.object({
  id: z.string(),
  name: z.string(),
  address: Address,
  isOwner: z.boolean(),
  joinedAt: z.number().int(),
})
export type PersonEntity = z.infer<typeof PersonEntity>

export const DeviceEntity = z.object({
  id: z.string(),
  name: z.string(),
  personId: z.string(),
  pairedAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
})
export type DeviceEntity = z.infer<typeof DeviceEntity>

export const ModelOption = z.object({
  id: ModelId,
  label: z.string(),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'stand_in']),
  available: z.boolean(),
})
export type ModelOption = z.infer<typeof ModelOption>

/** This machine as a whole. A singleton: its id is always `server`. */
export const ServerEntity = z.object({
  id: z.literal('server'),
  machineName: z.string(),
  /** `version`: the Ouro version this server runs (`0.5.0`), from its package.json; null before versions, absent from an older server. */
  release: z.object({ id: z.string(), base: BaseStatus, version: z.string().nullable().optional() }),
  sourceBackup: SourceBackup,
  defaultModel: ModelId,
  models: z.array(ModelOption),
  limits: z.object({
    agentLimit: z.number().int(),
    idleFoldMinutes: z.number().int().nullable(),
    /** What all agents together may spend, in USD; null: no budget. Spent is the sum of the agents' costs. */
    budgetUsd: z.number().positive().nullable(),
    /** Agents done and quiet this long, with nothing still depending on them, are archived; null: never. */
    autoArchiveAfterHours: z.number().positive().nullable(),
    /** A turn that ends with a message still owed a reply gets one reminder. On unless the owner turns it off. */
    replyReminders: z.boolean(),
  }),
  /**
   * The subscriptions' usage windows as this server last read them; null: not read yet. Claude's come with agents' turns;
   * ChatGPT's from Codex, after its turns and on `refresh_plan_usage`.
   */
  planUsage: z.object({ claude: PlanUsage.nullable(), chatgpt: PlanUsage.nullable() }),
})
export type ServerEntity = z.infer<typeof ServerEntity>

// Each entry is both a change-log entity kind and a snapshot section. Messages are the exception: the snapshot leaves
// them out, since a chat's history is a paged read.
export const entitySchemas = {
  server: ServerEntity,
  agent: AgentEntity,
  message: MessageEntity,
  chat: ChatEntity,
  read_state: ReadStateEntity,
  ask: AskEntity,
  goal: GoalEntity,
  summary: SummaryEntity,
  person: PersonEntity,
  device: DeviceEntity,
  notification_settings: NotificationSettingsEntity,
  integration: IntegrationEntity,
  computer: ComputerEntity,
  remote_agent: RemoteAgentEntity,
  remote_ask: RemoteAskEntity,
} as const
export type EntityKind = keyof typeof entitySchemas
export type EntityOfKind<K extends EntityKind> = z.infer<(typeof entitySchemas)[K]>
