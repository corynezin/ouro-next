// The write side of the API. Each command is `POST /v2/commands/<name>` with a CommandRequest body and answers with its
// output schema or an ErrorResponse. Retrying with the same idempotency key returns the first result and repeats nothing.
import { z } from 'zod'
import { Address } from './address.ts'
import { AgentEntity, AskLevel, AskSnooze, BranchMerge, ModelId, PromptCacheLifetime } from './agent.ts'
import { BaseOffer } from './bases.ts'
import { ComputerEntity, ComputerInvite, ComputerTrust, RemoteAgentAction, RemoteAgentEntity, RemoteAskEntity } from './computers.ts'
import { AskEntity, ChatEntity, ChatTitle, DeviceEntity, ServerEntity, GoalEntity, GoalKind, PinEntity, PinTarget, ReadStateEntity } from './entities.ts'
import { DeliveryWake, MessageEntity } from './message.ts'
import { NotificationSettings, NotificationSettingsEntity, PushTokenRegistration } from './notifications.ts'

export const IdempotencyKey = z.string().min(8).max(200)
export type IdempotencyKey = z.infer<typeof IdempotencyKey>

export const CommandRequest = <I extends z.ZodType>(input: I) => z.object({ idempotencyKey: IdempotencyKey, input })

const AgentTarget = z.object({ agentId: z.string() })
const Empty = z.object({})
const GoalResult = z.object({ goal: GoalEntity })

/** Who may issue a command. An agent's identity comes from its own credential, never from the input. */
export type CommandCaller = 'person' | 'agent'

const defineCommand = <I extends z.ZodType, O extends z.ZodType>(callers: readonly CommandCaller[], input: I, output: O) =>
  ({ callers, input, output })

export const commands = {
  create_agent: defineCommand(['person', 'agent'], z.object({
    task: z.string().min(1),
    /** Null means generated from the task. */
    name: z.string().nullable(),
    /** Null means the server's default model. */
    model: ModelId.nullable(),
    /** Null means the caller's working folder, or the default projects folder for a person. */
    folder: z.string().nullable(),
    /** For models with a timed prompt cache. A 1 hour cache costs more to write and keeps an idle agent warm. */
    promptCacheLifetime: PromptCacheLifetime.default('5m'),
  }), z.object({ agent: AgentEntity })),

  send_message: defineCommand(['person', 'agent'], z.object({
    to: Address,
    text: z.string(),
    attachmentIds: z.array(z.string()),
    wake: DeliveryWake,
    /** Closes only this ask, instead of all of the recipient's open asks. */
    answersAskId: z.string().nullable(),
  }), z.object({ message: MessageEntity })),

  /** The same message to every other running agent, each in its direct chat with the sender. Stopped agents don't get it. */
  broadcast_message: defineCommand(['agent'], z.object({
    text: z.string(),
    attachmentIds: z.array(z.string()),
    wake: DeliveryWake,
  }), z.object({ messages: z.array(MessageEntity) })),

  /** A group chat post. `pendingAtHome`: the chat lives on another machine and this post is on its way there. */
  post_to_chat: defineCommand(['person', 'agent'], z.object({
    chatId: z.string(),
    text: z.string(),
    attachmentIds: z.array(z.string()),
  }), z.object({ message: MessageEntity, pendingAtHome: z.boolean() })),

  /** A group chat on this machine. The caller is a member too. */
  create_chat: defineCommand(['person', 'agent'], z.object({
    title: ChatTitle.nullable(),
    /** People and agents on this machine, and agents on the person's other computers as `name@machine`, besides the
     * caller. */
    members: z.array(Address),
  }), z.object({ chat: ChatEntity })),
  /** Anyone may add anyone to a group, themselves included: that is joining. */
  add_chat_member: defineCommand(['person', 'agent'], z.object({ chatId: z.string(), address: Address }), z.object({ chat: ChatEntity })),
  /** Anyone may remove anyone from a group, themselves included: that is leaving. Their earlier messages stay. */
  remove_chat_member: defineCommand(['person', 'agent'], z.object({ chatId: z.string(), address: Address }), z.object({ chat: ChatEntity })),

  /** Answers the last message the calling agent received, in the chat it came from. FYIs need no answer, so not those. */
  reply: defineCommand(['agent'], z.object({
    text: z.string(),
    attachmentIds: z.array(z.string()),
  }), z.object({ message: MessageEntity })),

  ask: defineCommand(['agent'], z.object({
    to: Address,
    text: z.string().min(1),
    level: AskLevel,
    choices: z.array(z.string().min(1).max(80)).max(6),
  }), z.object({ ask: AskEntity })),

  withdraw_ask: defineCommand(['agent'], z.object({ askId: z.string() }), Empty),

  /** Brings the calling agent's project memory and the person's shared notes together; Claude Code's hooks call it. */
  sync_memory: defineCommand(['agent'], Empty, Empty),

  /** An agent a person started passes their own words to an agent here, as theirs: their answer to a question, say. */
  relay_message: defineCommand(['agent'], z.object({
    to: Address,
    text: z.string().min(1),
    answersAskId: z.string().nullable(),
  }), z.object({ message: MessageEntity })),

  /** Reports to the parent and finishes. A later real message reopens it. `runningHelpers`: its helpers still running. */
  finish_agent: defineCommand(['agent'], z.object({ summary: z.string().min(1) }), z.object({ agent: AgentEntity, runningHelpers: z.array(z.string()) })),

  interrupt_agent: defineCommand(['person', 'agent'], AgentTarget, z.object({ agent: AgentEntity })),
  stop_agent: defineCommand(['person', 'agent'], AgentTarget, z.object({ agent: AgentEntity })),
  archive_agent: defineCommand(['person', 'agent'], AgentTarget, z.object({ agent: AgentEntity })),
  unarchive_agent: defineCommand(['person', 'agent'], AgentTarget, z.object({ agent: AgentEntity })),
  set_agent_model: defineCommand(['person', 'agent'], z.object({ agentId: z.string(), model: ModelId }), z.object({ agent: AgentEntity })),
  /** Merges the branch of an agent that works in its own worktree. Refused while it runs, and for one without a branch. */
  merge_agent_branch: defineCommand(['person', 'agent'], AgentTarget, z.object({ merge: BranchMerge })),

  /** Replaces any goal: counters restart, notes stay. */
  set_goal: defineCommand(['person', 'agent'], z.object({
    agentId: z.string(),
    text: z.string().min(1),
    kind: GoalKind,
    /** Null means the server's default. */
    intervalSeconds: z.number().int().nullable(),
  }), GoalResult),
  set_goal_interval: defineCommand(['person', 'agent'], z.object({ agentId: z.string(), intervalSeconds: z.number().int().nullable() }), GoalResult),
  pause_goal: defineCommand(['person', 'agent'], z.object({ agentId: z.string(), reason: z.string().nullable() }), GoalResult),
  resume_goal: defineCommand(['person', 'agent'], AgentTarget, GoalResult),
  /** A completed goal becomes active again, keeping its counters. */
  reopen_goal: defineCommand(['person', 'agent'], AgentTarget, GoalResult),
  /** Runs the goal's check first, if it has one. Refused for open-ended goals. */
  mark_goal_done: defineCommand(['person', 'agent'], z.object({ agentId: z.string(), summary: z.string().nullable() }), GoalResult),
  /** Removes the goal. The notes file stays. */
  clear_goal: defineCommand(['person', 'agent'], AgentTarget, Empty),

  /** Null means remind now. */
  snooze_ask: defineCommand(['person'], z.object({ askId: z.string(), snooze: AskSnooze.nullable() }), z.union([z.object({ ask: AskEntity }), z.object({ remoteAsk: RemoteAskEntity })])),

  /**
   * This phone's push token. A new one replaces the old; the device is the caller. `apnsConfigured`: whether this server
   * has an APNs key, so it can push at all. A token is kept either way, for when one is added.
   */
  register_push_token: defineCommand(['person'], PushTokenRegistration, z.object({ apnsConfigured: z.boolean() })),
  /** Stop pushing to this phone, such as before it forgets this server. */
  clear_push_token: defineCommand(['person'], Empty, Empty),
  set_notification_settings: defineCommand(['person'], NotificationSettings, z.object({ settings: NotificationSettingsEntity })),

  /**
   * This device is showing this agent. While a lease from any device lasts, the agent's live line refreshes. Renew
   * within WATCH_LEASE_MS to keep it; there is nothing to send when the screen closes.
   */
  watch_agent: defineCommand(['person'], AgentTarget, Empty),
  /**
   * Keeps an agent or group at the top of the person's lists, after their other pins. An agent calls it for its creator.
   * Pinning what is already pinned returns the pin as it is.
   */
  pin: defineCommand(['person', 'agent'], z.object({ target: PinTarget }), z.object({ pin: PinEntity })),
  /** Unpinning what isn't pinned does nothing. */
  unpin: defineCommand(['person', 'agent'], z.object({ target: PinTarget }), Empty),
  mark_chat_read: defineCommand(['person'], z.object({ chatId: z.string(), readThroughSeq: z.number().int().nonnegative() }), z.object({ readState: ReadStateEntity })),

  /** A one-time code for a new device of the owner, or for a named new person. */
  start_pairing: defineCommand(['person'], z.object({ inviteePersonName: z.string().nullable() }), z.object({
    code: z.string(),
    expiresAt: z.number().int(),
    link: z.string(),
  })),
  /** Owner and agents. A one-use invite for another computer, for 30 minutes; it replaces any open one. */
  create_computer_invite: defineCommand(['person', 'agent'], Empty, ComputerInvite),
  /** Owner and agents, on the computer joining: becomes a peer of the one at `address` that made the invite. */
  join_computer: defineCommand(['person', 'agent'], z.object({ address: z.string().url(), code: z.string().min(1) }), z.object({ computer: ComputerEntity })),
  /** Owner and agents. The other computer is told, if it can be reached; nothing on it is deleted. */
  remove_computer: defineCommand(['person', 'agent'], z.object({ computerId: z.string() }), Empty),
  /** Hands an agent to another of the person's computers, which must trust this one fully: at the end of its turn if it
   * is in one. Refused at once if that computer can't be reached or wouldn't take it. Its address here forwards. */
  move_agent: defineCommand(['person', 'agent'], z.object({ agentId: z.string(), computerId: z.string() }), z.object({ agent: AgentEntity })),
  /** Owner and agents. Starts an agent on another of the person's computers, which must trust this one fully, with the
   * caller as its parent (an agent's done report comes back to it). Made there at once, or refused with
   * `peer_unreachable` (safe to retry with the same key). `folder` is on that computer; null: its default projects folder. */
  create_remote_agent: defineCommand(['person', 'agent'], z.object({
    computerId: z.string(),
    task: z.string().min(1),
    name: z.string().nullable(),
    model: ModelId.nullable(),
    folder: z.string().nullable(),
    promptCacheLifetime: PromptCacheLifetime.default('5m'),
  }), z.object({ remoteAgent: RemoteAgentEntity })),
  /** Stop, interrupt, archive or change the model of an agent on another computer. Done there at once, or
   * refused with `peer_unreachable` (safe to retry with the same key); needs that computer's full trust. */
  control_remote_agent: defineCommand(['person', 'agent'], z.object({ remoteAgentId: z.string(), action: RemoteAgentAction }), z.object({ remoteAgent: RemoteAgentEntity })),
  set_computer_trust: defineCommand(['person', 'agent'], z.object({ computerId: z.string(), trust: ComputerTrust }), z.object({ computer: ComputerEntity })),
  /** Owner only. Raising a limit lets held agents carry on at once. */
  set_limits: defineCommand(['person'], z.object({
    agentLimit: z.number().int().min(1).max(64),
    budgetUsd: z.number().positive().nullable(),
  }), z.object({ server: ServerEntity })),
  /** Reads the plan's usage windows from its provider now, rather than after the next turn. */
  /** Starts taking base `n`, the one offered. The owner's, or an agent's for them. */
  take_base_update: defineCommand(['person', 'agent'], z.object({ n: z.number().int().positive() }), z.object({ server: ServerEntity })),
  /** Carries on with a base update once its conflicts are resolved and the merge is committed beside the live source. */
  continue_base_update: defineCommand(['agent'], Empty, z.object({ server: ServerEntity })),
  /**
   * Backs the source's own commits up: makes a private repository on the connected GitHub account (`ouro-next`, or
   * `ouro-next-<this server's name>` where that name is taken), makes it the source's `backup` remote and pushes the branch and
   * its base tags to it. Doing it again finds the backup. Refused with `github_not_connected`.
   */
  create_source_backup: defineCommand(['person'], Empty, z.object({ server: ServerEntity })),
  /** Pushes the source's branch and base tags to its backup now, rather than after the next deploy. Refused with `no_source_backup` before one. */
  push_source_backup: defineCommand(['person', 'agent'], Empty, z.object({ server: ServerEntity })),
  /**
   * Reads a provider's usage now, rather than after its next turn: ChatGPT's plan windows, which come back in
   * `server.planUsage`, or the OpenRouter key's spend and credits, which arrive in its `integration` entity. Refused with
   * `provider_unreachable` when the provider doesn't answer, the last reading kept.
   */
  refresh_plan_usage: defineCommand(['person'], z.object({ provider: z.enum(['chatgpt', 'openrouter']) }), z.object({ server: ServerEntity })),
  /** Owner only. Null turns auto-archive off. */
  set_auto_archive: defineCommand(['person'], z.object({ afterHours: z.number().positive().nullable() }), z.object({ server: ServerEntity })),
  /** Owner only. While off, replies owed at a turn's end are let go without a reminder, so turning it on again reminds of nothing from before. */
  set_reply_reminders: defineCommand(['person'], z.object({ on: z.boolean() }), z.object({ server: ServerEntity })),
  /** Owner only. Their devices stop connecting at once, and their open questions close; chats and messages stay. Inviting the name again brings them back. */
  remove_person: defineCommand(['person'], z.object({ personId: z.string() }), Empty),
  revoke_device: defineCommand(['person'], z.object({ deviceId: z.string() }), z.object({ device: DeviceEntity })),
} as const

export type CommandName = keyof typeof commands
/** What a caller sends: a field with a default may be left out. */
export type CommandInput<N extends CommandName> = z.input<(typeof commands)[N]['input']>
export type CommandOutput<N extends CommandName> = z.infer<(typeof commands)[N]['output']>

/** Default port of a server, for pairing input that gives a bare address. */
export const DEFAULT_SERVER_PORT = 8790

/** How long one `watch_agent` lasts. */
export const WATCH_LEASE_MS = 45_000

// Uploads are raw bytes, not a command: `POST /v2/attachments` with content-type = the MIME type, `x-file-name` = the
// URL-encoded name, answering an AttachmentRef. Bytes come back from `GET /v2/attachments/<id>` with the same bearer token.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// Pairing has no device yet, so it isn't a command: `POST /v2/pair` with this body, no token needed.
export const PairRequest = z.object({ code: z.string().min(1), deviceName: z.string().min(1) })
export type PairRequest = z.infer<typeof PairRequest>
export const PairResponse = z.object({
  /** Shown once and stored only as a hash on the server. */
  deviceToken: z.string(),
  deviceId: z.string(),
  personId: z.string(),
  machineId: z.string(),
  machineName: z.string(),
})
export type PairResponse = z.infer<typeof PairResponse>
