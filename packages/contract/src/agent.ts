// An agent's durable lifecycle state and everything shown about it. The server's reducer (server/src/domain/agent.ts)
// is the only thing that changes the state; `displayStateOf` is the only thing that interprets it for people.
import { z } from 'zod'
import { Address } from './address.ts'
import { TurnFailure } from './message.ts'
import { PlanWindow } from './usage.ts'

export const HoldReason = z.enum(['budget', 'logged_out', 'credits', 'usage_limit', 'no_slot'])
export type HoldReason = z.infer<typeof HoldReason>

export const StoppedReason = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('idle') }),
  z.object({ reason: z.literal('deliberate'), by: Address }),
  /** Back from the archive. Nothing runs until a message wakes it. */
  z.object({ reason: z.literal('unarchived') }),
  z.object({ reason: z.literal('crash'), consecutiveCrashes: z.number().int().positive(), relaunch: z.discriminatedUnion('kind', [
    /** It had work, so it comes back by itself at the backoff deadline. */
    z.object({ kind: z.literal('at'), at: z.number().int() }),
    /** It had no work: a message brings it back. */
    z.object({ kind: z.literal('on_message') }),
    /** A crash loop, or a failure a retry can't fix. Automatic recovery has stopped, and only a message starts it again. */
    z.object({ kind: z.literal('gave_up'), why: z.string() }),
  ]) }),
])
export type StoppedReason = z.infer<typeof StoppedReason>

export const TurnActivity = z.discriminatedUnion('kind', [
  /** Taken by the runner; the model hasn't produced anything yet. */
  z.object({ kind: z.literal('waiting') }),
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('tool'), toolName: z.string() }),
])
export type TurnActivity = z.infer<typeof TurnActivity>

/** What an agent becomes once its runner is confirmed gone. */
export const StoppingOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('stopped'), stopped: StoppedReason }),
  z.object({ outcome: z.literal('held'), hold: HoldReason, retryAt: z.number().int().nullable() }),
  z.object({ outcome: z.literal('done'), summary: z.string() }),
  z.object({ outcome: z.literal('archived') }),
  /** Hand it over to another of the person's computers: see the `moving` state. */
  z.object({ outcome: z.literal('moving'), toMachine: z.string() }),
  /** Launch again straight away on the same conversation: a stall, a model change, a new release. */
  z.object({ outcome: z.literal('relaunch'), why: z.enum(['stalled', 'new_release', 'interrupt_forced', 'compaction_forced']) }),
])
export type StoppingOutcome = z.infer<typeof StoppingOutcome>

/** Not sent: the other computer certainly doesn't have it yet. Unconfirmed: a handoff may have reached it without an
 * answer coming back, so it stays here, not running, until the same handoff is answered. */
export const MoveHandoff = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_sent') }),
  z.object({ kind: z.literal('unconfirmed'), since: z.number().int(), why: z.string() }),
])
export type MoveHandoff = z.infer<typeof MoveHandoff>

export const AgentState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('stopped'), since: z.number().int(), stopped: StoppedReason }),
  z.object({ state: z.literal('starting'), since: z.number().int(), generation: z.number().int(), deadlineAt: z.number().int() }),
  z.object({ state: z.literal('idle'), since: z.number().int(), generation: z.number().int() }),
  z.object({ state: z.literal('in_turn'), since: z.number().int(), generation: z.number().int(), turnId: z.string(), activity: TurnActivity, lastOutputAt: z.number().int(), afterTurn: StoppingOutcome.nullable() }),
  z.object({ state: z.literal('interrupting'), since: z.number().int(), generation: z.number().int(), turnId: z.string(), by: Address, deadlineAt: z.number().int() }),
  z.object({ state: z.literal('compacting'), since: z.number().int(), generation: z.number().int(), deadlineAt: z.number().int() }),
  z.object({ state: z.literal('stopping'), since: z.number().int(), generation: z.number().int(), deadlineAt: z.number().int(), then: StoppingOutcome, wakeWhenGone: z.boolean() }),
  z.object({ state: z.literal('held'), since: z.number().int(), hold: HoldReason, retryAt: z.number().int().nullable() }),
  /** On its way to another computer, with no runner. This machine stays its owner until that one confirms it has it; a
   * handoff with no answer is tried again, never called off, so the agent can't end up on both or neither. */
  z.object({ state: z.literal('moving'), since: z.number().int(), toMachine: z.string(), ownershipEpoch: z.number().int(), handoff: MoveHandoff }),
  /** It lives on another computer now, at `to`, which messages to it here are forwarded to. Nothing runs here again. */
  z.object({ state: z.literal('moved'), since: z.number().int(), to: Address }),
  z.object({ state: z.literal('done'), since: z.number().int(), summary: z.string() }),
  z.object({ state: z.literal('archived'), since: z.number().int() }),
])
export type AgentState = z.infer<typeof AgentState>
export type AgentStateName = AgentState['state']

export const AgentDisplayState = z.discriminatedUnion('display', [
  z.object({ display: z.literal('running'), activity: z.enum(['starting', 'idle', 'waiting', 'thinking', 'running_tool', 'interrupting', 'compacting', 'stopping']), toolName: z.string().nullable() }),
  z.object({ display: z.literal('stopped'), reason: z.enum(['idle', 'deliberate', 'unarchived', 'crash', 'budget', 'logged_out', 'usage_limit', 'credits', 'no_slot', 'moving']) }),
  z.object({ display: z.literal('done') }),
  /** Its machine is unreachable, so whatever was last known about it may no longer be true. */
  z.object({ display: z.literal('offline') }),
  z.object({ display: z.literal('archived') }),
  z.object({ display: z.literal('moved'), to: Address }),
])
export type AgentDisplayState = z.infer<typeof AgentDisplayState>

const running = (activity: Extract<AgentDisplayState, { display: 'running' }>['activity'], toolName: string | null = null): AgentDisplayState =>
  ({ display: 'running', activity, toolName })

function displayOfTurnActivity(activity: TurnActivity): AgentDisplayState {
  switch (activity.kind) {
    case 'waiting': return running('waiting')
    case 'thinking': return running('thinking')
    case 'tool': return running('running_tool', activity.toolName)
  }
}

/** The brief's display states: the single interpretation the app and the CLI share. */
export function displayStateOf(state: AgentState, machine: { reachable: boolean }): AgentDisplayState {
  if (!machine.reachable) return { display: 'offline' }
  switch (state.state) {
    case 'stopped': return { display: 'stopped', reason: state.stopped.reason }
    case 'starting': return running('starting')
    case 'idle': return running('idle')
    case 'in_turn': return displayOfTurnActivity(state.activity)
    case 'interrupting': return running('interrupting')
    case 'compacting': return running('compacting')
    case 'stopping': return running('stopping')
    case 'held': return { display: 'stopped', reason: state.hold }
    case 'moving': return { display: 'stopped', reason: 'moving' }
    case 'done': return { display: 'done' }
    case 'archived': return { display: 'archived' }
    case 'moved': return { display: 'moved', to: state.to }
  }
}

export const ModelId = z.string().min(1)
export type ModelId = z.infer<typeof ModelId>

/** How long a model's prompt cache keeps a context after each request. */
export const PromptCacheLifetime = z.enum(['5m', '1h'])
export type PromptCacheLifetime = z.infer<typeof PromptCacheLifetime>

/**
 * Standing instructions an agent follows after the default rules: a protocol file, by name, read when it launches, so a
 * base that changes the file reaches agents made before it. `starter`: starter.md, the front door's.
 */
export const StandingInstructions = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('protocol'), name: z.enum(['starter']) }),
])
export type StandingInstructions = z.infer<typeof StandingInstructions>

/** The agent's prompt cache as of its latest model request, or its latest compaction. */
export const CacheState = z.object({
  /** When it goes cold, unless another request reads it first. */
  expiresAt: z.number().int(),
  /** The context's size: what a cold start has to write again. */
  tokens: z.number().int(),
  /** Compacted since: the new, smaller context isn't cached until the next turn writes it. */
  compacted: z.boolean(),
})
export type CacheState = z.infer<typeof CacheState>

/** A copy pulled from a shared network: the agent it copies, as `name@machine`, the network's name, and when. It arrives
 * paused: nothing wakes it until the owner or an agent here starts it (`start_pulled_agent`). */
export const AgentPulled = z.object({ from: z.string(), network: z.string(), at: z.number().int(), awaitingStart: z.boolean() })
export type AgentPulled = z.infer<typeof AgentPulled>

export const AgentEntity = z.object({
  id: z.string(),
  name: z.string(),
  task: z.string(),
  folder: z.string(),
  model: ModelId,
  parent: Address,
  createdBy: Address,
  createdAt: z.number().int(),
  state: AgentState,
  /** Why the state last changed, in words, e.g. for a one-line note in the status bar. */
  stateNote: z.string().nullable(),
  /** Deliveries queued for it and not yet taken into a turn. */
  queuedDeliveries: z.number().int(),
  /** Its latest model output. A message sent before this reads as "✓ read". */
  lastOutputAt: z.number().int().nullable(),
  /** The last thing it did or received. Used for list ordering and idle folding. */
  lastActivityAt: z.number().int(),
  /** Who interrupted its latest turn, until its next turn starts. */
  interruptedBy: Address.nullable(),
  /** The release its runner was started from, if one is running. */
  runningRelease: z.string().nullable(),
  runningOldRelease: z.boolean(),
  costUsd: z.number(),
  /** Null until a model request reports it, and for models without a timed prompt cache. */
  cache: CacheState.nullable(),
  /**
   * The agent's estimated share of each Claude plan window: its cost in the window over all agents' here, times the window's
   * used fraction. Null for an agent not on the Claude plan (show `costUsd`); empty before the plan has been read.
   */
  planShare: z.array(PlanWindow).nullable(),
  /** Its latest turn failed in a way a retry can't fix. Cleared when a later turn finishes. */
  lastTurnFailure: z.object({ at: z.number().int(), turnId: z.string(), failure: TurnFailure }).nullable(),
  /**
   * The branch it commits on in its own worktree, and the branch that merges it back. Null when it works in its folder
   * directly, or once archiving merged the branch and removed the worktree. A done agent keeps both.
   */
  branch: z.object({ name: z.string(), base: z.string() }).nullable(),
  /** Absent: not pulled. */
  pulled: AgentPulled.optional(),
})
export type AgentEntity = z.infer<typeof AgentEntity>

/** How much an agent's question to a person needs them. Here rather than with asks, since asks across computers use it too. */
export const AskLevel = z.enum(['waiting', 'blocked', 'urgent'])
export type AskLevel = z.infer<typeof AskLevel>

export const AskSnooze = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('until'), at: z.number().int() }),
  z.object({ kind: z.literal('agent_done_or_idle') }),
  z.object({ kind: z.literal('person_back') }),
  /** Asked for only: kept as `until` their next end, by the settings of the computer asked; refused without quiet hours. */
  z.object({ kind: z.literal('quiet_hours_end') }),
])
export type AskSnooze = z.infer<typeof AskSnooze>

export const MAX_ASK_SNOOZE_MS = 7 * 24 * 60 * 60_000
/**
 * What merging an agent's branch back into the branch it started from did. Only a fast-forward, after rebasing the
 * agent's branch if the base moved on: others' work is never rewritten, and a conflict is left in place, never forced.
 */
export const BranchMerge = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged'), branch: z.string(), base: z.string(), how: z.enum(['fast_forward', 'rebase']) }),
  /** The branch has no commits the base lacks, or is gone because it was merged already. */
  z.object({ kind: z.literal('nothing_to_merge'), branch: z.string(), base: z.string() }),
  z.object({ kind: z.literal('not_merged'), branch: z.string(), base: z.string(), why: z.string() }),
])
export type BranchMerge = z.infer<typeof BranchMerge>
