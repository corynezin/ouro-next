// The person's other computers running Ouro: peers of this server. Each is an entity, `computer`, with the peer's machine
// id as its id. Peers talk over their own API, `/peer/v1`, with requests signed by each machine's Ed25519 key; those wire
// shapes are here too, since both ends are Ouro servers.
import { z } from 'zod'
import { AgentState, AskLevel, AskSnooze, ModelId, PromptCacheLifetime } from './agent.ts'
import { ErrorCode } from './errors.ts'

/** Full: anything a local person or agent may do. Limited: messages only, and it sees only names and running or not. */
export const ComputerTrust = z.enum(['full', 'limited'])
export type ComputerTrust = z.infer<typeof ComputerTrust>

/** From when it last answered: online within about 10 seconds, reconnecting within about 45, otherwise offline. */
export const ComputerStatus = z.enum(['online', 'reconnecting', 'offline'])
export type ComputerStatus = z.infer<typeof ComputerStatus>

export const ComputerEntity = z.object({
  id: z.string(),
  name: z.string(),
  trust: ComputerTrust,
  status: ComputerStatus,
  /** When it last answered; null: not yet. */
  lastSeenAt: z.number().int().nullable(),
  /** What it last said about itself; null until it has answered once. */
  release: z.string().nullable(),
  agentsRunning: z.number().int().nonnegative().nullable(),
  agentCount: z.number().int().nonnegative().nullable(),
  /** Why the two can't work together (their protocol versions don't overlap), fit to show; null: they can. */
  incompatibility: z.string().nullable(),
  joinedAt: z.number().int(),
  /** Where its peer API is reached, which is also the URL a phone pairs with; absent from servers before it was sent. */
  address: z.string().nullable().optional(),
})
export type ComputerEntity = z.infer<typeof ComputerEntity>

/** One open invite at a time: making one replaces the last. `command` is the line to run on the other computer. */
/**
 * A one-use invite to link a computer. `command` is for a person to run (`ouro computers join <address> <code>`); a
 * program joins with `address` and `code`. `address` is absent from servers before it was sent.
 */
export const ComputerInvite = z.object({ code: z.string(), expiresAt: z.number().int(), command: z.string(), address: z.string().optional() })
export type ComputerInvite = z.infer<typeof ComputerInvite>

// Machine to machine.

export const PEER_API_PREFIX = '/peer/v1'

/** The wire protocol this release speaks, and the oldest it still speaks. Two machines work together when each one's
 * protocol is within the other's range. `hello` and `forget` keep their shapes forever, so any two versions can see each
 * other and part; every other request passes only between machines that work together. */
export const PEER_PROTOCOL = 6
export const PEER_MIN_PROTOCOL = 1
/** The first protocol with POST /owner-messages: a machine sends it only to peers that speak it. */
export const PEER_OWNER_MESSAGES_PROTOCOL = 2
/** The first protocol with POST /owner-asks and a message's `answersAskId`: a machine sends them only to peers that speak it. */
export const PEER_OWNER_ASKS_PROTOCOL = 3
/** The first protocol with POST /memory: a machine asks it only of peers that speak it. */
export const PEER_MEMORY_PROTOCOL = 4
/** The first protocol with POST /owner-ask-snoozes and the `snooze_changed` owner-ask update: a machine sends them only to
 * peers that speak it. */
export const PEER_ASK_SNOOZE_PROTOCOL = 5
/** The first protocol with POST /log: a machine asks it only of peers that speak it. */
export const PEER_LOG_PROTOCOL = 6

/** A machine as it introduces itself. `address`: where its peer API is reached. */
export const PeerIdentity = z.object({
  machineId: z.string(),
  name: z.string(),
  address: z.string(),
  /** Ed25519, SPKI PEM. */
  publicKey: z.string(),
  protocol: z.number().int(),
  minProtocol: z.number().int(),
})
export type PeerIdentity = z.infer<typeof PeerIdentity>

/** POST /join, the one unsigned request: the invite's code is its credential. Answers the inviting machine's identity. */
export const PeerJoinRequest = z.object({ code: z.string(), joiner: PeerIdentity })
export type PeerJoinRequest = z.infer<typeof PeerJoinRequest>
export const PeerJoinResult = z.object({ host: PeerIdentity })
export type PeerJoinResult = z.infer<typeof PeerJoinResult>

/** POST /hello, signed, both ways every couple of seconds: proof of life, and what each says about itself. */
export const PeerHello = z.object({
  protocol: z.number().int(),
  minProtocol: z.number().int(),
  release: z.string(),
  agentsRunning: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  /** It pauses when idle, and any request wakes it: other machines say hello to it only while it stays awake anyway. */
  sleeps: z.boolean(),
  /** It is holding itself awake for work now. */
  heldAwake: z.boolean(),
  /** The phones of the owner it pushes, as PUSH_TOKEN_HASHES names them: a computer holding a copy of its asks reminds only
   * the others. Machines older than this field say nothing: none. */
  ownerPushTokenHashes: z.array(z.string()).default([]),
})
export type PeerHello = z.infer<typeof PeerHello>

/** Who sent something between machines: an agent of the sending machine, or its owner. */
export const PeerSender = z.discriminatedUnion('kind', [z.object({ kind: z.literal('agent'), name: z.string() }), z.object({ kind: z.literal('owner') })])
export type PeerSender = z.infer<typeof PeerSender>

/** POST /messages, signed: a direct message to someone on the receiving machine. `messageId` is the same on both
 * machines, so a message sent twice is taken once. The sender is an agent of the sending machine, or its owner, who is
 * the same person on every one of their computers. */
export const PeerMessage = z.object({
  messageId: z.string(),
  from: PeerSender,
  /** An agent's name on the receiving machine. */
  to: z.string(),
  text: z.string(),
  wake: z.enum(['wake', 'fyi']),
  purpose: z.enum(['message', 'done_report']),
  sentAt: z.number().int(),
  /** From the owner: the ask of the receiving machine's agent this answers, by its id there. A sender older than protocol 3
   * doesn't send it, and answers no ask across computers. */
  answersAskId: z.string().nullable().default(null),
})
export type PeerMessage = z.infer<typeof PeerMessage>

/**
 * PUSH_TOKEN_HASHES: the SHA-256, hex, of each APNs token (lowercase hex) of the owner's phones paired with the sending
 * machine. That machine pushes those phones itself, by its own settings, so the receiver doesn't push them again: a phone
 * paired with both hears once.
 */

/** POST /owner-messages, signed: what an agent of the sending machine said to the person, for the person's chat with it
 * on the receiving machine, where the person has talked to it from. The person is the same on both, so the receiver files
 * it in its own chat between the person and `from@sender`. `messageId` is the same on both machines. */
export const PeerOwnerMessage = z.object({
  messageId: z.string(),
  /** The agent's name on the sending machine. */
  from: z.string(),
  text: z.string(),
  purpose: z.enum(['message', 'done_report']),
  sentAt: z.number().int(),
  /** See PUSH_TOKEN_HASHES. A sender older than protocol 3 doesn't send them. */
  senderPushTokenHashes: z.array(z.string()).default([]),
})
export type PeerOwnerMessage = z.infer<typeof PeerOwnerMessage>

/**
 * POST /owner-asks, signed: an ask an agent of the sending machine put to the person, for the computers the person talks to
 * it from. The ask stays the sending machine's; the receiver keeps a copy until it hears it closed. `askId` is the same on
 * both machines. An opened ask brings the message that poses it, filed as an owner message is, with the same id.
 */
export const PeerOwnerAsk = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('open'),
    askId: z.string(),
    /** The agent's name on the sending machine. */
    from: z.string(),
    level: AskLevel,
    text: z.string(),
    choices: z.array(z.string().max(80)).max(6),
    askedAt: z.number().int(),
    messageId: z.string(),
    /** See PUSH_TOKEN_HASHES. */
    senderPushTokenHashes: z.array(z.string()),
  }),
  /** Answered, withdrawn or otherwise closed there. */
  z.object({ state: z.literal('closed'), askId: z.string(), from: z.string() }),
  /** Snoozed there, or its snooze ended or was taken off. `remindNow`: the end is itself the reminder, as "when it's done"
   * is, so the receiver pushes the ask to its own phones. */
  z.object({ state: z.literal('snooze_changed'), askId: z.string(), from: z.string(), snooze: AskSnooze.nullable(), remindNow: z.boolean() }),
])
export type PeerOwnerAsk = z.infer<typeof PeerOwnerAsk>

/** POST /owner-ask-snoozes, signed: the person snoozed, or took the snooze off, a copy of an ask of the receiving machine's
 * agent. The snooze is the ask's, kept by its machine, which tells every copy. */
export const PeerAskSnooze = z.object({ askId: z.string(), snooze: AskSnooze.nullable() })
export type PeerAskSnooze = z.infer<typeof PeerAskSnooze>

export const PeerAskSnoozeResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('snoozed'), snooze: AskSnooze.nullable() }),
  /** Refused there as the command would be, with the same code and words: closed meanwhile, or too long a snooze. */
  z.object({ outcome: z.literal('refused'), code: ErrorCode, message: z.string() }),
])
export type PeerAskSnoozeResult = z.infer<typeof PeerAskSnoozeResult>

/** A memory note: its file name in a memory folder, and its text. */
export const PeerNote = z.object({ file: z.string(), text: z.string() })
export type PeerNote = z.infer<typeof PeerNote>

/** POST /log, signed, from a fully trusted peer: a page of one agent's log, as `GET /v2/agents/<id>/log` answers it
 * (`after` follows, `before` pages back, neither is the latest page). Answered with a LogPage. */
export const PeerLogRequest = z.object({ agentName: z.string(), after: z.number().int().nonnegative().nullable(), before: z.number().int().nonnegative().nullable() })
export type PeerLogRequest = z.infer<typeof PeerLogRequest>

/** POST /memory, signed, only between machines that trust each other fully: the asker's notes, for the projects it has. */
export const PeerMemoryRequest = z.object({ projectKeys: z.array(z.string()).max(1000) })
export type PeerMemoryRequest = z.infer<typeof PeerMemoryRequest>

/** For one note, the hash of the version the answering machine last agreed on with the asker: one machine may have
 * seen the two agree when the other hasn't yet. */
export const PeerNoteAgreement = z.object({ file: z.string(), hash: z.string() })
export type PeerNoteAgreement = z.infer<typeof PeerNoteAgreement>

/** The answer: every live note about the person, and the shared notes of each of the asked projects this machine has too,
 * each with the agreements. A note absent here is absent or deleted. */
export const PeerMemory = z.object({
  personalNotes: z.array(PeerNote),
  personalAgreements: z.array(PeerNoteAgreement),
  projects: z.array(z.object({ projectKey: z.string(), notes: z.array(PeerNote), agreements: z.array(PeerNoteAgreement) })),
})
export type PeerMemory = z.infer<typeof PeerMemory>

/** What the receiver of a message, owner message, group update or group post answers. */
export const PeerMessageResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted') }),
  /** For good: sending it again can't help. */
  z.object({ outcome: z.literal('undeliverable'), reason: z.string() }),
])
export type PeerMessageResult = z.infer<typeof PeerMessageResult>

/** Running: in a turn, or starting or ending one. Waiting: anything else. All a limited peer sees of an agent's state. */
export const PeerAgentActivity = z.enum(['running', 'waiting'])
export type PeerAgentActivity = z.infer<typeof PeerAgentActivity>

/** What a fully trusted peer sees of an agent besides its name and activity. */
export const PeerAgentDetails = z.object({
  task: z.string(),
  model: z.string(),
  state: AgentState,
  lastActivityAt: z.number().int(),
  /** Its latest summary's line, if it has one. */
  summaryLine: z.string().nullable(),
})
export type PeerAgentDetails = z.infer<typeof PeerAgentDetails>

/** One of a machine's unarchived agents, as it shows it to a peer. `details` is null for a peer it trusts only limitedly. */
export const PeerAgentCard = z.object({ name: z.string(), activity: PeerAgentActivity, details: PeerAgentDetails.nullable() })
export type PeerAgentCard = z.infer<typeof PeerAgentCard>

/** One window of Claude's plan as a machine knows it newest, when that was read, and what the machine's agents' turns cost
 * inside it. */
export const PeerPlanWindow = z.object({
  windowMinutes: z.number().int().positive(),
  usedFraction: z.number().min(0),
  resetsAt: z.number().int(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).nullable(),
  observedAt: z.number().int(),
  costUsd: z.number().nonnegative(),
})
export type PeerPlanWindow = z.infer<typeof PeerPlanWindow>

/** Claude's plan as a machine knows it, window by window: a peer on the same login shows the newer reading of each window,
 * and splits the plan's use among these costs as well as its own agents'. */
export const PeerClaudePlan = z.object({ windows: z.array(PeerPlanWindow) })
export type PeerClaudePlan = z.infer<typeof PeerClaudePlan>

/** POST /agents, signed: the answering machine's agents, as much as it trusts the asking one to see, and, for a peer it
 * trusts fully, Claude's plan as it knows it. Null for any other peer, and from machines older than this field. */
export const PeerAgentList = z.object({ agents: z.array(PeerAgentCard), claudePlan: PeerClaudePlan.nullable().default(null) })
export type PeerAgentList = z.infer<typeof PeerAgentList>

/**
 * An agent on another of the person's computers, as this server last heard it: a cache, refreshed about every 2 seconds
 * while that computer answers. Its id is `<computer id>:<name>`. Shown as offline when its computer is (`displayStateOf`
 * with the computer's reachability); `details` is null where that computer trusts this one only limitedly.
 */
export const RemoteAgentEntity = z.object({
  id: z.string(),
  computerId: z.string(),
  name: z.string(),
  /** How to message it from here: `name@machine`. */
  address: z.string(),
  activity: PeerAgentActivity,
  details: PeerAgentDetails.nullable(),
  refreshedAt: z.number().int(),
})
export type RemoteAgentEntity = z.infer<typeof RemoteAgentEntity>

/**
 * An open ask that an agent on another of the person's computers put to the person, here because the person talks to that
 * agent from this computer. A copy: the ask is its computer's, and the copy goes when that computer says it closed, when
 * the person answers it or messages the agent from here, or when the computer is removed. Its id is the ask's id on its
 * computer. Answer it with send_message to `address` and `answersAskId` set to its id. Snooze it with snooze_ask: the snooze
 * is kept by its computer, and shown here as that computer last told it. This computer reminds the phones that computer
 * doesn't push, by the same rules.
 */
export const RemoteAskEntity = z.object({
  id: z.string(),
  computerId: z.string(),
  /** The `remote_agent` that asked: `<computer id>:<name>`. */
  remoteAgentId: z.string(),
  agentName: z.string(),
  /** `name@machine`. */
  address: z.string(),
  level: AskLevel,
  text: z.string(),
  choices: z.array(z.string().max(80)).max(6),
  at: z.number().int(),
  /** The chat with the agent here, where the message posing it is. */
  chatId: z.string(),
  /** Null means not snoozed. */
  snooze: AskSnooze.nullable(),
})
export type RemoteAskEntity = z.infer<typeof RemoteAskEntity>

/** A group as its home machine has it, with addresses as the home writes them. */
export const PeerGroupState = z.object({
  chatId: z.string(),
  title: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  members: z.array(z.object({ address: z.string(), joinedAt: z.number().int() })),
})
export type PeerGroupState = z.infer<typeof PeerGroupState>

/**
 * POST /group-updates, signed, from a group's home to a machine with members in it (or that just lost its last one): the
 * group as it is now, and with it a post, or null when only the members changed. `recipients`: the post's members on the
 * receiving machine, by their names there, and whether it calls them. The post keeps its id everywhere.
 */
export const PeerGroupUpdate = z.object({
  group: PeerGroupState,
  post: z.object({ messageId: z.string(), from: z.string(), text: z.string(), sentAt: z.number().int() }).nullable(),
  recipients: z.array(z.object({ name: z.string(), wake: z.enum(['wake', 'fyi']) })),
  /** See PUSH_TOKEN_HASHES: the home pushes these phones about the post itself. A home older than protocol 3 sends none. */
  senderPushTokenHashes: z.array(z.string()).default([]),
})
export type PeerGroupUpdate = z.infer<typeof PeerGroupUpdate>

/** POST /group-posts, signed, from a member's machine to the group's home: the post, for the home to give everyone. */
export const PeerGroupPost = z.object({ chatId: z.string(), messageId: z.string(), from: PeerSender, text: z.string(), sentAt: z.number().int() })
export type PeerGroupPost = z.infer<typeof PeerGroupPost>

/** What can be done to an agent on another computer from here, with full trust. Archived agents aren't shown across
 * computers, so unarchiving is done on theirs. */
export const RemoteAgentAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('interrupt') }),
  z.object({ kind: z.literal('archive') }),
  z.object({ kind: z.literal('set_model'), model: ModelId }),
])
export type RemoteAgentAction = z.infer<typeof RemoteAgentAction>

/** POST /control, signed, from a fully trusted peer: the action done as the owner would do it here. `idempotencyKey` is
 * the sender's, so a retried control is done once. */
export const PeerControl = z.object({ idempotencyKey: z.string(), agentName: z.string(), action: RemoteAgentAction })
export type PeerControl = z.infer<typeof PeerControl>

export const PeerControlResult = z.discriminatedUnion('outcome', [
  /** The agent after the action. */
  z.object({ outcome: z.literal('done'), agent: PeerAgentCard }),
  /** Refused here as the command would be, with the same code and words. */
  z.object({ outcome: z.literal('refused'), code: ErrorCode, message: z.string() }),
])
export type PeerControlResult = z.infer<typeof PeerControlResult>

/** POST /create-agent, signed, from a fully trusted peer: a new agent on the receiving machine, made as the owner would
 * make it there, whose parent is the sender (`name@machine` for an agent). `idempotencyKey` is the sender's, so a retried
 * create makes one agent. */
export const PeerCreateAgent = z.object({
  idempotencyKey: z.string(),
  from: PeerSender,
  task: z.string().min(1),
  /** Null: named from the task. */
  name: z.string().nullable(),
  /** Null: the receiving machine's default model. */
  model: ModelId.nullable(),
  /** A folder on the receiving machine; null: its default projects folder. */
  folder: z.string().nullable(),
  /** Older computers don't send it; they made every agent with the 5 minute cache, so that is what it means. */
  promptCacheLifetime: PromptCacheLifetime.default('5m'),
})
export type PeerCreateAgent = z.infer<typeof PeerCreateAgent>

export const PeerCreateAgentResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('created'), agent: PeerAgentCard }),
  /** Refused there as create_agent would be, with the same code and words. */
  z.object({ outcome: z.literal('refused'), code: ErrorCode, message: z.string() }),
])
export type PeerCreateAgentResult = z.infer<typeof PeerCreateAgentResult>

/** The signature headers on every peer request but /join. */
export const PEER_SIGNATURE_HEADERS = {
  machine: 'x-ouro-machine',
  time: 'x-ouro-time',
  nonce: 'x-ouro-nonce',
  signature: 'x-ouro-signature',
} as const

export const PeerErrorCode = z.enum(['unauthenticated', 'invite_invalid', 'invalid_request', 'forbidden', 'not_found', 'incompatible', 'host_hold_refused', 'internal'])
export type PeerErrorCode = z.infer<typeof PeerErrorCode>
export const PeerError = z.object({ error: z.object({ code: PeerErrorCode, message: z.string() }) })
export type PeerError = z.infer<typeof PeerError>
