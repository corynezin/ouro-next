// Moving an agent to another of the person's computers, machine to machine. The sender stays the agent's owner until
// the receiver answers that it has it.
import { z } from 'zod'
import { ModelId, PromptCacheLifetime } from './agent.ts'
import { GoalKind } from './entities.ts'
import { MessagePurpose } from './message.ts'

/** POST /move-check, signed, from a fully trusted peer: whether this machine would take an agent of that name now.
 * Changes nothing; asked before a move is agreed, so a clash or an unreachable computer is refused at once. */
/** How Claude Code, Codex and the stand-in name a conversation (a uuid, in practice). The name becomes a file name in
 * the receiver's store, so anything that could leave that folder is refused. */
export const PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const PeerMoveCheck = z.object({ name: z.string() })
export type PeerMoveCheck = z.infer<typeof PeerMoveCheck>
export const PeerMoveCheckResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ready') }),
  z.object({ outcome: z.literal('refused'), reason: z.string() }),
])
export type PeerMoveCheckResult = z.infer<typeof PeerMoveCheckResult>

/** Where a moving agent works: inside the sending machine's default folder, which maps to the receiver's, or an
 * absolute path kept as it is. Its files don't move; they travel by version control. */
export const PeerMovingFolder = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('in_default_folder'), relativePath: z.string() }),
  z.object({ kind: z.literal('absolute'), path: z.string() }),
])
export type PeerMovingFolder = z.infer<typeof PeerMovingFolder>

/**
 * POST /move, signed, from a fully trusted peer: an agent handed over whole. Addresses are as the sender writes them.
 * `moveId` names this handoff: sent again (its answer was lost), it is answered as before and taken once.
 */
export const PeerMove = z.object({
  moveId: z.string(),
  agent: z.object({
    name: z.string(),
    task: z.string(),
    model: ModelId,
    parent: z.string(),
    createdBy: z.string(),
    createdAt: z.number().int(),
    folder: PeerMovingFolder,
    /** The epoch the receiver holds it under. */
    ownershipEpoch: z.number().int(),
    /** Older computers don't send it; every agent there had the 5 minute cache, so that is what it means. */
    promptCacheLifetime: PromptCacheLifetime.default('5m'),
  }),
  goal: z.object({
    text: z.string(),
    kind: GoalKind,
    paused: z.boolean(),
    chosenIntervalSeconds: z.number().int().nullable(),
    cycleCount: z.number().int().nonnegative(),
    costUsd: z.number(),
    setBy: z.string(),
    setAt: z.number().int(),
  }).nullable(),
  /** The agent's goal notes file, which outlives its goals. */
  goalNotes: z.string(),
  /** Its model conversation, as the program that held it stores it; null: none to carry, so it starts a new one there,
   * seeded from what arrives with it. `path` is relative to that program's store. */
  conversation: z.object({
    runtime: z.enum(['claude_code', 'codex', 'stand_in']),
    providerSessionId: z.string().regex(PROVIDER_SESSION_ID_PATTERN),
    /** Its folder on the sending machine: the conversation's own record of where it ran. */
    ranIn: z.string(),
    files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
  }).nullable(),
  /** Messages it hadn't taken in yet, oldest first, each keeping its id. */
  waiting: z.array(z.object({ messageId: z.string(), from: z.string(), text: z.string(), wake: z.enum(['wake', 'fyi']), purpose: MessagePurpose, sentAt: z.number().int() })),
  /** The shared notes of the project its folder belongs to, added where the receiver lacks them. */
  memory: z.object({ projectKey: z.string(), notes: z.array(z.object({ file: z.string(), text: z.string() })) }).nullable(),
})
export type PeerMove = z.infer<typeof PeerMove>

export const PeerMoveResult = z.discriminatedUnion('outcome', [
  /** It lives here now, at `address` as this machine writes it. */
  z.object({ outcome: z.literal('taken'), address: z.string() }),
  /** Not taken, so the sender keeps it. */
  z.object({ outcome: z.literal('refused'), reason: z.string() }),
])
export type PeerMoveResult = z.infer<typeof PeerMoveResult>
