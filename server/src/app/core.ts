// The application: command handlers and the loop that keeps agents moving. Each step loads state, asks the domain what
// should happen, commits that together with the record of why, then performs external effects. A crash between commit and
// effect is repaired by `reconcileAgent`, which derives what's missing from the committed state.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, linkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import {
  AGENT_NAME_PATTERN, Change, turnFailureText, chatHandle, commands, SEARCH_MAX_LIMIT, WATCH_LEASE_MS, DEFAULT_GOAL_INTERVAL_SECONDS, MASTER_AGENT_NAME, MAX_ASK_SNOOZE_MS, OWNER_ADDRESS, parseAddress, PEER_ASK_SNOOZE_PROTOCOL, PEER_OWNER_ASKS_PROTOCOL, PEER_OWNER_MESSAGES_PROTOCOL, personAddress, RESERVED_AGENT_NAMES, updateMarkOf,
} from '@ouro/contract'
import type {
  AgentEntity, AskEntity, AskSnooze, AttachmentRef, ChatEntity, CommandName, GoalEntity, CommandOutput, DeliveryWake, EntityKind, LogPage, LogRecord, MessageEntity, MessagePurpose, PairResponse, PlanUsage, PlanWindow,
  IntegrationProvider, NotificationSettings, PushTokenRegistration, SearchPage, ServerEntity, ServerIdentity, Snapshot, SummaryPage, Viewer,
} from '@ouro/contract'
import { journalSize, readJournalBackward, readJournalForward } from '../adapters/journal-file.ts'
import type { DataPaths } from '../adapters/paths.ts'
import type { DeliveryForModel } from '../adapters/provider.ts'
import { RunnerSupervisor } from '../adapters/runner-supervisor.ts'
import type { SendPush } from '../adapters/apns.ts'
import { checkoutIdentityOf, mainCheckoutOf, mergeThreeWay } from '../adapters/checkouts.ts'
import type { IntegrationTools } from '../adapters/integrations.ts'
import { conversationFilesOf, installConversation } from '../adapters/conversations.ts'
import type { ConversationStores } from '../adapters/conversations.ts'
import { loadOrCreateMachineKey } from '../adapters/peer-transport.ts'
import { pushTokenHash } from './notifier.ts'
import type { BaseSource } from '../adapters/base-source.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import type { RunnerConfig } from '../adapters/runner-protocol.ts'
import { tailscaleHostnameOf } from '../adapters/tailscale.ts'
import type { TailscaleSetup } from '../adapters/tailscale.ts'
import { standInSummarize } from '../adapters/summarizer.ts'
import { NAME_SUGGESTION_TIMEOUT_MS, standInSuggestName, suggestAgentName } from './naming.ts'
import type { NameSuggestion } from './naming.ts'
import type { Summarize } from '../adapters/summarizer.ts'
import { mergeAgentBranch, placeAgent, removeAgentWorktree } from '../adapters/worktrees.ts'
import { decideAgent, dueEvent, liveGeneration, longTurnToReport, wakeReasonForQueuedWork } from '../domain/agent.ts'
import type { AgentDecision, AgentEvent, AgentLifecycle, AgentPolicy, ExternalEffect, TransactionEffect, WakeAdmission, WakeReason } from '../domain/agent.ts'
import type { AgentState, ComputerTrust, HoldReason, PeerAgentCard, PeerAskSnooze, PeerAskSnoozeResult, PeerControl, PeerControlResult, PeerCreateAgent, PeerCreateAgentResult, PeerOwnerAsk, PeerOwnerMessage, PeerGroupPost, PeerGroupState, PeerGroupUpdate, PeerIdentity, PeerMessage, PeerMessageResult, PeerMove, PeerMoveCheck, PeerMoveCheckResult, PeerMoveResult, PeerSender, RemoteAgentAction, StoppedReason, PromptCacheLifetime } from '@ouro/contract'
import type { JournalRecord } from '../domain/journal.ts'
import { agentNames, mentionedMembers } from '../domain/chat.ts'
import { catalogModel, hasTimedPromptCache, launchModelFor, MODEL_CATALOG, runtimeOf } from '../domain/models.ts'
import { quietHoursEndAfter } from '../domain/push.ts'
import { readsAsRefusal } from '../adapters/refusal.ts'
import { claudePlanForPeers, goalPlanHold, mergePlanReading, planUsageOf, sameLoginCostUsd, sameLoginPlanReading, shareOfWindow, usageLimitLiftsAt, windowStartOf } from '../domain/usage.ts'
import type { PlanAccount, PlanReading, PlanWindowReading } from '../domain/usage.ts'
import type { LaunchModel, ModelProvider, ModelRuntime } from '../domain/models.ts'
import { replyReminder } from '../domain/reply.ts'
import { excerptAround, searchWords } from '../domain/search.ts'
import { unmergedBranchReport } from '../domain/worktree.ts'
import { autoArchiveDue } from '../domain/archive.ts'
import type { AgentWorktree } from '../domain/worktree.ts'
import type { LivePolicy, SummaryPolicy, SummaryTrigger } from '../domain/summary.ts'
import {
  addCycleCost, agentCanTakeCycle, completeGoal, cyclePrompt, endCycle, goalKeepsAgentUp, goalStatusOf, GoalRefusal, intervalSecondsOf, newGoal, nextCycle,
  noteInterrupt, noteRealMessage, pauseGoal, reopenGoal, resumeGoal, setGoalInterval, startCycle,
} from '../domain/goal.ts'
import type { CycleFacts, GoalCheckOutcome, GoalRecord } from '../domain/goal.ts'
import { addressFromPeer, peerRetryDelayMs } from '../domain/peers.ts'
import { compactionInstructions, promptCacheAfterCompaction, promptCacheAfterTurn, PROMPT_CACHE_TTL_MS } from '../domain/compaction.ts'
import {
  completeDelivery, failDelivery, handToRunner, hasWakingDelivery, isInTurn, markTakenIn, newQueuedDelivery, refuseDelivery, requeueDelivery, retagTurn, selectForDispatch,
} from '../domain/message.ts'
import { Store } from '../store/store.ts'
import type { AgentRow, DeliveryRow, MessageRow, PeerRow, PersonRow } from '../store/store.ts'
import { DEFAULT_EXPORT_COMMAND, publishCommittedApp } from './app-publishing.ts'
import type { PublishedApp } from './app-publishing.ts'
import { AppUpdates } from './app-updates.ts'
import type { RegisterUpdateInput } from './app-updates.ts'
import { CommandRefused } from './failure.ts'
import { Notifier } from './notifier.ts'
import { Integrations } from './integrations.ts'
import { Peers } from './peers.ts'
import { BaseUpdates } from './base-updates.ts'
import { SourceBackupKeeper } from './source-backup.ts'
import type { GitHubApi } from '../adapters/github-api.ts'
import { Memory } from './memory.ts'
import type { ProjectMemory } from './memory.ts'
import type { AgentAccount } from './integrations.ts'
import { TailscaleConnection } from './tailscale.ts'
import { AgentSummaries } from './summaries.ts'
import type { SummaryAttempt } from './summaries.ts'
import type { HostHold } from '../adapters/host-hold.ts'
import { agentKeepsHostAwake, hostHoldStep, OUTBOX_TRIES_KEEPING_AWAKE } from '../domain/host-hold.ts'
import type { HostHoldState } from '../domain/host-hold.ts'
import { agentNameFromTask, renderConversationSeed, renderForModel, renderSystemPrompt } from './render.ts'

export interface Clock {
  now(): number
}

export interface CoreConfig {
  paths: DataPaths
  clock: Clock
  policy: AgentPolicy
  releaseId: string
  /** The Ouro version this server runs (`0.5.0`), from its package.json; null before versions. */
  version: string | null
  machineName: string
  /** Where the person's other computers reach this one's API; null: they can't. */
  peerAddress: string | null
  defaultModel: string
  defaultFolder: string
  agentLimit: number
  /** Where the `ouro` command lives, put first on agents' PATH. */
  cliBinDir: string
  runnerEntry: string
  /** Null: runners are this process's own children. */
  runnerHostSocket: string | null
  /** The rules agents follow: `default.md`, and `master.md` for the master agent. */
  protocolsDir: string
  /** The person's own copy of the source, which agents change and deploy or publish from. Null when there is none. */
  personSource: { root: string; appDir: string; serverDir: string } | null
  /** The environment agents' model processes start from: deliberately not ourod's own. */
  agentBaseEnv: Record<string, string>
  /** An address phones can reach, for pairing links. Null when only the code is useful. */
  publicUrl: string | null
  linkScheme: string
  summaryPolicy: SummaryPolicy
  livePolicy: LivePolicy
  /** Summaries of agents on a real model: this summarizer and model. Agents on the stand-in get the stand-in's. */
  summarize: Summarize
  summaryModel: string
  /** Null when this machine has no APNs key: nothing is pushed. */
  sendPush: SendPush | null
  /** The accounts' own tools, or a stand-in for journeys. */
  integrationTools: IntegrationTools
  /** The accounts are stand-ins too, as in journeys: there the stand-in model stands for Claude, signing in and out with
   * it. With real accounts it uses none, so a machine's sign-in can't hold a stand-in agent. */
  accountsAreStandIns: boolean
  /** Holding this host awake while it has work; a host that never sleeps needs no hold. */
  hostHold: HostHold
  /** How often memory is pulled from each fully trusted computer. */
  peerMemoryPullIntervalMs: number
  /** Null: nothing offers this machine bases. */
  baseSource: BaseSource | null
  /** The public base repository's name on GitHub, which the private copy's name must differ from. */
  baseRepositoryName: string
  /** Waits between tries of the first push to a private copy just made. */
  firstPushRetryDelaysMs: number[]
  githubApi: GitHubApi
  /** Null: no guardian, so this machine can't switch releases by itself. */
  guardian: GuardianClient | null
  /** Whether Ouro sets Tailscale up on this server, and with what. */
  tailscale: TailscaleSetup
  log: (event: string, fields: Record<string, unknown>) => void
}

/** A person's command that starts or wakes an agent: accepted only while the host is held awake. An agent's own commands
 * come from a turn, which already holds it. */
function commandBringsWork(name: string, rawInput: unknown): boolean {
  switch (name) {
    case 'create_agent':
    case 'post_to_chat':
    case 'set_goal':
    case 'resume_goal':
    case 'reopen_goal':
    case 'move_agent':
      return true
    case 'send_message':
    {
      const input = commands.send_message.input.safeParse(rawInput)
      return input.success && input.data.wake !== 'fyi'
    }
    default:
      return false
  }
}

export type Caller =
  | { kind: 'person'; person: PersonRow; deviceId: string; deviceName: string }
  | { kind: 'agent'; agent: AgentRow }

const PAIRING_CODE_TTL_MS = 10 * 60_000
const IDEMPOTENT_RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000
const NO_SLOT_RETRY_MS = 30_000
const JOURNAL_READ_CHUNK_BYTES = 1024 * 1024
const LOG_PAGE_BYTES = 256 * 1024
const HISTORY_PAGE_LIMIT_MAX = 200
const SEED_RECENT_MESSAGES = 20

const minutesOf = (ms: number) => Math.floor(ms / 60_000)
const MASTER_TASK = "The person's front door: route each request to an agent and bring back the result."
const SUMMARY_PAGE_LIMIT_MAX = 100
const STAND_IN_MODEL = 'stand-in'
const NO_NAME_SUGGESTION: NameSuggestion = { name: null, costUsd: 0 }
const GOAL_CHECK_TIMEOUT_MS = 10 * 60_000
const NOTES_PREVIEW_CHARS = 20_000

type SystemAskProblem = HoldReason | 'crash_loop' | 'no_progress'

const SIGNED_OUT_ASK_TEXT: Record<AgentAccount, string> = {
  claude: 'Claude is signed out on this computer, so it is waiting. Sign in again in Settings and it carries on by itself.',
  chatgpt: 'ChatGPT is signed out on this computer, so it is waiting. Sign in again in Settings and it carries on by itself.',
}
const SYSTEM_ASK_TEXT: Record<Exclude<HoldReason, 'logged_out'>, string> = {
  credits: 'Its provider is out of credit. It retries with backoff and carries on once there is credit again.',
  usage_limit: "It reached its plan's usage limit. It carries on by itself when the window resets.",
  budget: 'The budget is spent. Raise it and it carries on.',
  no_slot: 'Waiting for a free agent slot. It starts by itself when one frees up, or raise the agent limit.',
}
const RUNNER_PROVIDER_OF_RUNTIME: Record<ModelRuntime, RunnerConfig['provider']> = { claude_code: 'claude', codex: 'codex', stand_in: 'stand_in' }
const SYSTEM_ADDRESS = 'system'
const URGENT_ASK_LIMIT = 3
const URGENT_ASK_WINDOW_MS = 60 * 60_000

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')
const shortId = (): string => randomBytes(6).toString('hex')

type AgentEffect = ExternalEffect & { agentId: string }
type PendingEffect =
  | AgentEffect
  | { effect: 'deliver'; agentId: string; generation: number; delivery: DeliveryForModel }
  | { effect: 'summarize'; agentId: string; attempt: SummaryAttempt }
  | { effect: 'consider_live_line'; agentId: string }
  /** `skipPushTokenHashes`: phones another computer pushes about it itself. */
  | { effect: 'push_message'; messageId: string; skipPushTokenHashes: string[] }
  | { effect: 'push_ask'; askId: string }
  | { effect: 'push_remote_ask'; askId: string }
  | { effect: 'merge_branch'; agentId: string; afterwards: 'keep_worktree' | 'remove_worktree' }

export class OuroCore {
  readonly store: Store
  private readonly config: CoreConfig
  private readonly runners: RunnerSupervisor
  /** Each is an app following the change stream. */
  private readonly listeners = new Set<() => void>()
  /** As if held: the process before a restart may have left a hold, which is let go once there is no work. */
  private hostHoldState: HostHoldState
  private lastHostWorkAt = 0
  private hostHoldStepInFlight = false
  private readonly deviceDisconnectListeners = new Set<(deviceId: string) => void>()
  private pendingEffects: PendingEffect[] = []
  private tickTimer: NodeJS.Timeout | null = null
  /**
   * While `start` finds out which runners outlived this server. Runners that didn't were lost to whatever stopped the
   * server, such as a reboot, not to a crash of their own: the person gets one restart notice instead of a report per
   * helper, and parents aren't woken to hear it.
   */
  private reconcilingAtStart = false
  private readonly protocols: { default: string; master: string }
  readonly appUpdates: AppUpdates
  private readonly summaries: AgentSummaries
  private readonly notifier: Notifier
  readonly integrations: Integrations
  readonly peers: Peers
  private readonly baseUpdates: BaseUpdates
  private readonly sourceBackup: SourceBackupKeeper
  private readonly memory: Memory
  /** Claude Code's own configuration folder for agents: where it keeps their conversations and per-folder memory. */
  private readonly claudeConfigDir: string
  /** Agents whose handoff to another computer is on its way now. */
  private readonly handoffsInFlight = new Set<string>()
  /** Copies of asks snoozed until the person is back whose computer is being told they are. */
  private readonly personBackSent = new Set<string>()
  /** Unanswered handoffs, by agent: how many, and when the next is due. */
  private readonly handoffRetries = new Map<string, { attempts: number; at: number }>()
  readonly tailscale: TailscaleConnection

  constructor(config: CoreConfig) {
    this.config = config
    // A host that sleeps starts as if held: the process before a restart may have left a hold, let go once there is no work.
    this.hostHoldState = config.hostHold.sleeps ? { held: true, heldAt: 0 } : { held: false }
    mkdirSync(config.paths.dataDir, { recursive: true })
    mkdirSync(config.paths.attachments, { recursive: true })
    this.store = new Store(config.paths.database)
    this.protocols = {
      default: readFileSync(join(config.protocolsDir, 'default.md'), 'utf8'),
      master: readFileSync(join(config.protocolsDir, 'master.md'), 'utf8'),
    }
    this.appUpdates = new AppUpdates(this.store, join(config.paths.dataDir, 'updates'), () => config.clock.now())
    this.runners = new RunnerSupervisor(config.paths, config.runnerEntry, {
      journalGrew: (agentId) => this.ingestJournal(agentId),
      disconnected: (agentId, generation) => this.reconcileAgent(agentId, generation, true),
    }, config.runnerHostSocket)
    this.summaries = new AgentSummaries({
      store: this.store,
      policy: config.summaryPolicy,
      livePolicy: config.livePolicy,
      now: () => config.clock.now(),
      journalPath: (agentId) => config.paths.journal(agentId),
      summarizerFor: (agent) => agent.model === STAND_IN_MODEL ? { summarize: standInSummarize, model: STAND_IN_MODEL } : { summarize: config.summarize, model: config.summaryModel },
      commit: (body) => this.commit(body),
    })
    this.claudeConfigDir = config.agentBaseEnv.CLAUDE_CONFIG_DIR ?? join(config.agentBaseEnv.HOME ?? homedir(), '.claude')
    this.memory = new Memory({
      store: this.store,
      checkouts: { checkoutIdentityOf, mainCheckoutOf, mergeThreeWay },
      projectsDir: join(config.paths.dataDir, 'memory', 'projects'),
      claudeConfigDir: this.claudeConfigDir,
      machineName: config.machineName,
      now: () => config.clock.now(),
    })
    this.integrations = new Integrations({
      store: this.store,
      tools: config.integrationTools,
      now: () => config.clock.now(),
      commit: (body) => this.commit(body),
      integrationStored: (provider) => { if (provider === 'github') this.sourceBackup.refresh() },
      accountSignedIn: (account) => this.commit(() => this.releaseHolds('logged_out', (agent) => this.accountOf(agent) === account)),
      planUsageRead: (account, windows) => this.observePlanUsage(account, windows, config.clock.now()),
      log: config.log,
    })
    this.sourceBackup = new SourceBackupKeeper({
      sourceRoot: config.personSource?.root ?? null,
      baseRepositoryName: config.baseRepositoryName,
      firstPushRetryDelaysMs: config.firstPushRetryDelaysMs,
      api: config.githubApi,
      githubToken: () => config.integrationTools.githubToken(),
      githubState: () => { const github = this.store.integrationOf('github'); return github?.provider === 'github' ? github.state.status : null },
      guardian: config.guardian,
      now: () => config.clock.now(),
      changed: () => this.store.markChanged('server', 'server'),
      log: config.log,
    })
    this.baseUpdates = new BaseUpdates({
      sourceRoot: config.personSource?.root ?? null,
      baseSource: config.baseSource,
      guardian: config.guardian,
      now: () => config.clock.now(),
      commit: (body) => this.commit(body),
      readRecord: () => this.store.baseUpdateRecord(),
      saveRecord: (record) => this.store.saveBaseUpdateRecord(record),
      offerChanged: () => this.store.markChanged('server', 'server'),
      publishApp: config.personSource === null ? null : () => this.publishApp(config.personSource!.appDir),
      tellMasterAgent: (text) => this.alert(MASTER_AGENT_NAME, text),
      log: config.log,
    })
    this.tailscale = new TailscaleConnection({ setup: config.tailscale, hostname: tailscaleHostnameOf(config.machineName), now: () => config.clock.now(), log: config.log })
    this.notifier = new Notifier({
      store: this.store,
      now: () => config.clock.now(),
      send: config.sendPush,
      commit: (body) => this.commit(body),
      directChatOf: (agentId, personAddress) => this.commit(() => {
        const agent = this.requireAgentRow(agentId)
        return this.ensureDirectChat({ key: `agent:${agent.id}`, address: agent.name }, { key: `person:${personAddress}`, address: personAddress }, agent.name)
      }),
      log: config.log,
    })
    this.initializeMachine()
    this.peers = new Peers({
      store: this.store,
      machineId: this.store.getMeta('machine_id')!,
      machineName: config.machineName,
      address: config.peerAddress,
      key: loadOrCreateMachineKey(config.paths.machineKey),
      release: config.releaseId,
      now: () => config.clock.now(),
      commit: (body) => this.commit(body),
      ownerPushTokenHashes: () => this.ownerPushTokenHashes(),
      agentCounts: () => {
        const agents = this.store.listUnarchivedAgents()
        return { running: agents.filter((agent) => liveGeneration(agent.lifecycle.state) !== null).length, total: agents.length }
      },
      hostSleeps: config.hostHold.sleeps,
      heldAwake: () => this.hostHoldState.held,
      inUse: () => this.hostHoldState.held || this.listeners.size > 0,
      holdForWork: () => this.holdHostForWork(),
      log: config.log,
      deliverFromPeer: (peer, message) => this.deliverFromPeer(peer, message),
      groupUpdateFromPeer: (peer, update) => this.groupUpdateFromPeer(peer, update),
      groupPostFromPeer: (peer, post) => this.groupPostFromPeer(peer, post),
      ownerMessageFromPeer: (peer, message) => this.ownerMessageFromPeer(peer, message),
      ownerAskFromPeer: (peer, ask) => this.ownerAskFromPeer(peer, ask),
      askSnoozeFromPeer: (peer, snooze) => this.commit(() => this.askSnoozeFromPeer(peer, snooze)),
      memoryPullIntervalMs: config.peerMemoryPullIntervalMs,
      memoryProjectKeys: () => this.memory.projectKeys(),
      memoryForPeer: (peer, projectKeys) => this.memory.notesForPeer({ machineId: peer.machineId }, projectKeys),
      memoryFromPeer: (peer, memory) => this.memory.takeNotesFromPeer({ machineId: peer.machineId, name: peer.name }, memory),
      moveCheckFromPeer: (peer, check) => this.moveCheckFromPeer(peer, check),
      moveFromPeer: (peer, move) => this.commit(() => this.moveFromPeer(peer, move)),
      agentCards: (trust) => this.store.listUnarchivedAgents().map((agent) => this.agentCard(agent, trust)),
      claudePlan: () => claudePlanForPeers(this.planReadingKnown('claude'), (since) => this.planCostSince('claude', since), config.clock.now()),
      peerClaudePlanChanged: () => this.markPlanReadingChanged('claude'),
      controlFromPeer: (peer, control) => this.controlFromPeer(peer, control),
      createAgentFromPeer: (peer, request) => this.createAgentFromPeer(peer, request),
    })
  }

  // Lifecycle of the server itself

  private initializeMachine(): void {
    this.store.transaction(() => {
      if (this.store.getMeta('epoch') === null) this.store.setMeta('epoch', randomUUID())
      if (this.store.getMeta('machine_id') === null) this.store.setMeta('machine_id', randomUUID())
      if (!this.store.ownerPerson()) {
        this.store.insertPerson({ id: randomUUID(), name: this.config.machineName, address: OWNER_ADDRESS, isOwner: true, joinedAt: this.config.clock.now() })
      }
      // An owner who paired before masters existed gets one too.
      const owner = this.store.ownerPerson()!
      if (this.store.listDevices().some((device) => device.personId === owner.id)) this.ensureMasterAgent(owner, this.config.clock.now())
      if (this.store.getMeta('announced_release') !== this.config.releaseId) {
        this.store.setMeta('announced_release', this.config.releaseId)
        this.store.markChanged('server', 'server')
      }
    })
  }

  /** Finds running agents again and starts the scheduler. Reads only unarchived agents, so history size doesn't matter. */
  start(tickIntervalMs: number): void {
    this.reconcilingAtStart = true
    const resumedByCreator = new Map<string, string[]>()
    try {
      for (const agent of this.store.listUnarchivedAgents()) {
        this.failRefusalsLeftWaiting(agent)
        const generation = liveGeneration(agent.lifecycle.state)
        if (generation === null) continue
        this.reconcileAgent(agent.id, generation)
        if (this.comesBackAfterRestart(agent.id)) resumedByCreator.set(agent.createdBy, [...resumedByCreator.get(agent.createdBy) ?? [], agent.name])
      }
    } finally {
      this.reconcilingAtStart = false
    }
    if (resumedByCreator.size > 0) {
      this.commit(() => {
        for (const [creator, names] of resumedByCreator) this.postNoticeToPerson(creator, `The server restarted; resumed ${names.join(', ')}.`)
      })
    }
    this.baseUpdates.resume()
    this.tick()
    this.tickTimer = setInterval(() => this.tick(), tickIntervalMs)
    this.tickTimer.unref()
  }

  /**
   * Releases before refusals were told apart took one for a passing failure, retried it until it gave up as a crash, and
   * left its messages waiting with the refused input in the provider's session. Those messages are refused now, as a
   * refusal is, the person hears why once, and the next message starts a fresh session.
   */
  private failRefusalsLeftWaiting(agent: AgentRow): void {
    const { state } = agent.lifecycle
    if (state.state !== 'stopped' || state.stopped.reason !== 'crash') return
    const lastFailure = this.store.agentTransitions(agent.id, 10).map((transition) => transition.cause).filter((cause) => cause.startsWith(PASSING_FAILURE_CAUSE)).at(-1)
    if (lastFailure === undefined) return
    const providerMessage = lastFailure.slice(PASSING_FAILURE_CAUSE.length)
    const queued = this.store.deliveriesOfAgentInState(agent.id, 'queued')
    if (!readsAsRefusal(providerMessage) || queued.length === 0) return
    const reason = `${turnFailureText({ kind: 'model_refused', providerMessage })}. Rephrase it, or try another model.`
    this.commit(() => {
      const now = this.config.clock.now()
      for (const delivery of queued) this.store.updateDeliveryState(delivery, refuseDelivery(delivery.state, reason, now))
      this.store.updateAgentFields(agent.id, { providerSessionId: null })
      const count = queued.length === 1 ? 'a message' : `${queued.length} messages`
      this.postNoticeToPerson(agent.createdBy, `${agent.name} couldn't take ${count}: ${reason}`)
    })
  }

  /** Whether an agent whose runner was gone at start relaunches by itself: it had work. */
  private comesBackAfterRestart(agentId: string): boolean {
    const { state } = this.requireAgentRow(agentId).lifecycle
    return state.state === 'stopped' && state.stopped.reason === 'crash' && state.stopped.relaunch.kind === 'at'
  }

  /** Stops this server. Runners keep running. */
  close(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.runners.disconnectAll()
    this.store.close()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDeviceDisconnected(listener: (deviceId: string) => void): () => void {
    this.deviceDisconnectListeners.add(listener)
    return () => this.deviceDisconnectListeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener()
  }

  /** One unit of work: commits `body`, then performs what it decided. */
  private commit<T>(body: () => T): T {
    const previousCursor = this.store.currentCursor()
    let result: T
    try {
      result = this.store.transaction(body)
    } catch (error) {
      this.pendingEffects = []
      throw error
    }
    const effects = this.pendingEffects
    this.pendingEffects = []
    for (const effect of effects) this.performEffect(effect)
    if (this.store.currentCursor() !== previousCursor) this.notifyListeners()
    return result
  }

  tick(): void {
    const now = this.config.clock.now()
    for (const agent of this.store.listUnarchivedAgents()) {
      const generation = liveGeneration(agent.lifecycle.state)
      if (generation !== null && !this.runners.isConnected(agent.id, generation)) this.reconcileAgent(agent.id, generation)
      if (generation !== null) this.ingestJournal(agent.id)

      const current = this.store.agentById(agent.id)
      if (!current) continue
      // A spent budget stops each agent once its turn is over; nothing new starts until it is raised.
      if (current.lifecycle.state.state === 'idle' && this.overBudget()) {
        this.commit(() => this.applyAgentEvent(agent.id, { type: 'hold_between_turns', hold: 'budget' }))
        continue
      }
      const queued = this.store.deliveriesOfAgentInState(agent.id, 'queued')
      const goal = this.store.goalOf(agent.id)
      const due = dueEvent(current.lifecycle, now, this.config.policy, {
        hasQueuedWork: queued.length > 0,
        activeGoal: goalKeepsAgentUp(goal),
        nextGoalCycleAt: goal === null ? null : nextCycle(goal, this.cycleFacts(current)).at,
        promptCache: current.promptCache,
      })
      if (due) this.commit(() => this.applyAgentEvent(agent.id, due))
      this.commit(() => this.reportLongTurn(agent.id, now))
      this.commit(() => this.settleAgent(agent.id))
      this.commit(() => this.startGoalCycleIfDue(agent.id))
      this.commit(() => this.autoArchiveIfDue(agent.id, now))
    }
    const unarchived = this.store.listUnarchivedAgents().map((agent) => agent.id)
    for (const agentId of this.summaries.agentsWithPendingActivity(unarchived)) this.commit(() => this.considerSummary(agentId, 'periodic'))
    for (const agentId of this.summaries.watchedAgents()) this.summaries.considerLiveLine(agentId)
    this.notifier.remindDueAsks()
    this.integrations.tick()
    this.peers.tick()
    this.tailscale.tick()
    this.continueMoves(now)
    this.keepHostAwakeForWork(now)
    this.baseUpdates.tick()
    this.sourceBackup.tick()
    this.moveAgentsToConfirmedRelease()
    this.store.pruneIdempotentResults(now - IDEMPOTENT_RESULT_RETENTION_MS)
  }

  // Holding the host awake

  /** Before work is accepted: false means the host might pause under it, so it must be refused, not taken. */
  private async holdHostForWork(): Promise<boolean> {
    if (!this.config.hostHold.sleeps) return true
    const held = await this.config.hostHold.hold()
    const now = this.config.clock.now()
    if (held) {
      this.hostHoldState = { held: true, heldAt: now }
      this.lastHostWorkAt = now
    } else {
      this.config.log('host_hold_refused', {})
    }
    return held
  }

  /** Work this host has that mustn't pause, a Tailscale login waiting for the person among it. Background chatter isn't
   * work: FYIs, held agents, a peer long away. */
  private hostHasWork(): boolean {
    const agentHasWork = this.store.listUnarchivedAgents().some((agent) => agentKeepsHostAwake(agent.lifecycle.state, this.store.hasQueuedWakingDelivery(agent.id)))
    return agentHasWork || this.handoffsInFlight.size > 0 || this.store.hasPeerOutboxTriedFewerThan(OUTBOX_TRIES_KEEPING_AWAKE) || this.tailscale.keepsHostAwake()
  }

  /** From the tick: renews the hold while there is work, and lets go a while after there is none. */
  private keepHostAwakeForWork(now: number): void {
    if (!this.config.hostHold.sleeps || this.hostHoldStepInFlight) return
    const hasWork = this.hostHasWork()
    if (hasWork) this.lastHostWorkAt = now
    const step = hostHoldStep(this.hostHoldState, hasWork, this.lastHostWorkAt, now)
    if (step === 'none') return
    this.hostHoldStepInFlight = true
    const done = step === 'hold'
      ? this.config.hostHold.hold().then((held) => {
        if (held) this.hostHoldState = { held: true, heldAt: this.config.clock.now() }
        else this.config.log('host_hold_not_renewed', {})
      })
      : this.releaseHostHold()
    void done.finally(() => { this.hostHoldStepInFlight = false })
  }

  /** A hold taken for work while the release was on its way stands: the host has it, since calls reach it in order. */
  private releaseHostHold(): Promise<void> {
    const released = this.hostHoldState
    return this.config.hostHold.release().then(() => {
      if (this.hostHoldState === released) this.hostHoldState = { held: false }
    })
  }

  // Applying decisions

  private applyAgentEvent(agentId: string, event: AgentEvent): AgentDecision {
    const row = this.requireAgentRow(agentId)
    const now = this.config.clock.now()
    const decision = decideAgent(row.lifecycle, event, now, this.config.policy)
    if (decision.outcome === 'refused') return decision

    for (const effect of decision.transactionEffects) this.applyTransactionEffect(agentId, effect)
    this.store.saveAgentLifecycle(agentId, decision.next, decision.recordTransition ? decision.cause : row.stateNote)
    if (decision.recordTransition) {
      // The cause can quote a provider's error, so it is cut short; it never holds message contents.
      this.config.log('agent_transition', { agentId, agentName: row.name, from: row.lifecycle.state.state, to: decision.next.state.state, generation: decision.next.instanceGeneration, cause: decision.cause.slice(0, 300) })
      this.store.recordAgentTransition(agentId, {
        fromState: row.lifecycle.state.state,
        toState: decision.next.state.state,
        generation: decision.next.instanceGeneration,
        cause: decision.cause,
        at: now,
      })
    }
    for (const effect of decision.externalEffects) this.pendingEffects.push({ ...effect, agentId })
    if (decision.next.state.state !== row.lifecycle.state.state) this.afterStateChange(agentId, row.lifecycle.state, decision.next.state)
    this.afterStallCountChange(agentId, row.lifecycle.consecutiveStalls, decision.next.consecutiveStalls)
    return decision
  }

  /** Stalls in a row mean work taken in isn't moving, though the agent keeps retrying: the person hears once, until a turn finishes. */
  private afterStallCountChange(agentId: string, before: number, after: number): void {
    const limit = this.config.policy.stallsBeforeTelling
    if (before < limit && after >= limit) {
      this.openSystemAsk(agentId, 'no_progress', `It stalled ${after} times in a row: each time it took its work in, then went quiet past the stall deadline. It keeps retrying; its log shows what happened. Interrupt or stop it if it should give up.`)
    }
    if (before > 0 && after === 0) this.closeSystemAsks(agentId, 'no_progress')
  }

  private closeSystemAsks(agentId: string, problem: SystemAskProblem): void {
    const now = this.config.clock.now()
    for (const ask of this.store.openAsksOfAgent(agentId)) if (ask.source.kind === 'system' && ask.source.problem === problem) this.store.closeAsk(ask.id, now)
  }

  /** What follows from entering or leaving a state, beyond the agent itself: system asks and snoozes. */
  private afterStateChange(agentId: string, from: AgentState, to: AgentState): void {
    const now = this.config.clock.now()
    if (to.state === 'held' && from.state !== 'held') this.openSystemAsk(agentId, to.hold, this.heldAskText(agentId, to.hold))
    if (to.state === 'stopped' && to.stopped.reason === 'crash' && to.stopped.relaunch.kind === 'gave_up') {
      this.openSystemAsk(agentId, 'crash_loop', `It kept failing, so it stopped retrying: ${to.stopped.relaunch.why}. Its log shows what happened; a message starts it again.`)
    }
    if (to.state === 'stopped' && to.stopped.reason === 'crash' && to.stopped.relaunch.kind !== 'at' && !this.reconcilingAtStart) this.reportHelperCrash(agentId, to.stopped.relaunch)
    if (from.state === 'held' && to.state !== 'held') {
      for (const ask of this.store.openAsksOfAgent(agentId)) if (ask.source.kind === 'system' && ask.source.problem === from.hold) this.closeAsk(ask.id, now)
    }
    if (to.state === 'idle' || to.state === 'done' || to.state === 'stopped') {
      // "Remind me when it's done": the snooze ends, and that is the reminder.
      for (const ask of this.store.openAsksSnoozedFor('agent_done_or_idle', { agentId })) {
        this.setAskSnooze(ask, null, { remindNow: true })
        this.pendingEffects.push({ effect: 'push_ask', askId: ask.id })
      }
    }
    if (to.state === 'done') this.considerSummary(agentId, 'agent_done')
    // Its runner is gone by now, so nothing is writing to its worktree.
    if ((to.state === 'done' || to.state === 'archived') && this.requireAgentRow(agentId).worktree !== null) {
      this.pendingEffects.push({ effect: 'merge_branch', agentId, afterwards: to.state === 'archived' ? 'remove_worktree' : 'keep_worktree' })
    }
    // A goal's display depends on the agent's state.
    if (this.store.goalOf(agentId)) this.store.markChanged('goal', agentId)
  }

  /** A turn running long is reported to whoever the agent reports to, once per turn. The turn carries on. */
  private reportLongTurn(agentId: string, now: number): void {
    const row = this.store.agentById(agentId)
    if (!row) return
    const report = longTurnToReport(row.lifecycle.state, now, this.config.policy, row.longTurnReportedTurnId)
    if (report === null) return
    this.store.updateAgentFields(agentId, { longTurnReportedTurnId: report.turnId })
    this.alert(this.reportTarget(row), `Agent "${row.name}" has been busy on one turn for over ${minutesOf(report.busyForMs)} min. It may be stuck in a loop: look with ouro log ${row.name}, or tell it to stop and report.`)
  }

  /**
   * A helper down without reporting, and not coming back by itself, is reported to its parent and to the person who
   * started the work. One that relaunches by itself after a backoff carries on, so that isn't news.
   */
  private reportHelperCrash(agentId: string, relaunch: Exclude<Extract<StoppedReason, { reason: 'crash' }>['relaunch'], { kind: 'at' }>): void {
    const row = this.requireAgentRow(agentId)
    const parent = parseAddress(row.parent)
    if (parent.kind !== 'agent') return
    const why = relaunch.kind === 'gave_up' ? `it kept failing: ${relaunch.why}` : 'it crashed or was killed'
    const restart = `A message to it restarts it where it left off (ouro send ${row.name} "..."), or spawn a replacement.`
    const target = this.reportTarget(row)
    if (target !== row.createdBy) this.alert(target, `Your helper "${row.name}" stopped without reporting (${why}). ${restart}`)
    this.alert(row.createdBy, `${row.parent}'s helper "${row.name}" stopped without reporting (${why}).${target === row.createdBy ? '' : ` ${row.parent} has been told.`}`)
  }

  /** Something that needs attention: an agent is woken by it; a person gets it in their system chat, pushed. */
  private alert(address: string, text: string): void {
    const parsed = parseAddress(address)
    if (parsed.kind === 'agent') {
      const agent = parsed.machine === null ? this.store.activeAgentByName(parsed.agentName) : null
      if (!agent) return
      this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text, attachments: [], purpose: 'system_notice', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
      this.settleAgent(agent.id)
      return
    }
    const message = this.postNoticeToPerson(address, text)
    if (message) this.pendingEffects.push({ effect: 'push_message', messageId: message.id, skipPushTokenHashes: [] })
  }

  private openSystemAsk(agentId: string, problem: SystemAskProblem, text: string): void {
    const agent = this.requireAgentRow(agentId)
    if (this.store.openAsksOfAgent(agentId).some((ask) => ask.source.kind === 'system' && ask.source.problem === problem)) return
    const ask: AskEntity = {
      id: randomUUID(),
      agentId,
      agentName: agent.name,
      to: agent.createdBy,
      level: problem === 'no_slot' ? 'waiting' : 'blocked',
      text,
      choices: [],
      source: { kind: 'system', problem },
      at: this.config.clock.now(),
      snooze: null,
    }
    if (!this.store.personByAddress(ask.to)) return
    this.store.insertAsk(ask)
    this.pendingEffects.push({ effect: 'push_ask', askId: ask.id })
  }

  private applyTransactionEffect(agentId: string, effect: TransactionEffect): void {
    const now = this.config.clock.now()
    const inTurn = () => this.store.deliveriesOfAgentInTurn(agentId)
    switch (effect.effect) {
      case 'requeue_in_turn_deliveries':
        for (const delivery of inTurn()) this.store.updateDeliveryState(delivery, requeueDelivery(delivery.state, now))
        return
      case 'complete_in_turn_deliveries_as_interrupted':
        for (const delivery of inTurn()) this.store.updateDeliveryState(delivery, completeDelivery(delivery.state, 'turn_interrupted', now))
        return
      case 'retag_in_turn_deliveries':
        for (const delivery of inTurn()) this.store.updateDeliveryState(delivery, retagTurn(delivery.state, effect.toTurnId))
        return
      case 'discard_provider_session':
        this.store.updateAgentFields(agentId, { providerSessionId: null })
        return
      case 'tell_agent_it_stalled': {
        // Queued behind the turn's own deliveries, which go back first, so the relaunch carries on with all of them.
        const text = `Your last turn stalled (no output for ${minutesOf(effect.silentForMs)} min) and was restarted. Check where you were and carry on.`
        this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: this.requireAgentRow(agentId), text, attachments: [], purpose: 'system_notice', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
        return
      }
      case 'fail_in_turn_deliveries':
        for (const delivery of inTurn()) this.store.updateDeliveryState(delivery, failDelivery(delivery.state, effect.failure, now))
        this.store.setLastTurnFailure(agentId, { at: now, turnId: effect.turnId, failure: effect.failure })
        return
      case 'record_interrupted_by': {
        this.store.updateAgentFields(agentId, { interruptedBy: effect.by })
        const goal = this.store.goalOf(agentId)
        if (effect.by !== null && goal) this.store.saveGoal(noteInterrupt(goal))
        return
      }
    }
  }

  /** The sign-in an agent's model runs on, if any. The stand-in stands for Claude where the accounts are stand-ins. */
  private accountOf(agent: AgentRow): AgentAccount | null {
    switch (launchModelFor(agent.model, { openrouter: this.openrouterConfigured() }).model.provider) {
      case 'anthropic': return 'claude'
      case 'stand_in': return this.config.accountsAreStandIns ? 'claude' : null
      case 'openai': return 'chatgpt'
      case 'openrouter': return null
    }
  }

  /** Claude counts as signed in until it is found signed out; ChatGPT, which is optional, only once it is found signed in. */
  private accountSignedOut(account: AgentAccount): boolean {
    const status = this.store.integrationOf(account)?.state.status
    return account === 'claude' ? status === 'signed_out' : status !== 'signed_in'
  }

  /** The model process said its account is signed out, whatever the last check said. The next check, or a sign-in from
   * the app, finds out whether that is still true. */
  private recordSignedOut(account: AgentAccount | null): void {
    const checkedAt = this.config.clock.now()
    if (account === 'claude') this.store.saveIntegration({ id: 'claude', provider: 'claude', state: { status: 'signed_out' }, checkedAt })
    if (account === 'chatgpt') this.store.saveIntegration({ id: 'chatgpt', provider: 'chatgpt', state: { status: 'signed_out' }, checkedAt })
  }

  private heldAskText(agentId: string, hold: HoldReason): string {
    if (hold !== 'logged_out') return SYSTEM_ASK_TEXT[hold]
    return SIGNED_OUT_ASK_TEXT[this.accountOf(this.requireAgentRow(agentId)) ?? 'claude']
  }

  private admissionFor(agent: AgentRow): WakeAdmission {
    // Signed out holds every agent on the provider, not only the one that found out: the rest would only fail too.
    // Agents on another provider carry on.
    const account = this.accountOf(agent)
    if (account !== null && this.accountSignedOut(account)) return { kind: 'refused', hold: 'logged_out', retryAt: null }
    if (this.overBudget()) return { kind: 'refused', hold: 'budget', retryAt: null }
    if (this.store.countAgentsWithRunners() >= this.agentLimit()) {
      return { kind: 'refused', hold: 'no_slot', retryAt: this.config.clock.now() + NO_SLOT_RETRY_MS }
    }
    return { kind: 'granted' }
  }

  /** The cause of a hold cleared, for the agents it `applies` to: they carry on with what waits for them, or rest. */
  private releaseHolds(hold: HoldReason, applies: (agent: AgentRow) => boolean = () => true): void {
    for (const agent of this.store.listUnarchivedAgents()) {
      const { state } = agent.lifecycle
      if (state.state !== 'held' || state.hold !== hold || !applies(agent)) continue
      if (hasWakingDelivery(this.store.deliveriesOfAgentInState(agent.id, 'queued'))) this.requestWake(agent.id, 'hold_cleared')
      else this.applyAgentEvent(agent.id, { type: 'hold_cleared_without_work' })
    }
  }

  /** The models agents can be given: the default, the catalog, then what the ChatGPT plan may run, each available when
   * its provider is. */
  private modelOptions(): ServerEntity['models'] {
    const chatgpt = this.store.integrationOf('chatgpt')
    const chatgptModels = chatgpt?.provider === 'chatgpt' && chatgpt.state.status === 'signed_in' ? chatgpt.state.models : []
    const ids = [...new Set([this.config.defaultModel, ...MODEL_CATALOG.map((model) => model.id), ...chatgptModels])]
    return ids.map((id) => {
      const model = catalogModel(id)
      return { id, label: model.label, provider: model.provider, available: this.providerAvailable(model.provider) }
    })
  }

  private providerAvailable(provider: ModelProvider): boolean {
    switch (provider) {
      case 'stand_in': return true
      case 'anthropic': return !this.accountSignedOut('claude')
      case 'openai': return !this.accountSignedOut('chatgpt')
      case 'openrouter': return this.openrouterConfigured()
    }
  }

  private agentLimit(): number {
    const saved = this.store.getMeta('agent_limit')
    return saved === null ? this.config.agentLimit : Number(saved)
  }

  private budgetUsd(): number | null {
    const saved = this.store.getMeta('budget_usd')
    return saved === null || saved === 'none' ? null : Number(saved)
  }

  private autoArchiveAfterHours(): number | null {
    const saved = this.store.getMeta('auto_archive_after_hours')
    return saved === null || saved === 'off' ? null : Number(saved)
  }

  private commandSetAutoArchive(caller: Caller, input: { afterHours: number | null }): CommandOutput<'set_auto_archive'> {
    if (caller.kind !== 'person' || !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner sets auto-archive')
    this.store.setMeta('auto_archive_after_hours', input.afterHours === null ? 'off' : String(input.afterHours))
    this.store.markChanged('server', 'server')
    return { server: this.serverEntity() }
  }

  private replyRemindersOn(): boolean {
    return this.store.getMeta('reply_reminders') !== 'off'
  }

  private commandSetReplyReminders(caller: Caller, input: { on: boolean }): CommandOutput<'set_reply_reminders'> {
    if (caller.kind !== 'person' || !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner sets reply reminders')
    this.store.setMeta('reply_reminders', input.on ? 'on' : 'off')
    this.store.markChanged('server', 'server')
    return { server: this.serverEntity() }
  }

  /** Archived as if by its creator, who is told quietly: the notice isn't pushed. */
  private autoArchiveIfDue(agentId: string, now: number): void {
    const afterHours = this.autoArchiveAfterHours()
    const agent = this.store.agentById(agentId)
    if (afterHours === null || agent === null || agent.lifecycle.state.state !== 'done') return
    const goal = this.store.goalOf(agentId)
    const facts = {
      state: agent.lifecycle.state,
      lastActivityAt: agent.lastActivityAt,
      goalStillGoing: goal !== null && goal.progress.status !== 'complete',
      runningHelpers: this.runningHelpersOf(agent.name).length,
      queuedDeliveries: this.store.deliveriesOfAgentInState(agentId, 'queued').length,
      openAsks: this.store.openAsksOfAgent(agentId).length,
      unreadByCreator: this.unreadByCreator(agent),
    }
    if (!autoArchiveDue(facts, now, afterHours)) return
    const decision = this.applyAgentEvent(agentId, { type: 'archive_requested' })
    if (decision.outcome === 'refused') return
    this.postNoticeToPerson(agent.createdBy, `Auto-archived ${agent.name}: done, and quiet for over ${afterHours} h. Unarchive it to bring it back.`)
  }

  private unreadByCreator(agent: AgentRow): number {
    const creator = this.store.personByAddress(agent.createdBy)
    if (creator === null) return 0
    const chatId = this.directChatId(`person:${creator.address}`, `agent:${agent.id}`)
    return this.store.chatExists(chatId) ? this.store.countUnread(chatId, this.store.readThroughSeq(creator.id, chatId), creator.address) : 0
  }

  private overBudget(): boolean {
    const budget = this.budgetUsd()
    return budget !== null && this.store.totalSpendUsd() >= budget
  }

  private commandRefreshPlanUsage(prepared: PreparedChecks): CommandOutput<'refresh_plan_usage'> {
    const { planUsageRead } = prepared
    if (planUsageRead.kind === 'not_needed') throw new Error('refresh_plan_usage runs only with its usage read')
    if (planUsageRead.kind === 'read') this.observePlanUsage(planUsageRead.account, planUsageRead.windows, this.config.clock.now())
    return { server: this.serverEntity() }
  }

  /** Before the command's transaction: the provider is asked over the network. OpenRouter's answer is stored as it comes. */
  private async readUsageNow(rawInput: unknown): Promise<PreparedChecks['planUsageRead']> {
    const input = commands.refresh_plan_usage.input.safeParse(rawInput)
    // A bad request is refused by the command itself.
    if (!input.success) return { kind: 'not_needed' }
    if (input.data.provider === 'openrouter') {
      await this.integrations.refreshOpenrouter()
      return { kind: 'openrouter_read' }
    }
    return { kind: 'read', account: 'chatgpt', windows: await this.integrations.readChatgptPlanUsage() }
  }

  private commandTakeBaseUpdate(caller: Caller, input: { n: number }): CommandOutput<'take_base_update'> {
    if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner takes base updates')
    this.baseUpdates.take(input.n)
    return { server: this.serverEntity() }
  }

  private commandContinueBaseUpdate(): CommandOutput<'continue_base_update'> {
    this.baseUpdates.carryOn()
    return { server: this.serverEntity() }
  }

  private commandSetLimits(caller: Caller, input: { agentLimit: number; budgetUsd: number | null }): CommandOutput<'set_limits'> {
    if (caller.kind !== 'person' || !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner sets limits')
    this.store.setMeta('agent_limit', String(input.agentLimit))
    this.store.setMeta('budget_usd', input.budgetUsd === null ? 'none' : String(input.budgetUsd))
    this.store.markChanged('server', 'server')
    if (!this.overBudget()) this.releaseHolds('budget')
    this.releaseHolds('no_slot')
    return { server: this.serverEntity() }
  }

  private requestWake(agentId: string, reason: WakeReason): void {
    const row = this.requireAgentRow(agentId)
    this.applyAgentEvent(agentId, { type: 'wake_requested', admission: this.admissionFor(row), reason })
  }

  /** Moves an agent along if its state and queue allow: wakes it for queued work, or hands queued work to its runner. */
  private settleAgent(agentId: string): void {
    const row = this.store.agentById(agentId)
    if (!row) return
    this.endGoalCycleIfFinished(agentId)
    const now = this.config.clock.now()
    const queued = this.store.deliveriesOfAgentInState(agentId, 'queued')
    const { state } = row.lifecycle

    if (state.state === 'idle' || state.state === 'in_turn') {
      this.dispatchQueued(row, queued)
      return
    }
    const wakeReason = wakeReasonForQueuedWork(state, now)
    if (wakeReason === null) return
    if (hasWakingDelivery(queued)) {
      this.requestWake(agentId, wakeReason)
    } else if (state.state === 'held') {
      this.applyAgentEvent(agentId, { type: 'hold_cleared_without_work' })
    }
  }

  private dispatchQueued(row: AgentRow, queued: DeliveryRow[]): void {
    const { state } = row.lifecycle
    if (state.state !== 'idle' && state.state !== 'in_turn') return
    const selected = selectForDispatch(
      queued.map((delivery) => ({ deliveryId: delivery.id, wake: delivery.wake, state: delivery.state, seq: delivery.messageSeq })),
      state.state === 'in_turn',
    )
    if (selected.length === 0) return

    const turnId = state.state === 'in_turn' ? state.turnId : randomUUID()
    const now = this.config.clock.now()
    this.applyAgentEvent(row.id, { type: 'deliveries_dispatched', generation: state.generation, turnId })
    const byId = new Map(queued.map((delivery) => [delivery.id, delivery]))
    for (const { deliveryId } of selected) {
      const delivery = byId.get(deliveryId)!
      const attemptId = randomUUID()
      const handed = handToRunner(delivery.state, turnId, attemptId, now)
      this.store.insertDeliveryAttempt({ id: attemptId, deliveryId, turnId, generation: state.generation, startedAt: now })
      this.store.updateDeliveryState(delivery, handed)
      this.pendingEffects.push({ effect: 'deliver', agentId: row.id, generation: state.generation, delivery: this.deliveryForModel({ ...delivery, state: handed }) })
    }
    this.store.updateAgentFields(row.id, { lastActivityAt: now })
  }

  private deliveryForModel(delivery: DeliveryRow): DeliveryForModel {
    if (!isInTurn(delivery.state)) throw new Error(`delivery ${delivery.id} is not in a turn`)
    const message = this.store.messageById(delivery.messageId)
    if (!message) throw new Error(`delivery ${delivery.id} has no message`)
    const chat = this.store.chatEntity(message.chatId)
    const modelContent = renderForModel(
      { from: message.from, text: message.text, purpose: message.purpose, attachmentPaths: message.attachments.map((attachment) => this.namedAttachmentPath(attachment)) },
      { wake: delivery.wake, possiblySeen: delivery.state.possiblySeen },
      { groupHandle: chat?.kind === 'group' ? chatHandle(chat) : null },
    )
    return { attemptId: delivery.state.attemptId, from: message.from, text: message.text, modelContent }
  }

  /** Inside a transaction. */
  private considerSummary(agentId: string, trigger: SummaryTrigger): void {
    const attempt = this.summaries.consider(agentId, trigger)
    if (attempt) this.pendingEffects.push({ effect: 'summarize', agentId, attempt })
  }

  // External effects

  private performEffect(effect: PendingEffect): void {
    switch (effect.effect) {
      case 'launch_runner':
        return this.launchRunner(effect.agentId, effect.generation, effect.resumeConversation)
      case 'signal_runner_stop':
        this.runners.signalStop(effect.agentId, effect.generation)
        return
      case 'kill_runner':
        this.runners.kill(effect.agentId, effect.generation)
        return
      case 'send_interrupt':
        this.runners.send(effect.agentId, effect.generation, { type: 'interrupt' })
        return
      case 'send_compact':
        this.runners.send(effect.agentId, effect.generation, { type: 'compact', instructions: compactionInstructions(this.requireAgentRow(effect.agentId).name) })
        return
      case 'deliver':
        this.runners.send(effect.agentId, effect.generation, { type: 'deliver', delivery: effect.delivery })
        return
      case 'summarize':
        void this.summaries.run(effect.attempt)
        return
      case 'consider_live_line':
        this.summaries.considerLiveLine(effect.agentId)
        return
      case 'push_message':
        this.notifier.messagePosted(effect.messageId, new Set(effect.skipPushTokenHashes))
        return
      case 'push_ask':
        this.notifier.askToNotify(effect.askId)
        return
      case 'push_remote_ask':
        this.notifier.remoteAskToNotify(effect.askId)
        return
      case 'merge_branch':
        this.mergeBranchBack(effect.agentId, effect.afterwards)
        return
    }
  }

  /** An agent that has run before but has no session to resume starts a new one, seeded from what's stored. */
  private systemPromptFor(row: AgentRow, resumeConversation: boolean, launch: LaunchModel): string {
    const notOnThisMachine = "(not on this machine: say so if it's needed)"
    const base = renderSystemPrompt(row.name === MASTER_AGENT_NAME ? this.protocols.master : this.protocols.default, {
      name: row.name,
      parent: row.parent,
      creator: row.createdBy,
      folder: row.folder,
      appSource: this.config.personSource?.appDir ?? notOnThisMachine,
      serverSource: this.config.personSource?.serverDir ?? notOnThisMachine,
    })
    const fallback = launch.fallbackFrom === null
      ? ''
      : `\n\nYou were set to run on ${launch.fallbackFrom.label}, but ${launch.fallbackFrom.provider === 'openrouter' ? 'OpenRouter' : launch.fallbackFrom.provider} isn't set up on this machine, so you are running on ${launch.model.label} instead. Say so if it matters to your work.`
    if (!resumeConversation || row.providerSessionId !== null) return base + fallback
    const seed = renderConversationSeed({
      task: row.task,
      recent: this.store.recentConversationOf(row.id, row.name, SEED_RECENT_MESSAGES),
      previousEndedOnRefusal: row.lastTurnFailure?.failure.kind === 'model_refused',
    })
    return `${base}${fallback}\n\n${seed}`
  }

  private openrouterConfigured(): boolean {
    return this.store.integrationOf('openrouter')?.state.status === 'configured'
  }

  /** What an agent's model needs from Claude Code: OpenRouter's endpoint and key, or nothing for Claude itself. */
  private providerEnv(launch: LaunchModel): { env: Record<string, string>; secretEnvFiles: Record<string, string> } {
    if (launch.model.provider !== 'openrouter') return { env: {}, secretEnvFiles: {} }
    const id = launch.model.providerModelId
    return {
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_API_KEY: '',
        // Helper calls and subagents must use a model OpenRouter has too.
        ANTHROPIC_DEFAULT_OPUS_MODEL: id,
        ANTHROPIC_DEFAULT_SONNET_MODEL: id,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
        CLAUDE_CODE_SUBAGENT_MODEL: id,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      secretEnvFiles: { ANTHROPIC_AUTH_TOKEN: this.config.paths.openrouterApiKey },
    }
  }

  private launchRunner(agentId: string, generation: number, resumeConversation: boolean): void {
    const row = this.requireAgentRow(agentId)
    const launch = launchModelFor(row.model, { openrouter: this.openrouterConfigured() })
    const providerEnv = this.providerEnv(launch)
    const credential = randomBytes(24).toString('hex')
    const stateDir = this.config.paths.agentDir(agentId)
    mkdirSync(stateDir, { recursive: true })
    if (!existsSync(row.folder)) mkdirSync(row.folder, { recursive: true })
    const memory = runtimeOf(launch.model.provider) === 'codex' ? null : this.syncedProjectMemoryOf(row.folder)
    this.store.transaction(() => {
      this.store.setAgentCredential(agentId, hashSecret(credential))
      this.store.updateAgentFields(agentId, { runnerRelease: this.config.releaseId })
    })
    try {
      this.runners.launch({
        agentId,
        generation,
        journalPath: this.config.paths.journal(agentId),
        socketPath: this.config.paths.runnerSocket(agentId, generation),
        stateDir,
        release: this.config.releaseId,
        provider: RUNNER_PROVIDER_OF_RUNTIME[runtimeOf(launch.model.provider)],
        model: launch.model.providerModelId,
        folder: row.folder,
        resumeProviderSessionId: resumeConversation ? row.providerSessionId : null,
        promptCacheTtlMs: hasTimedPromptCache(launch.model.provider) ? PROMPT_CACHE_TTL_MS[row.promptCacheLifetime] : null,
        systemPrompt: this.systemPromptFor(row, resumeConversation, launch),
        memoryDir: memory?.dir ?? null,
        secretEnvFiles: providerEnv.secretEnvFiles,
        env: {
          ...this.config.agentBaseEnv,
          ...providerEnv.env,
          PATH: `${this.config.cliBinDir}:${this.config.agentBaseEnv.PATH ?? ''}`,
          OURO_SOCKET: this.config.paths.localSocket,
          OURO_AGENT_CREDENTIAL: credential,
          OURO_AGENT_NAME: row.name,
          OURO_GOAL_NOTES: this.goalNotesPath(agentId),
          ...(memory ? { OURO_MEMORY_DIR: memory.dir } : {}),
        },
      })
    } catch (error) {
      this.commit(() => {
        this.applyAgentEvent(agentId, { type: 'runner_gone', generation, hadWork: true })
        this.store.saveAgentNote(agentId, `could not launch: ${(error as Error).message}`)
      })
      return
    }
    this.runners.connect(agentId, generation, () => this.onRunnerConnected(agentId, generation))
  }

  private onRunnerConnected(agentId: string, generation: number): void {
    this.ingestJournal(agentId)
    // We can't know whether a send before a restart arrived, so repeat them. The runner ignores attempts it already took.
    for (const delivery of this.store.deliveriesOfAgentInTurn(agentId)) {
      this.runners.send(agentId, generation, { type: 'deliver', delivery: this.deliveryForModel(delivery) })
    }
    const row = this.store.agentById(agentId)
    if (row?.lifecycle.state.state === 'interrupting' && liveGeneration(row.lifecycle.state) === generation) {
      this.runners.send(agentId, generation, { type: 'interrupt' })
    }
    this.commit(() => this.settleAgent(agentId))
  }

  /**
   * Compares what the database believes about a runner with reality, and repairs the difference. The one code path for a
   * restart, a dropped connection and a launch that never happened.
   */
  private reconcileAgent(agentId: string, generation: number, isFromDisconnect = false): void {
    const row = this.store.agentById(agentId)
    if (!row || liveGeneration(row.lifecycle.state) !== generation) return
    if (this.runners.isConnected(agentId, generation)) return

    if (!this.runners.wasLaunchAttempted(agentId, generation)) {
      // Committed `starting`, died before performing the launch.
      if (row.lifecycle.state.state === 'starting') this.launchRunner(agentId, generation, row.lifecycle.instanceGeneration > 1)
      return
    }
    if (this.runners.findProcess(agentId, generation)) {
      // Alive but unreachable right now. The next tick comes back here, so this can't spin.
      if (!isFromDisconnect) this.runners.connect(agentId, generation, () => this.onRunnerConnected(agentId, generation))
      return
    }
    // Gone for certain. Read everything it wrote before concluding anything.
    this.ingestJournal(agentId)
    this.commit(() => {
      const hadWork = this.store.countQueuedDeliveries(agentId) + this.store.deliveriesOfAgentInTurn(agentId).length > 0
      const decision = this.applyAgentEvent(agentId, { type: 'runner_gone', generation, hadWork })
      if (decision.outcome === 'transition') {
        this.runners.forgetGeneration(agentId, generation)
        this.settleAgent(agentId)
      }
    })
  }

  // Journal

  private ingestJournal(agentId: string): void {
    for (;;) {
      const row = this.store.agentById(agentId)
      if (!row) return
      const path = this.config.paths.journal(agentId)
      if (journalSize(path) <= row.journalCursor) return
      const { records, end } = readJournalForward(path, row.journalCursor, JOURNAL_READ_CHUNK_BYTES)
      if (end === row.journalCursor) return
      this.commit(() => {
        for (const record of records) this.applyJournalRecord(agentId, record)
        this.store.updateAgentFields(agentId, { journalCursor: end })
        this.settleAgent(agentId)
        this.pendingEffects.push({ effect: 'consider_live_line', agentId })
      })
    }
  }

  private applyJournalRecord(agentId: string, record: JournalRecord): void {
    const row = this.requireAgentRow(agentId)
    const { state } = row.lifecycle
    if (record.generation !== row.lifecycle.instanceGeneration) return
    const generation = record.generation
    this.summaries.noteRecord(agentId, record)

    const noteActivity = (activity: Extract<AgentEvent, { type: 'turn_activity' }>['activity']) => {
      if (state.state !== 'in_turn') return
      this.applyAgentEvent(agentId, { type: 'turn_activity', generation, turnId: state.turnId, activity })
    }

    switch (record.kind) {
      case 'runner_started':
      case 'notice':
      case 'runner_exiting':
      case 'incoming':
        return
      case 'taken_in':
        this.markTakenIn(agentId, record.attemptIds, record.at)
        return
      case 'runner_ready':
        this.applyAgentEvent(agentId, { type: 'runner_ready', generation })
        return
      case 'session_identified':
        this.store.updateAgentFields(agentId, { providerSessionId: record.providerSessionId })
        return
      case 'session_unresumable':
        // The next launch starts a new conversation, seeded from what's stored. A runner gone for this reason is a crash
        // like any other, so its backoff applies.
        if (row.providerSessionId === record.providerSessionId) this.store.updateAgentFields(agentId, { providerSessionId: null })
        return
      case 'thinking':
        noteActivity({ kind: 'thinking' })
        return
      case 'text':
        this.store.updateAgentFields(agentId, { lastOutputAt: record.at, lastActivityAt: record.at })
        noteActivity({ kind: 'thinking' })
        return
      case 'tool_use':
        this.store.updateAgentFields(agentId, { lastOutputAt: record.at, lastActivityAt: record.at })
        noteActivity({ kind: 'tool', toolName: record.toolName })
        return
      case 'tool_result':
        this.store.updateAgentFields(agentId, { lastOutputAt: record.at, lastActivityAt: record.at })
        noteActivity({ kind: 'thinking' })
        return
      case 'turn_result':
        this.applyTurnResult(row, record)
        this.considerSummary(agentId, 'turn_finished')
        return
      case 'plan_usage_observed': {
        // OpenRouter runs on Claude Code too, but on no plan.
        const account = this.accountOf(row)
        if (account !== null) this.observePlanUsage(account, record.windows, record.at)
        return
      }
      case 'turn_failed': {
        if (state.state !== 'in_turn' && state.state !== 'interrupting') return
        if (record.failure === 'logged_out') this.recordSignedOut(this.accountOf(row))
        const retryAt = this.turnRetryAt(row, record)
        // How much of the context the failed turn changed is unknown.
        this.store.savePromptCache(agentId, null)
        this.applyAgentEvent(agentId, { type: 'turn_failed', generation, turnId: state.turnId, failure: record.failure, detail: record.detail, retryAt })
        return
      }
      case 'compaction_finished': {
        // Records from a runner of an earlier release carry no size: the context is then unknown.
        const tokens = record.contextTokens ?? null
        this.store.savePromptCache(agentId, tokens !== null && row.promptCache !== null ? promptCacheAfterCompaction(row.promptCache, tokens, record.at) : null)
        this.applyAgentEvent(agentId, { type: 'compaction_finished', generation })
        return
      }
    }
  }

  /** Spend the turn's own report leaves out: the ChatGPT plan's windows, and what OpenRouter charged. */
  private refreshUsageAfterTurn(row: AgentRow): void {
    switch (launchModelFor(row.model, { openrouter: this.openrouterConfigured() }).model.provider) {
      case 'openai': return this.integrations.usedByTurn('chatgpt')
      case 'openrouter': return this.integrations.usedByTurn('openrouter')
      case 'anthropic':
      case 'stand_in': return
    }
  }

  /** A plan's usage limit lifts when its windows reset, which the provider's last reading says even when its error doesn't. */
  private turnRetryAt(row: AgentRow, record: Extract<JournalRecord, { kind: 'turn_failed' }>): number | null {
    const now = this.config.clock.now()
    if (record.retryAfterMs !== null) return now + record.retryAfterMs
    if (record.failure !== 'usage_limit') return null
    const account = this.accountOf(row)
    return account === null ? null : usageLimitLiftsAt(this.planReadingKnown(account), now)
  }

  /** Only attempts still handed to the runner move: a repeated record, or one for an attempt since requeued, changes nothing. */
  private markTakenIn(agentId: string, attemptIds: readonly string[], at: number): void {
    const taken = new Set(attemptIds)
    for (const delivery of this.store.deliveriesOfAgentInState(agentId, 'handed_to_runner')) {
      if (delivery.state.state === 'handed_to_runner' && taken.has(delivery.state.attemptId)) this.store.updateDeliveryState(delivery, markTakenIn(delivery.state, at))
    }
  }

  private applyTurnResult(row: AgentRow, record: Extract<JournalRecord, { kind: 'turn_result' }>): void {
    const { state } = row.lifecycle
    if (state.state !== 'in_turn' && state.state !== 'interrupting') return
    const now = this.config.clock.now()
    this.store.updateAgentFields(row.id, { costUsd: row.costUsd + record.costUsd, lastActivityAt: record.at })
    const account = this.accountOf(row)
    if (account !== null && record.costUsd > 0) this.store.addPlanTurnCost(row.id, account, record.at, record.costUsd)
    this.refreshUsageAfterTurn(row)
    // Records from a runner of an earlier release, and some providers, carry no context: it is then unknown, and a record
    // from before this turn (say, compacted) no longer describes it.
    const context = record.context ?? null
    this.store.savePromptCache(row.id, context === null ? null : promptCacheAfterTurn(context, record.at))

    if (state.state === 'interrupting') {
      this.applyAgentEvent(row.id, { type: 'turn_finished', generation: record.generation, turnId: state.turnId, continuation: { kind: 'no_unacknowledged_deliveries' } })
      return
    }

    // A turn that finishes is the agent working again: an earlier failure no longer describes it.
    if (row.lastTurnFailure !== null) this.store.setLastTurnFailure(row.id, null)
    for (const ask of this.store.openAsksOfAgent(row.id)) if (ask.source.kind === 'system' && ask.source.problem === 'crash_loop') this.closeAsk(ask.id, now)

    const goal = this.store.goalOf(row.id)
    if (goal?.runningCycleMessageId) this.store.saveGoal(addCycleCost(goal, record.costUsd))

    const acknowledged = new Set(record.acknowledgedAttemptIds)
    const unacknowledged: DeliveryRow[] = []
    for (const delivery of this.store.deliveriesOfAgentInTurn(row.id)) {
      if (isInTurn(delivery.state) && acknowledged.has(delivery.state.attemptId)) {
        this.store.updateDeliveryState(delivery, completeDelivery(delivery.state, 'turn_finished', now))
      } else {
        unacknowledged.push(delivery)
      }
    }
    this.applyAgentEvent(row.id, {
      type: 'turn_finished',
      generation: record.generation,
      turnId: state.turnId,
      continuation: unacknowledged.length > 0 ? { kind: 'unacknowledged_deliveries_remain', nextTurnId: randomUUID() } : { kind: 'no_unacknowledged_deliveries' },
    })
    // With another turn to come, what's owed may still be answered there: the check moves to its end.
    const after = this.requireAgentRow(row.id)
    if (after.lifecycle.state.state === 'idle' && !hasWakingDelivery(this.store.deliveriesOfAgentInState(row.id, 'queued'))) this.remindOfRepliesOwed(after)
  }

  // Reads

  identity(): ServerIdentity {
    return { app: 'ouro', machineName: this.config.machineName, machineId: this.store.getMeta('machine_id')!, releaseId: this.config.releaseId, apiVersion: 2, latestUpdate: this.appUpdates.newest() }
  }

  /** Asked by `ouro publish` on this machine, after it has exported the app. */
  registerAppUpdate(input: RegisterUpdateInput): { updateNumber: number; runtimeVersion: string; mark: string } {
    const row = this.appUpdates.register(input)
    this.notifier.updatePublished(row.updateNumber)
    return { updateNumber: row.updateNumber, runtimeVersion: row.runtimeVersion, mark: updateMarkOf(row.updateNumber, this.appUpdates.machineId()) }
  }

  /** Publishes the app in the person's source as `ouro publish` does, registering it here directly. */
  private publishApp(appDir: string): Promise<PublishedApp> {
    const exportCommand = this.config.agentBaseEnv.OURO_APP_EXPORT_COMMAND ?? DEFAULT_EXPORT_COMMAND
    return publishCommittedApp(appDir, exportCommand, async (input) => this.registerAppUpdate(input), () => {})
  }

  private serverEntity(): ServerEntity {
    return {
      id: 'server',
      machineName: this.config.machineName,
      release: { id: this.config.releaseId, base: this.baseUpdates.status(), version: this.config.version },
      sourceBackup: this.sourceBackup.status(),
      defaultModel: this.config.defaultModel,
      models: this.modelOptions(),
      limits: { agentLimit: this.agentLimit(), idleFoldMinutes: 60, budgetUsd: this.budgetUsd(), autoArchiveAfterHours: this.autoArchiveAfterHours(), replyReminders: this.replyRemindersOn() },
      planUsage: { claude: this.planUsageIfRead('claude'), chatgpt: this.planUsageIfRead('chatgpt') },
    }
  }

  private planUsageIfRead(account: PlanAccount): PlanUsage | null {
    const reading = this.planReadingKnown(account)
    return reading === null ? null : planUsageOf(reading)
  }

  /** A plan as read here, or, for Claude's, each window as whichever computer on this login read it last. */
  private planReadingKnown(account: PlanAccount): PlanReading | null {
    const readHere = this.store.planReading(account)
    return account === 'claude' ? sameLoginPlanReading(readHere, this.peers.peersClaudePlans()) : readHere
  }

  private agentEntityOf(row: AgentRow): AgentEntity {
    return this.store.agentEntity(row, this.config.releaseId, this.planShareOf(row))
  }

  /** Only Claude's plan reports costs, so only its windows can be split among agents: this machine's and those on its
   * other computers on the same login. */
  private planShareOf(row: AgentRow): PlanWindow[] | null {
    if (this.accountOf(row) !== 'claude') return null
    const windows = this.planReadingKnown('claude')?.windows ?? []
    const now = this.config.clock.now()
    const peersClaudePlans = this.peers.peersClaudePlans()
    return windows.map((window) => {
      const costs = this.store.planTurnCostsSince('claude', windowStartOf(window, now))
      const hereCostUsd = [...costs.values()].reduce((sum, cost) => sum + cost, 0)
      const allAgentsCostUsd = hereCostUsd + sameLoginCostUsd(window, windows, peersClaudePlans)
      return shareOfWindow(window, costs.get(row.id) ?? 0, allAgentsCostUsd)
    })
  }

  /** What every agent here cost of a plan since then, archived ones included. */
  private planCostSince(account: PlanAccount, since: number): number {
    return [...this.store.planTurnCostsSince(account, since).values()].reduce((sum, cost) => sum + cost, 0)
  }

  /**
   * A plan's new reading changes the server's usage, every share of it, and whether goals on it wait. Archived agents' shares
   * change too, but nothing watches them closely enough to send them all.
   */
  private observePlanUsage(account: PlanAccount, windows: PlanWindowReading[], at: number): void {
    this.store.savePlanReading(account, mergePlanReading(this.store.planReading(account), windows, at))
    this.markPlanReadingChanged(account)
  }

  /** So does another computer's word on the same plan. */
  private markPlanReadingChanged(account: PlanAccount): void {
    this.store.markChanged('server', 'server')
    for (const agent of this.store.listUnarchivedAgents()) {
      if (this.accountOf(agent) !== account) continue
      this.store.markChanged('agent', agent.id)
      if (this.store.goalOf(agent.id)) this.store.markChanged('goal', agent.id)
    }
  }

  viewerOf(caller: Caller & { kind: 'person' }): Viewer {
    const { person } = caller
    return { address: person.address, personId: person.id, personName: person.name, isOwner: person.isOwner, deviceId: caller.deviceId, deviceName: caller.deviceName }
  }

  snapshot(viewer: Viewer): Snapshot {
    this.notePersonBack(viewer.address)
    return this.store.transaction(() => ({
      epoch: this.store.getMeta('epoch')!,
      cursor: this.store.currentCursor(),
      viewer,
      server: this.serverEntity(),
      agents: this.store.listAgents().map((row) => this.agentEntityOf(row)),
      chats: this.store.listChatIds().map((id) => this.store.chatEntity(id)!),
      readStates: this.store.listChatIds()
        .filter((chatId) => this.store.chatMembers(chatId).some((member) => member.address === viewer.address))
        .map((chatId) => this.store.readStateEntity(viewer.personId, chatId, viewer.address)),
      asks: this.store.listAskEntities(),
      goals: this.store.listGoals().map((goal) => this.goalEntity(goal)),
      summaries: this.store.listSummaryEntities(),
      people: this.store.listPeople().map((row) => this.store.personEntity(row)),
      devices: this.store.listDevices().map((row) => this.store.deviceEntity(row)),
      notificationSettings: { id: viewer.personId, ...this.store.notificationSettingsOf(viewer.personId) },
      integrations: this.store.listIntegrations(),
      computers: this.peers.list(),
      remoteAgents: this.peers.remoteAgents(),
      remoteAsks: this.store.listRemoteAskEntities(),
    }))
  }

  /** Every message on this server holding all the query's words, newest first. */
  search(query: string, limit: number): SearchPage {
    const words = searchWords(query)
    if (words.length === 0) return { hits: [], more: false }
    const { messages, more } = this.store.searchMessages(words, Math.min(Math.max(1, limit), SEARCH_MAX_LIMIT))
    const hits = messages.map((message) => ({ chatId: message.chatId, messageId: message.id, seq: message.seq, at: message.at, from: message.from, ...excerptAround(message.text, words) }))
    return { hits, more }
  }

  epoch(): string {
    return this.store.getMeta('epoch')!
  }

  /** The changes after `cursor` this viewer may see, with the entities' current values. */
  changesAfter(cursor: number, viewer: Viewer, limit: number): Change[] {
    return this.store.changesAfter(cursor, viewer.personId, limit).flatMap((row) => {
      if (row.deleted) return [Change.parse({ cursor: row.cursor, entity: row.entity, id: row.entityId, op: 'delete' })]
      const value = this.entityValue(row.entity, row.entityId, viewer)
      if (value === null) return [Change.parse({ cursor: row.cursor, entity: row.entity, id: row.entityId, op: 'delete' })]
      return [Change.parse({ cursor: row.cursor, entity: row.entity, id: row.entityId, op: 'upsert', value })]
    })
  }

  private entityValue(kind: EntityKind, id: string, viewer: Viewer): object | null {
    switch (kind) {
      case 'server': return this.serverEntity()
      case 'agent': {
        const row = this.store.agentById(id)
        return row && this.agentEntityOf(row)
      }
      case 'message': {
        const row = this.store.messageById(id)
        return row && this.store.messageEntity(row)
      }
      case 'chat': return this.store.chatEntity(id)
      case 'read_state': {
        const chatId = id.slice(viewer.personId.length + 1)
        return this.store.readStateEntity(viewer.personId, chatId, viewer.address)
      }
      case 'person': {
        const row = this.store.personById(id)
        return row && this.store.personEntity(row)
      }
      case 'device': {
        const row = this.store.deviceById(id)
        return row && this.store.deviceEntity(row)
      }
      case 'ask': return this.store.openAskById(id)
      case 'goal': {
        const goal = this.store.goalOf(id)
        return goal && this.goalEntity(goal)
      }
      case 'summary':
        return this.store.summaryEntity(id)
      case 'notification_settings':
        return id === viewer.personId ? { id, ...this.store.notificationSettingsOf(id) } : null
      case 'integration':
        return this.store.integrationOf(id as IntegrationProvider)
      case 'computer': {
        const peer = this.store.peerById(id)
        return peer && this.peers.entityOf(peer)
      }
      case 'remote_agent': return this.peers.remoteAgentById(id)
      case 'remote_ask': return this.store.remoteAskById(id)
    }
  }

  chatHistory(chatId: string, before: number | null, limit: number): { messages: MessageEntity[]; hasOlder: boolean } {
    if (!this.store.chatExists(chatId)) throw new CommandRefused('not_found', 'no such chat')
    const page = this.store.chatHistory(chatId, before, Math.min(Math.max(limit, 1), HISTORY_PAGE_LIMIT_MAX))
    return { messages: page.messages.map((row) => this.store.messageEntity(row)), hasOlder: page.hasOlder }
  }

  agentLog(agentId: string, request: { after: number | null; before: number | null }): LogPage {
    this.requireAgentRow(agentId)
    const path = this.config.paths.journal(agentId)
    const toLogRecords = (records: JournalRecord[]) => records.flatMap((record) => logRecordOf(record))
    if (request.after !== null) {
      const { records, end } = readJournalForward(path, request.after, LOG_PAGE_BYTES)
      return { records: toLogRecords(records), startCursor: request.after, endCursor: end, hasEarlier: request.after > 0 }
    }
    const end = request.before ?? journalSize(path)
    const { records, start } = readJournalBackward(path, end, LOG_PAGE_BYTES)
    return { records: toLogRecords(records), startCursor: start, endCursor: end, hasEarlier: start > 0 }
  }

  agentSummaries(agentId: string, before: number | null, limit: number): SummaryPage {
    this.requireAgentRow(agentId)
    return this.store.summariesOf(agentId, before, Math.min(Math.max(limit, 1), SUMMARY_PAGE_LIMIT_MAX))
  }

  /** "What state is this agent in, and why?" answered from records. */
  agentExplanation(agentId: string, limit: number): { agent: AgentEntity; transitions: ReturnType<Store['agentTransitions']> } {
    const row = this.requireAgentRow(agentId)
    return { agent: this.agentEntityOf(row), transitions: this.store.agentTransitions(agentId, limit) }
  }

  // Credentials

  authenticateDevice(token: string): (Caller & { kind: 'person' }) | null {
    const device = this.store.deviceByTokenHash(hashSecret(token))
    if (!device) return null
    const person = this.store.personById(device.personId)
    if (!person) return null
    return { kind: 'person', person, deviceId: device.id, deviceName: device.name }
  }

  /** The local socket with no credential: whoever can reach the socket is on this machine as the owner's user. */
  localOwnerCaller(): Caller & { kind: 'person' } {
    return { kind: 'person', person: this.store.ownerPerson()!, deviceId: 'local', deviceName: 'this computer' }
  }

  authenticateAgent(credential: string): (Caller & { kind: 'agent' }) | null {
    const agent = this.store.agentByCredentialHash(hashSecret(credential))
    return agent ? { kind: 'agent', agent } : null
  }

  // Pairing

  /** A local operator asking for a code, as `start_pairing` would, without needing a device first. */
  startPairing(inviteePersonName: string | null): CommandOutput<'start_pairing'> {
    const code = randomBytes(16).toString('hex')
    const expiresAt = this.config.clock.now() + PAIRING_CODE_TTL_MS
    this.store.insertPairingCode(hashSecret(code), inviteePersonName, expiresAt)
    const url = this.config.publicUrl ?? ''
    const link = `${this.config.linkScheme}://pair?url=${encodeURIComponent(url)}&code=${code}`
    return { code, expiresAt, link }
  }

  pair(code: string, deviceName: string): PairResponse {
    return this.commit(() => {
      const now = this.config.clock.now()
      const consumed = this.store.consumePairingCode(hashSecret(code), now)
      if (!consumed) throw new CommandRefused('pairing_code_invalid', 'this pairing code has expired or was already used')
      const person = consumed.inviteePersonName === null ? this.store.ownerPerson()! : this.personForInvitee(consumed.inviteePersonName, now)
      const deviceToken = randomBytes(32).toString('hex')
      const deviceId = randomUUID()
      this.store.insertDevice({ id: deviceId, name: deviceName, personId: person.id, pairedAt: now, lastSeenAt: null, revokedAt: null }, hashSecret(deviceToken))
      if (person.isOwner) this.ensureMasterAgent(person, now)
      return { deviceToken, deviceId, personId: person.id, machineId: this.store.getMeta('machine_id')!, machineName: this.config.machineName }
    })
  }

  /**
   * The owner's front door, made when they first sign in. It waits, stopped, for their first message, so it costs
   * nothing until then. Its protocol (master.md) tells it what it is.
   */
  private ensureMasterAgent(owner: PersonRow, now: number): void {
    // An archived master stays archived: that was the person's choice.
    if (this.store.activeAgentByName(MASTER_AGENT_NAME) || this.store.newestArchivedAgentByName(MASTER_AGENT_NAME)) return
    this.store.insertAgent({
      id: shortId(),
      name: MASTER_AGENT_NAME,
      task: MASTER_TASK,
      folder: join(this.config.defaultFolder, MASTER_AGENT_NAME),
      model: this.config.defaultModel,
      parent: owner.address,
      createdBy: owner.address,
      createdAt: now,
      lifecycle: { state: { state: 'stopped', since: now, stopped: { reason: 'idle' } }, instanceGeneration: 0, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: 0, consecutiveStalls: 0 },
      credentialHash: hashSecret(randomUUID()),
      worktree: null,
      promptCacheLifetime: '5m',
    })
  }

  private personForInvitee(name: string, now: number): PersonRow {
    const existing = this.store.personByName(name)
    if (existing) {
      if (existing.removed) this.store.restorePerson(existing.person.id)
      return existing.person
    }
    const person: PersonRow = { id: randomUUID(), name, address: personAddress(name), isOwner: false, joinedAt: now }
    this.store.insertPerson(person)
    return person
  }

  // Asked by the guardian, over the local socket only

  issueProbeCredential(): { deviceToken: string } {
    const deviceToken = randomBytes(32).toString('hex')
    const owner = this.store.ownerPerson()!
    this.commit(() => this.store.insertProbeDevice({ id: randomUUID(), name: 'guardian probe', personId: owner.id, pairedAt: this.config.clock.now(), lastSeenAt: null, revokedAt: null }, hashSecret(deviceToken)))
    return { deviceToken }
  }

  /** This release is proven. Agents on older ones move to it, each between its turns. */
  confirmRelease(): void {
    this.commit(() => this.store.setMeta('confirmed_release', this.config.releaseId))
    this.moveAgentsToConfirmedRelease()
  }

  private moveAgentsToConfirmedRelease(): void {
    if (this.store.getMeta('confirmed_release') !== this.config.releaseId) return
    for (const agent of this.store.listUnarchivedAgents()) {
      if (agent.runnerRelease === this.config.releaseId || liveGeneration(agent.lifecycle.state) === null) continue
      this.commit(() => this.applyAgentEvent(agent.id, { type: 'new_release_available' }))
    }
  }

  /** Something the person must hear from the system itself. Stays in their chat with `system`, whoever is looking. */
  postSystemNotice(text: string, alsoToAgent: string | null): void {
    this.commit(() => {
      const now = this.config.clock.now()
      this.postNoticeToPerson(this.store.ownerPerson()!.address, text)
      const agent = alsoToAgent === null ? null : this.store.activeAgentByName(alsoToAgent)
      if (agent) {
        this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text, attachments: [], purpose: 'system_notice', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
        this.requestWake(agent.id, 'new_message')
        this.settleAgent(agent.id)
      }
    })
  }

  // Commands

  /**
   * Runs what a command needs before its transaction: a goal's check is a real process, and can take minutes. Its result is
   * an input to the command, so the command itself stays one synchronous transaction.
   */
  async prepareCommand(caller: Caller, name: string, idempotencyKey: string, rawInput: unknown): Promise<PreparedChecks> {
    const nothing = NOTHING_PREPARED
    // A retry of a command that already ran answers as it did then, without going to the network again.
    if (this.store.idempotentResult(callerKeyOf(caller), idempotencyKey)) return nothing
    if (name === 'refresh_plan_usage') return { ...nothing, planUsageRead: await this.readUsageNow(rawInput) }
    if (caller.kind === 'person' && commandBringsWork(name, rawInput) && !(await this.holdHostForWork())) {
      throw new CommandRefused('host_hold_refused', `${this.config.machineName} couldn't stay awake for it; try again`)
    }
    if (name === 'create_agent') {
      const input = commands.create_agent.input.safeParse(rawInput)
      if (!input.success || (input.data.name ?? '').trim() !== '') return nothing
      return { ...nothing, agentName: { kind: 'suggested', suggestion: await this.suggestAgentName(input.data.task, input.data.model ?? this.config.defaultModel) } }
    }
    if (name === 'join_computer') {
      const input = commands.join_computer.input.safeParse(rawInput)
      return input.success ? { ...nothing, joinedHost: await this.peers.askToJoin(input.data.address, input.data.code) } : nothing
    }
    if (name === 'snooze_ask') {
      const input = commands.snooze_ask.input.safeParse(rawInput)
      const copy = input.success && caller.kind === 'person' && caller.person.isOwner ? this.store.remoteAskById(input.data.askId) : null
      if (!input.success || !copy || caller.kind !== 'person') return nothing
      const snooze = this.snoozeAsAsked(caller.person.id, input.data.snooze)
      return { ...nothing, remoteAskSnoozed: { kind: 'snoozed', snooze: await this.peers.snoozeRemoteAsk(copy.computerId, { askId: copy.id, snooze }) } }
    }
    if (name === 'control_remote_agent') {
      const input = commands.control_remote_agent.input.safeParse(rawInput)
      if (!input.success) return nothing
      return { ...nothing, remoteAgentAnswer: await this.requireComputerManagerAsync(caller, () => this.peers.control(input.data.remoteAgentId, input.data.action, idempotencyKey)) }
    }
    if (name === 'create_remote_agent') {
      const input = commands.create_remote_agent.input.safeParse(rawInput)
      if (!input.success) return nothing
      const { computerId, ...request } = input.data
      const from: PeerSender = caller.kind === 'agent' ? { kind: 'agent', name: caller.agent.name } : { kind: 'owner' }
      return { ...nothing, remoteAgentAnswer: await this.requireComputerManagerAsync(caller, () => this.peers.createRemote(computerId, from, request, idempotencyKey)) }
    }
    if (name === 'move_agent') {
      const input = commands.move_agent.input.safeParse(rawInput)
      const agent = input.success ? this.store.agentById(input.data.agentId) : null
      if (!input.success || !agent) return nothing
      await this.peers.checkMove(input.data.computerId, agent.name)
      return { ...nothing, moveTargetReady: true }
    }
    if (name === 'remove_computer') {
      const input = commands.remove_computer.input.safeParse(rawInput)
      if (input.success) await this.peers.tellOfRemoval(input.data.computerId)
      return nothing
    }
    if (name === 'create_source_backup' || name === 'push_source_backup') {
      if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner backs the source up')
      await (name === 'create_source_backup' ? this.sourceBackup.create() : this.sourceBackup.pushNow())
      return nothing
    }
    let agentId: string | null = null
    if (name === 'finish_agent' && caller.kind === 'agent') agentId = caller.agent.id
    if (name === 'mark_goal_done') agentId = (rawInput as { agentId?: unknown } | null)?.agentId as string ?? null
    if (agentId === null) return nothing
    const goal = this.store.goalOf(agentId)
    const agent = this.store.agentById(agentId)
    if (!goal || !agent || goal.kind.kind !== 'checked' || goal.progress.status === 'complete') return nothing
    return { ...nothing, goalCheck: await runCheck(goal.kind.checkCommand, agent.folder) }
  }

  /** Validates, deduplicates and runs a command. Throws CommandRefused for refusals. */
  executeCommand(caller: Caller, name: string, idempotencyKey: string, rawInput: unknown, prepared: PreparedChecks = NOTHING_PREPARED): unknown {
    if (!Object.hasOwn(commands, name)) throw new CommandRefused('not_found', `no such command: ${name}`)
    const command = commands[name as CommandName]
    if (!(command.callers as readonly string[]).includes(caller.kind)) throw new CommandRefused('forbidden', `a ${caller.kind} can't use ${name}`)
    const parsedInput = command.input.safeParse(rawInput)
    if (!parsedInput.success) throw new CommandRefused('invalid_request', parsedInput.error.message)

    const callerKey = callerKeyOf(caller)
    const inputHash = hashSecret(JSON.stringify(parsedInput.data))
    return this.commit(() => {
      const earlier = this.store.idempotentResult(callerKey, idempotencyKey)
      if (earlier) {
        if (earlier.command !== name || earlier.inputHash !== inputHash) throw new CommandRefused('idempotency_conflict', 'this idempotency key was already used for something else')
        return JSON.parse(earlier.resultJson) as unknown
      }
      const output = this.runCommand(caller, name as CommandName, parsedInput.data, idempotencyKey, prepared)
      this.store.saveIdempotentResult(callerKey, idempotencyKey, name, inputHash, JSON.stringify(output), this.config.clock.now())
      return output
    })
  }

  private runCommand(caller: Caller, name: CommandName, input: unknown, idempotencyKey: string, prepared: PreparedChecks): unknown {
    switch (name) {
      case 'create_agent': return this.createAgent(caller, input as never, idempotencyKey, prepared.agentName.kind === 'suggested' ? prepared.agentName.suggestion : NO_NAME_SUGGESTION)
      case 'send_message': return this.commandSendMessage(caller, input as never, idempotencyKey)
      case 'broadcast_message': return this.commandBroadcast(caller, input as never, idempotencyKey)
      case 'reply': return this.commandReply(caller, input as never, idempotencyKey)
      case 'finish_agent': return this.commandFinish(caller, input as never, idempotencyKey, prepared)
      case 'set_goal': return this.commandSetGoal(caller, input as never)
      case 'set_goal_interval': return this.withGoal(input as never, (goal) => setGoalInterval(goal, (input as { intervalSeconds: number | null }).intervalSeconds))
      case 'pause_goal': return this.commandPauseGoal(caller, input as never)
      case 'resume_goal': return this.withGoal(input as never, resumeGoal)
      case 'reopen_goal': return this.withGoal(input as never, reopenGoal)
      case 'mark_goal_done': return this.commandMarkGoalDone(input as never, prepared)
      case 'clear_goal': return this.commandClearGoal(input as never)
      case 'snooze_ask': return this.commandSnoozeAsk(caller, input as never, prepared)
      // Whoever stops a turn is dealing with what it was doing: it leaves no reply reminder behind.
      case 'interrupt_agent': return this.withRepliesDropped(input as never, this.commandAgentEvent(input as never, { type: 'interrupt_requested', by: addressOfCaller(caller) }, 'it is not in a turn'))
      case 'stop_agent': return this.withRepliesDropped(input as never, this.commandAgentEvent(input as never, { type: 'stop_requested', by: addressOfCaller(caller) }, 'it is not running'))
      case 'archive_agent': return this.commandAgentEvent(input as never, { type: 'archive_requested' }, 'it is already archived')
      case 'unarchive_agent': return this.commandUnarchive(input as never)
      case 'set_agent_model': return this.commandSetModel(input as never)
      case 'merge_agent_branch': return this.commandMergeBranch(input as never)
      case 'mark_chat_read': return this.commandMarkRead(caller, input as never)
      case 'watch_agent': return this.commandWatchAgent(caller, input as never)
      case 'register_push_token': return this.commandRegisterPushToken(caller, input as never)
      case 'clear_push_token': return this.commandClearPushToken(caller)
      case 'set_notification_settings': return this.commandSetNotificationSettings(caller, input as never)
      case 'relay_message': return this.commandRelay(caller, input as never, idempotencyKey)
      case 'start_pairing': return this.commandStartPairing(caller, input as never)
      case 'revoke_device': return this.commandRevokeDevice(caller, input as never)
      case 'remove_person': return this.commandRemovePerson(caller, input as never)
      case 'set_limits': return this.commandSetLimits(caller, input as never)
      case 'set_auto_archive': return this.commandSetAutoArchive(caller, input as never)
      case 'set_reply_reminders': return this.commandSetReplyReminders(caller, input as never)
      case 'refresh_plan_usage': return this.commandRefreshPlanUsage(prepared)
      case 'take_base_update': return this.commandTakeBaseUpdate(caller, input as never)
      case 'continue_base_update': return this.commandContinueBaseUpdate()
      case 'create_source_backup':
      case 'push_source_backup': return { server: this.serverEntity() }
      case 'ask': return this.commandAsk(caller, input as never, idempotencyKey)
      case 'withdraw_ask': return this.commandWithdrawAsk(caller, input as never)
      case 'sync_memory': return this.commandSyncMemory(caller)
      case 'create_computer_invite': return this.requireComputerManager(caller, () => this.peers.createInvite())
      case 'join_computer': return this.requireComputerManager(caller, () => {
        if (prepared.joinedHost === null) throw new CommandRefused('invalid_request', 'joining needs the other computer to answer first')
        return { computer: this.peers.admitHost(prepared.joinedHost) }
      })
      case 'remove_computer': return this.requireComputerManager(caller, () => {
        this.peers.remove((input as { computerId: string }).computerId)
        return {}
      })
      case 'control_remote_agent': return this.requireComputerManager(caller, () => {
        if (prepared.remoteAgentAnswer === null) throw new CommandRefused('invalid_request', 'controlling an agent elsewhere needs its computer to answer first')
        return { remoteAgent: this.peers.noteAnswered(prepared.remoteAgentAnswer.computerId, prepared.remoteAgentAnswer.card) }
      })
      case 'create_remote_agent': return this.requireComputerManager(caller, () => {
        if (prepared.remoteAgentAnswer === null) throw new CommandRefused('invalid_request', 'starting an agent elsewhere needs its computer to answer first')
        return { remoteAgent: this.peers.noteAnswered(prepared.remoteAgentAnswer.computerId, prepared.remoteAgentAnswer.card) }
      })
      case 'move_agent': return this.commandMoveAgent(caller, input as never, prepared)
      case 'set_computer_trust': return this.requireComputerManager(caller, () => {
        const { computerId, trust } = input as { computerId: string; trust: ComputerTrust }
        return { computer: this.peers.setTrust(computerId, trust) }
      })
      case 'create_chat': return this.commandCreateChat(caller, input as never)
      case 'add_chat_member': return this.commandChangeMembers(input as never, 'add')
      case 'remove_chat_member': return this.commandChangeMembers(input as never, 'remove')
      case 'post_to_chat': return this.commandPostToChat(caller, input as never, idempotencyKey)
    }
  }

  private requireAgentRow(agentId: string): AgentRow {
    const row = this.store.agentById(agentId)
    if (!row) throw new CommandRefused('not_found', 'no such agent')
    return row
  }

  /** A short name for an agent on this model, from its task: the summarizer's model is asked, the stand-in's for the
   * stand-in. */
  private suggestAgentName(task: string, agentModel: string): Promise<NameSuggestion> {
    const namer = agentModel === STAND_IN_MODEL ? { summarize: standInSuggestName, model: STAND_IN_MODEL } : { summarize: this.config.summarize, model: this.config.summaryModel }
    return suggestAgentName(namer.summarize, namer.model, task, NAME_SUGGESTION_TIMEOUT_MS)
  }

  private createAgent(caller: Caller, input: NewAgentRequest, idempotencyKey: string, nameSuggestion: NameSuggestion): CommandOutput<'create_agent'> {
    const parent = addressOfCaller(caller)
    const agentId = this.startAgent(input, idempotencyKey, caller.kind === 'agent'
      ? { parent, createdBy: caller.agent.createdBy, parentAgentId: caller.agent.id, folder: input.folder ?? caller.agent.folder }
      : { parent, createdBy: parent, parentAgentId: null, folder: input.folder ?? this.config.defaultFolder }, nameSuggestion)
    return { agent: this.agentEntityOf(this.requireAgentRow(agentId)) }
  }

  /** A fully trusted peer starts an agent here as the owner would, the owner being the same person there; its parent is
   * the sender, as written here. A retry with the same key answers as the first did. */
  private async createAgentFromPeer(peer: PeerRow, request: PeerCreateAgent): Promise<PeerCreateAgentResult> {
    const callerKey = `peer:${peer.machineId}`
    const asksForName = (request.name ?? '').trim() === '' && !this.store.idempotentResult(callerKey, request.idempotencyKey)
    const nameSuggestion = asksForName ? await this.suggestAgentName(request.task, request.model ?? this.config.defaultModel) : NO_NAME_SUGGESTION
    const parent = request.from.kind === 'owner' ? OWNER_ADDRESS : `${request.from.name}@${peer.name}`
    try {
      return this.commit(() => {
        const earlier = this.store.idempotentResult(callerKey, request.idempotencyKey)
        if (earlier) return JSON.parse(earlier.resultJson) as PeerCreateAgentResult
        // Files don't travel between computers yet, so a request from one names none.
        const agentId = this.startAgent({ ...request, attachmentIds: [] }, `${callerKey}:${request.idempotencyKey}`, { parent, createdBy: OWNER_ADDRESS, parentAgentId: null, folder: request.folder ?? this.config.defaultFolder }, nameSuggestion)
        if (request.from.kind === 'owner') this.store.addOwnerChatPeer(agentId, peer.machineId, this.config.clock.now())
        const result: PeerCreateAgentResult = { outcome: 'created', agent: this.agentCard(this.requireAgentRow(agentId), 'full') }
        this.store.saveIdempotentResult(callerKey, request.idempotencyKey, 'create_agent', hashSecret(JSON.stringify(request)), JSON.stringify(result), this.config.clock.now())
        return result
      })
    } catch (error) {
      // Thrown out of the transaction, so a refusal leaves nothing made.
      if (error instanceof CommandRefused) return { outcome: 'refused', code: error.code, message: error.message }
      throw error
    }
  }

  /** Makes the agent and gives it its task, from its parent; answers its id. */
  private startAgent(input: NewAgentRequest, clientKey: string, origin: NewAgentOrigin, nameSuggestion: NameSuggestion = NO_NAME_SUGGESTION): string {
    const now = this.config.clock.now()
    const name = this.chooseAgentName(input.name, input.task, nameSuggestion.name)
    // Resolved first, so a missing file refuses the command before anything is made.
    const attachments = this.resolveAttachments(input.attachmentIds)
    const { parent } = origin
    const agentId = shortId()
    const preLaunchLifecycle: AgentLifecycle = { state: { state: 'stopped', since: now, stopped: { reason: 'idle' } }, instanceGeneration: 0, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: 0, consecutiveStalls: 0 }
    this.store.insertAgent({
      id: agentId,
      name,
      task: input.task,
      folder: origin.folder,
      model: input.model ?? this.config.defaultModel,
      parent,
      createdBy: origin.createdBy,
      createdAt: now,
      lifecycle: preLaunchLifecycle,
      credentialHash: hashSecret(randomUUID()),
      worktree: null,
      promptCacheLifetime: input.promptCacheLifetime,
    })
    // Asking for its name is the agent's first spend.
    if (nameSuggestion.costUsd > 0) this.store.updateAgentFields(agentId, { costUsd: nameSuggestion.costUsd })
    const created = this.requireAgentRow(agentId)
    const admission = this.admissionFor(created)
    // No free slot refuses a new agent outright; any other hold takes it in, held, and it starts once the hold clears.
    if (admission.kind === 'refused' && admission.hold === 'no_slot') throw new CommandRefused('agent_limit_reached', `the limit of ${this.agentLimit()} running agents is reached`)
    if (admission.kind === 'refused' && admission.hold === 'budget') throw new CommandRefused('budget_spent', `the budget of $${this.budgetUsd()} is spent: raise it to start agents`)
    this.placeInOwnWorktree(created)

    this.postDirect({ from: parent, fromAgentId: origin.parentAgentId, toAgent: created, text: input.task, attachments, purpose: 'task', wake: 'wake', clientKey, answersAskId: null, relayedBy: null })
    this.applyAgentEvent(agentId, { type: 'wake_requested', admission, reason: 'created' })
    return agentId
  }

  /** `suggested`: the model's name from the task, used in place of the task's first words. */
  private chooseAgentName(requested: string | null, task: string, suggested: string | null): string {
    if (requested !== null && requested.trim() !== '') {
      const name = requested.trim()
      if (RESERVED_AGENT_NAMES.includes(name) || name === MASTER_AGENT_NAME) throw new CommandRefused('agent_name_reserved', `"${name}" is reserved`)
      if (!AGENT_NAME_PATTERN.test(name)) throw new CommandRefused('invalid_request', `"${name}" isn't a valid agent name: letters, digits, - and _ only`)
      if (this.store.activeAgentByName(name)) throw new CommandRefused('agent_name_taken', `an agent named "${name}" already exists`)
      return name
    }
    const base = suggested ?? agentNameFromTask(task)
    if (!this.store.activeAgentByName(base) && !RESERVED_AGENT_NAMES.includes(base) && base !== MASTER_AGENT_NAME) return base
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base}-${suffix}`
      if (!this.store.activeAgentByName(candidate)) return candidate
    }
  }

  private directChatId(a: ParticipantKey, b: ParticipantKey): string {
    return `dm_${hashSecret([a, b].sort().join('|')).slice(0, 24)}`
  }

  /** The direct chat between a sender and an agent or person, created on first use. */
  private ensureDirectChat(a: { key: ParticipantKey; address: string }, b: { key: ParticipantKey; address: string }, createdBy: string): string {
    const chatId = this.directChatId(a.key, b.key)
    if (!this.store.chatExists(chatId)) {
      const now = this.config.clock.now()
      this.store.insertChat({ id: chatId, kind: 'direct', title: null, createdBy, createdAt: now, homeMachine: this.config.machineName, members: [{ address: a.address, joinedAt: now }, { address: b.address, joinedAt: now }] })
    }
    return chatId
  }

  private markUnreadChanged(chatId: string): void {
    for (const member of this.store.chatMembers(chatId)) {
      const person = this.store.personByAddress(member.address)
      if (person) this.store.markChanged('read_state', `${person.id}:${chatId}`, person.id)
    }
  }

  private postDirect(post: DirectPost): MessageRow {
    const senderKey: ParticipantKey = post.fromAgentId ? `agent:${post.fromAgentId}` : `person:${post.from}`
    return this.postDirectWithId(randomUUID(), senderKey, post)
  }

  /** `id`: a message from another machine keeps the id it was sent with there. */
  private postDirectWithId(id: string, senderKey: ParticipantKey, post: DirectPost): MessageRow {
    const chatId = this.ensureDirectChat({ key: senderKey, address: post.from }, { key: `agent:${post.toAgent.id}`, address: post.toAgent.name }, post.from)
    const now = this.config.clock.now()
    const message = this.store.insertMessage({ id, chatId, from: post.from, at: now, text: post.text, attachments: post.attachments, purpose: post.purpose, clientKey: post.clientKey, posesAskId: null, answersAskId: post.answersAskId, relayedBy: post.relayedBy })
    this.store.insertDelivery({ id: randomUUID(), messageId: message.id, messageSeq: message.seq, recipient: post.toAgent.name, agentId: post.toAgent.id, wake: post.wake, state: newQueuedDelivery(now) })
    this.store.updateAgentFields(post.toAgent.id, { lastActivityAt: now })
    const goal = this.store.goalOf(post.toAgent.id)
    if (goal && post.wake === 'wake' && (post.purpose === 'message' || post.purpose === 'done_report')) this.store.saveGoal(noteRealMessage(goal))
    this.markUnreadChanged(chatId)
    return message
  }

  private postToPerson(post: { fromAgent: AgentRow; to: PersonRow; text: string; attachments: AttachmentRef[]; purpose: MessagePurpose; clientKey: string | null; posesAskId: string | null }): MessageRow {
    const chatId = this.ensureDirectChat({ key: `agent:${post.fromAgent.id}`, address: post.fromAgent.name }, { key: `person:${post.to.address}`, address: post.to.address }, post.fromAgent.name)
    const now = this.config.clock.now()
    const message = this.store.insertMessage({ id: randomUUID(), chatId, from: post.fromAgent.name, at: now, text: post.text, attachments: post.attachments, purpose: post.purpose, clientKey: post.clientKey, posesAskId: post.posesAskId, answersAskId: null, relayedBy: null })
    this.store.updateAgentFields(post.fromAgent.id, { lastActivityAt: now })
    this.markUnreadChanged(chatId)
    this.pendingEffects.push({ effect: 'push_message', messageId: message.id, skipPushTokenHashes: [] })
    if (post.to.isOwner) this.copyToOwnerChatPeers(post.fromAgent, message)
    return message
  }

  /** The person's other computers they talked to this agent from show its side of the chat too. Files don't go to other
   * computers yet, so a message of files alone isn't copied; a peer too old to take it is skipped. */
  private copyToOwnerChatPeers(agent: AgentRow, message: MessageRow): void {
    if (message.text.trim() === '' || (message.purpose !== 'message' && message.purpose !== 'done_report')) return
    const asked = message.posesAskId === null ? null : this.store.openAskById(message.posesAskId)
    const senderPushTokenHashes = this.ownerPushTokenHashes()
    const asMessage: PeerOwnerMessage = { messageId: message.id, from: agent.name, text: message.text, purpose: message.purpose, sentAt: message.at, senderPushTokenHashes }
    for (const peer of this.ownerChatPeersSpeaking(agent.id, PEER_OWNER_MESSAGES_PROTOCOL)) {
      const recipient = `${OWNER_ADDRESS}@${peer.name}`
      // A peer that takes asks gets the ask with its message; an older one gets the message alone.
      if (asked && (peer.hello?.protocol ?? 0) >= PEER_OWNER_ASKS_PROTOCOL) {
        const body: PeerOwnerAsk = { state: 'open', askId: asked.id, from: agent.name, level: asked.level, text: message.text, choices: asked.choices, askedAt: asked.at, messageId: message.id, senderPushTokenHashes }
        this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/owner-asks', body }, messageId: message.id, recipient, now: message.at })
        continue
      }
      this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/owner-messages', body: asMessage }, messageId: message.id, recipient, now: message.at })
    }
  }

  /** See PUSH_TOKEN_HASHES in the contract. */
  private ownerPushTokenHashes(): string[] {
    const owner = this.store.ownerPerson()
    return owner ? this.store.pushTargetsOf(owner.id).map((target) => pushTokenHash(target.registration.token)) : []
  }

  private ownerChatPeersSpeaking(agentId: string, protocol: number): PeerRow[] {
    return this.store.ownerChatPeersOf(agentId)
      .map((machineId) => this.store.peerById(machineId))
      .filter((peer): peer is PeerRow => peer !== null && (peer.hello?.protocol ?? 0) >= protocol)
  }

  /** Snoozes an ask here, or ends its snooze, and tells the person's other computers that have it. `remindNow`: the end is
   * itself the reminder. */
  private setAskSnooze(ask: AskEntity, snooze: AskSnooze | null, { remindNow }: { remindNow: boolean }): void {
    this.store.setAskSnooze(ask.id, snooze)
    if (ask.source.kind !== 'agent' || !this.store.personByAddress(ask.to)?.isOwner) return
    const body: PeerOwnerAsk = { state: 'snooze_changed', askId: ask.id, from: ask.agentName, snooze, remindNow }
    for (const peer of this.ownerChatPeersSpeaking(ask.agentId, PEER_ASK_SNOOZE_PROTOCOL)) {
      this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/owner-asks', body }, messageId: null, recipient: `${OWNER_ADDRESS}@${peer.name}`, now: this.config.clock.now() })
    }
  }

  /** The person snoozed, from a computer they talk to the agent from, a copy of its ask. */
  private askSnoozeFromPeer(peer: PeerRow, request: PeerAskSnooze): PeerAskSnoozeResult {
    const ask = this.store.openAskById(request.askId)
    if (!ask) return { outcome: 'refused', code: 'ask_closed', message: 'that question is already closed' }
    const shownThere = ask.source.kind === 'agent' && this.store.personByAddress(ask.to)?.isOwner === true && this.store.ownerChatPeersOf(ask.agentId).includes(peer.machineId)
    if (!shownThere) return { outcome: 'refused', code: 'not_found', message: 'no such question for that computer' }
    let snooze: AskSnooze | null
    try {
      snooze = this.snoozeAsAsked(this.store.ownerPerson()!.id, request.snooze)
    } catch (error) {
      if (error instanceof CommandRefused) return { outcome: 'refused', code: error.code, message: error.message }
      throw error
    }
    this.setAskSnooze(ask, snooze, { remindNow: false })
    return { outcome: 'snoozed', snooze }
  }

  /** Closes an ask here, and tells the person's other computers that have it. */
  private closeAsk(askId: string, now: number): void {
    const ask = this.store.openAskById(askId)
    this.store.closeAsk(askId, now)
    if (!ask || ask.source.kind !== 'agent' || !this.store.personByAddress(ask.to)?.isOwner) return
    const body: PeerOwnerAsk = { state: 'closed', askId: ask.id, from: ask.agentName }
    for (const peer of this.ownerChatPeersSpeaking(ask.agentId, PEER_OWNER_ASKS_PROTOCOL)) {
      this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/owner-asks', body }, messageId: null, recipient: `${OWNER_ADDRESS}@${peer.name}`, now })
    }
  }

  /** An ask an agent on a peer put to the person: its message filed as an owner message is, and a copy of the ask kept
   * until that peer says it closed. */
  private ownerAskFromPeer(peer: PeerRow, ask: PeerOwnerAsk): PeerMessageResult {
    if (ask.state === 'closed') {
      this.store.removeRemoteAsk(ask.askId)
      return { outcome: 'accepted' }
    }
    if (ask.state === 'snooze_changed') {
      if (this.store.remoteAskById(ask.askId)?.computerId !== peer.machineId) return { outcome: 'accepted' }
      this.store.setRemoteAskSnooze(ask.askId, ask.snooze)
      if (ask.remindNow) this.pendingEffects.push({ effect: 'push_remote_ask', askId: ask.askId })
      return { outcome: 'accepted' }
    }
    if (this.store.messageById(ask.messageId)) return { outcome: 'accepted' }
    const from = `${ask.from}@${peer.name}`
    const chatId = this.ensureDirectChat({ key: `person:${OWNER_ADDRESS}`, address: OWNER_ADDRESS }, { key: `remote:${from}`, address: from }, from)
    this.store.insertMessage({ id: ask.messageId, chatId, from, at: this.config.clock.now(), text: ask.text, attachments: [], purpose: 'message', clientKey: null, posesAskId: ask.askId, answersAskId: null, relayedBy: null })
    const now = this.config.clock.now()
    this.store.insertRemoteAsk({ id: ask.askId, peerMachineId: peer.machineId, agentName: ask.from, level: ask.level, text: ask.text, choices: ask.choices, askedAt: ask.askedAt, chatId, senderPushTokenHashes: ask.senderPushTokenHashes, notifiedAt: now })
    this.markUnreadChanged(chatId)
    this.pendingEffects.push({ effect: 'push_remote_ask', askId: ask.askId })
    return { outcome: 'accepted' }
  }

  /** What an agent on a peer said to the person: filed in the person's chat with `name@machine` here, as it is there. */
  private ownerMessageFromPeer(peer: PeerRow, message: PeerOwnerMessage): PeerMessageResult {
    if (this.store.messageById(message.messageId)) return { outcome: 'accepted' }
    const from = `${message.from}@${peer.name}`
    const chatId = this.ensureDirectChat({ key: `person:${OWNER_ADDRESS}`, address: OWNER_ADDRESS }, { key: `remote:${from}`, address: from }, from)
    this.store.insertMessage({ id: message.messageId, chatId, from, at: this.config.clock.now(), text: message.text, attachments: [], purpose: message.purpose, clientKey: null, posesAskId: null, answersAskId: null, relayedBy: null })
    this.markUnreadChanged(chatId)
    this.pendingEffects.push({ effect: 'push_message', messageId: message.messageId, skipPushTokenHashes: message.senderPushTokenHashes })
    return { outcome: 'accepted' }
  }

  private resolveAttachments(ids: string[]): AttachmentRef[] {
    return ids.map((id) => {
      const attachment = this.store.attachmentById(id)
      if (!attachment) throw new CommandRefused('not_found', `no such attachment: ${id}`)
      return attachment
    })
  }

  private sendFrom(caller: Caller, to: string, text: string, attachments: AttachmentRef[], wake: DeliveryWake, answersAskId: string | null, clientKey: string, purpose: MessagePurpose = 'message'): MessageRow {
    if (text.trim() === '' && attachments.length === 0) throw new CommandRefused('empty_message', 'an empty message says nothing')
    const parsed = parseAddress(to)
    if (parsed.kind === 'agent' && parsed.machine !== null && parsed.machine !== this.config.machineName) {
      return this.sendToPeer(caller, { agentName: parsed.agentName, machine: parsed.machine }, text, attachments, wake, answersAskId, clientKey, purpose)
    }

    // An agent that moved to another computer is reached there.
    const moved = parsed.kind === 'agent' && !this.store.activeAgentByName(parsed.agentName) ? this.store.newestMovedAgentByName(parsed.agentName) : null
    if (moved && moved.lifecycle.state.state === 'moved') {
      const movedTo = parseAddress(moved.lifecycle.state.to)
      if (movedTo.kind === 'agent' && movedTo.machine !== null) return this.sendToPeer(caller, { agentName: movedTo.agentName, machine: movedTo.machine }, text, attachments, wake, null, clientKey, purpose)
    }

    if (parsed.kind === 'agent') {
      const toAgent = this.recipientAgent(parsed.agentName)
      const from = addressOfCaller(caller)
      const message = this.postDirect({ from, fromAgentId: caller.kind === 'agent' ? caller.agent.id : null, toAgent, text, attachments, purpose, wake, clientKey, answersAskId, relayedBy: null })
      if (wake === 'wake') this.requestWake(toAgent.id, 'new_message')
      this.settleAgent(toAgent.id)
      return message
    }

    if (caller.kind !== 'agent') throw new CommandRefused('invalid_request', 'people message agents or group chats')
    const person = this.store.personByAddress(to)
    if (!person) throw new CommandRefused('not_found', `no person at ${to}`)
    return this.postToPerson({ fromAgent: caller.agent, to: person, text, attachments, purpose, clientKey, posesAskId: null })
  }

  // Across machines

  /** To an agent on another of the person's computers: kept here, and queued for that machine, which takes it in order. */
  private sendToPeer(caller: Caller, to: { agentName: string; machine: string }, text: string, attachments: AttachmentRef[], wake: DeliveryWake, answersAskId: string | null, clientKey: string, purpose: MessagePurpose): MessageRow {
    const peer = this.store.peerByName(to.machine)
    if (!peer) throw new CommandRefused('not_found', `no computer called ${to.machine}. See: ouro computers`)
    if (attachments.length > 0) throw new CommandRefused('invalid_request', 'files to other computers are not supported yet')
    if (purpose !== 'message' && purpose !== 'done_report') throw new CommandRefused('invalid_request', `a ${purpose} can't go to another computer`)
    if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', "only the owner and agents message other computers")
    const answered = answersAskId === null ? null : this.store.remoteAskById(answersAskId)
    if (answersAskId !== null && (answered === null || answered.computerId !== peer.machineId || answered.agentName !== to.agentName)) throw new CommandRefused('ask_closed', 'that question is already closed')
    const from = addressOfCaller(caller)
    const senderKey: ParticipantKey = caller.kind === 'agent' ? `agent:${caller.agent.id}` : `person:${from}`
    const recipient = `${to.agentName}@${peer.name}`
    const chatId = this.ensureDirectChat({ key: senderKey, address: from }, { key: `remote:${recipient}`, address: recipient }, from)
    const now = this.config.clock.now()
    const message = this.store.insertMessage({ id: randomUUID(), chatId, from, at: now, text, attachments: [], purpose, clientKey, posesAskId: null, answersAskId, relayedBy: null })
    const request: PeerMessage = {
      messageId: message.id,
      from: caller.kind === 'agent' ? { kind: 'agent', name: caller.agent.name } : { kind: 'owner' },
      to: to.agentName,
      text,
      wake,
      purpose,
      sentAt: now,
      answersAskId,
    }
    this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/messages', body: request }, messageId: message.id, recipient, now })
    if (caller.kind === 'agent') this.store.updateAgentFields(caller.agent.id, { lastActivityAt: now })
    this.markUnreadChanged(chatId)
    return message
  }

  /** What a peer sees of one of this machine's agents: its name and whether it is working, and with full trust the rest. */
  private agentCard(agent: AgentRow, trust: ComputerTrust): PeerAgentCard {
    const { state } = agent.lifecycle
    const working = state.state === 'starting' || state.state === 'in_turn' || state.state === 'interrupting' || state.state === 'compacting'
    const details = trust === 'limited' ? null : {
      task: agent.task,
      model: agent.model,
      state,
      lastActivityAt: agent.lastActivityAt,
      summaryLine: this.store.summaryEntity(agent.id)?.latest?.line ?? null,
    }
    return { name: agent.name, activity: working ? 'running' : 'waiting', details }
  }

  /** A fully trusted peer acts on an agent here as the owner would, the owner being the same person there. */
  private controlFromPeer(peer: PeerRow, control: PeerControl): PeerControlResult {
    const agent = this.store.activeAgentByName(control.agentName)
    if (!agent) return { outcome: 'refused', code: 'not_found', message: `no agent named ${control.agentName} here` }
    const command = REMOTE_ACTION_COMMANDS[control.action.kind]
    const input = control.action.kind === 'set_model' ? { agentId: agent.id, model: control.action.model } : { agentId: agent.id }
    try {
      this.executeCommand(this.localOwnerCaller(), command, `peer:${peer.machineId}:${control.idempotencyKey}`, input)
    } catch (error) {
      if (error instanceof CommandRefused) return { outcome: 'refused', code: error.code, message: error.message }
      throw error
    }
    return { outcome: 'done', agent: this.agentCard(this.requireAgentRow(agent.id), 'full') }
  }

  /** A message from a peer for an agent here. The owner is the same person on each of their computers, so the owner's
   * words arrive as the owner's; an agent there is `name@machine` here. */
  private deliverFromPeer(peer: PeerRow, message: PeerMessage): PeerMessageResult {
    if (this.store.messageById(message.messageId)) return { outcome: 'accepted' }
    const toAgent = this.store.activeAgentByName(message.to)
    if (!toAgent) return { outcome: 'undeliverable', reason: this.whyNoAgentHere(message.to) }
    const from = message.from.kind === 'owner' ? OWNER_ADDRESS : `${message.from.name}@${peer.name}`
    const senderKey: ParticipantKey = message.from.kind === 'owner' ? `person:${OWNER_ADDRESS}` : `remote:${from}`
    if (message.from.kind === 'owner') this.store.addOwnerChatPeer(toAgent.id, peer.machineId, this.config.clock.now())
    // An answer to an ask that closed meanwhile still arrives, as a plain message; it closes nothing else.
    const answered = message.from.kind === 'owner' && message.answersAskId !== null ? this.store.openAskById(message.answersAskId) : null
    const answersAskId = answered !== null && answered.agentId === toAgent.id ? answered.id : null
    this.postDirectWithId(message.messageId, senderKey, { from, fromAgentId: null, toAgent, text: message.text, attachments: [], purpose: message.purpose, wake: message.wake, clientKey: null, answersAskId, relayedBy: null })
    if (message.wake === 'wake') this.requestWake(toAgent.id, 'new_message')
    this.settleAgent(toAgent.id)
    if (message.from.kind === 'owner' && (message.answersAskId === null || answersAskId !== null)) this.closeAsksAnsweredBy(toAgent.name, answersAskId)
    return { outcome: 'accepted' }
  }

  // Moves between computers

  /** The agent goes once nothing runs: at the end of its turn if it is in one. Its computer was asked first. */
  private commandMoveAgent(caller: Caller, input: { agentId: string; computerId: string }, prepared: PreparedChecks): CommandOutput<'move_agent'> {
    if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner moves agents between computers')
    const agent = this.requireAgentRow(input.agentId)
    if (agent.name === MASTER_AGENT_NAME) throw new CommandRefused('forbidden', "the master agent stays on this computer: it is this computer's front door")
    const peer = this.peers.requirePeer(input.computerId)
    if (!prepared.moveTargetReady) throw new CommandRefused('invalid_request', `moving an agent needs ${peer.name} to answer first`)
    const decision = this.applyAgentEvent(agent.id, { type: 'move_requested', toMachine: peer.name })
    if (decision.outcome === 'refused') throw new CommandRefused('agent_state_conflict', `can't move ${agent.name} now: it is ${agent.lifecycle.state.state}`)
    return { agent: this.agentEntityOf(this.requireAgentRow(agent.id)) }
  }

  /** Hands each moving agent to its computer, one handoff at a time per agent. A handoff that may have arrived is sent
   * again, the same, until it is answered; one that certainly didn't is called off, and the agent stays. */
  private continueMoves(now: number): void {
    for (const agent of this.store.listUnarchivedAgents()) {
      const { state } = agent.lifecycle
      if (state.state !== 'moving' || this.handoffsInFlight.has(agent.id)) continue
      const retry = this.handoffRetries.get(agent.id)
      if (retry && retry.at > now) continue
      const peer = this.store.peerByName(state.toMachine)
      if (!peer) {
        if (state.handoff.kind === 'not_sent') this.commit(() => this.callOffMove(agent.id, `${state.toMachine} was removed from this computer`))
        continue
      }
      const move = this.handoffOf(agent, state.ownershipEpoch)
      this.handoffsInFlight.add(agent.id)
      void this.peers.handOver(peer, move)
        .then((outcome) => this.commit(() => {
          if (outcome.kind === 'unknown') {
            const attempts = (this.handoffRetries.get(agent.id)?.attempts ?? 0) + 1
            this.handoffRetries.set(agent.id, { attempts, at: this.config.clock.now() + peerRetryDelayMs(attempts) })
            this.applyAgentEvent(agent.id, { type: 'move_unconfirmed', why: outcome.why })
            return
          }
          this.handoffRetries.delete(agent.id)
          if (outcome.kind === 'not_taken') this.callOffMove(agent.id, outcome.why)
          else this.finishMoveHere(agent.id, addressFromPeer(outcome.address, peer.name, this.config.machineName), move)
        }))
        .finally(() => this.handoffsInFlight.delete(agent.id))
    }
  }

  /** Everything that goes with an agent: its record, goal, model conversation, waiting messages and its project's notes. */
  private handoffOf(agent: AgentRow, ownershipEpoch: number): PeerMove {
    const runtime = runtimeOf(launchModelFor(agent.model, { openrouter: this.openrouterConfigured() }).model.provider)
    const files = agent.providerSessionId === null ? null : conversationFilesOf(runtime, agent.providerSessionId, agent.folder, this.conversationStoresOf(agent.id))
    const goal = this.store.goalOf(agent.id)
    const project = this.memory.projectMemoryOf(agent.folder)
    const inDefault = relative(this.config.defaultFolder, agent.folder)
    const waiting = this.store.deliveriesOfAgentInState(agent.id, 'queued').map((delivery) => {
      const message = this.store.messageById(delivery.messageId)!
      return { messageId: message.id, from: message.from, text: message.text, wake: delivery.wake, purpose: message.purpose, sentAt: message.at }
    })
    return {
      moveId: `${this.store.getMeta('machine_id')}:${agent.id}:${ownershipEpoch}`,
      agent: {
        name: agent.name,
        task: agent.task,
        model: agent.model,
        parent: agent.parent,
        createdBy: agent.createdBy,
        createdAt: agent.createdAt,
        folder: inDefault === '' || (!inDefault.startsWith('..') && !isAbsolute(inDefault)) ? { kind: 'in_default_folder', relativePath: inDefault } : { kind: 'absolute', path: agent.folder },
        ownershipEpoch,
        promptCacheLifetime: agent.promptCacheLifetime,
      },
      goal: goal && goal.progress.status !== 'complete' ? {
        text: goal.text,
        kind: goal.kind,
        paused: goal.progress.status === 'paused',
        chosenIntervalSeconds: goal.chosenIntervalSeconds,
        cycleCount: goal.cycleCount,
        costUsd: goal.costUsd,
        setBy: goal.setBy,
        setAt: goal.setAt,
      } : null,
      goalNotes: existsSync(this.goalNotesPath(agent.id)) ? readFileSync(this.goalNotesPath(agent.id), 'utf8') : '',
      conversation: files === null || agent.providerSessionId === null ? null : {
        runtime,
        providerSessionId: agent.providerSessionId,
        ranIn: agent.folder,
        files: files.map((file) => ({ path: file.path, contentBase64: file.content.toString('base64') })),
      },
      waiting,
      memory: project ? { projectKey: project.projectKey, notes: this.memory.sharedNotesOf(project) } : null,
    }
  }

  private conversationStoresOf(agentId: string): ConversationStores {
    return { agentStateDir: this.config.paths.agentDir(agentId), claudeConfigDir: this.claudeConfigDir }
  }

  /** The other computer has it: it is `moved` here from now on, and what it hadn't taken in went with it or after it. */
  private finishMoveHere(agentId: string, address: string, move: PeerMove): void {
    const agent = this.requireAgentRow(agentId)
    const decision = this.applyAgentEvent(agentId, { type: 'move_confirmed', to: address })
    if (decision.outcome === 'refused') return
    const now = this.config.clock.now()
    const carried = new Set(move.waiting.map((waiting) => waiting.messageId))
    for (const delivery of this.store.deliveriesOfAgentInState(agentId, 'queued')) {
      if (carried.has(delivery.messageId)) this.store.updateDeliveryState(delivery, { state: 'forwarded', at: now, to: address })
      else this.forwardArrivedDuringMove(delivery, address)
    }
    this.store.reparentAgents(agent.name, address)
    for (const chat of this.store.groupChats()) {
      if (chat.homeMachine !== this.config.machineName) continue
      const member = chat.members.find((candidate) => candidate.address === agent.name)
      if (!member) continue
      this.store.removeChatMember(chat.id, agent.name)
      this.store.addChatMember(chat.id, address, member.joinedAt)
      this.replicateGroup(chat.id, null, [])
    }
  }

  /** A message that arrived while the handoff was on its way follows it, if its sender can be named there. */
  private forwardArrivedDuringMove(delivery: DeliveryRow, address: string): void {
    const now = this.config.clock.now()
    const message = this.store.messageById(delivery.messageId)!
    const to = parseAddress(address)
    const peer = to.kind === 'agent' && to.machine !== null ? this.store.peerByName(to.machine) : null
    const sender: PeerSender | null = message.from === OWNER_ADDRESS ? { kind: 'owner' } : this.store.activeAgentByName(message.from) ? { kind: 'agent', name: message.from } : null
    const purpose = message.purpose === 'message' || message.purpose === 'done_report' ? message.purpose : null
    if (!peer || to.kind !== 'agent' || sender === null || purpose === null) {
      this.store.updateDeliveryState(delivery, { state: 'undeliverable', at: now, reason: `it moved to ${address} before taking this in` })
      return
    }
    const request: PeerMessage = { messageId: message.id, from: sender, to: to.agentName, text: message.text, wake: delivery.wake, purpose, sentAt: message.at, answersAskId: null }
    this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/messages', body: request }, messageId: message.id, recipient: address, now })
    this.store.updateDeliveryState(delivery, { state: 'forwarded', at: now, to: address })
  }

  /** It stays here, as it was, and is told why. */
  private callOffMove(agentId: string, why: string): void {
    const agent = this.requireAgentRow(agentId)
    if (agent.lifecycle.state.state !== 'moving') return
    const toMachine = agent.lifecycle.state.toMachine
    if (this.applyAgentEvent(agentId, { type: 'move_called_off', why }).outcome === 'refused') return
    this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text: `Your move to ${toMachine} was called off: ${why}. You are still on ${this.config.machineName}, as you were.`, attachments: [], purpose: 'system_notice', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
    this.requestWake(agentId, 'new_message')
    this.settleAgent(agentId)
  }

  private moveCheckFromPeer(peer: PeerRow, check: PeerMoveCheck): PeerMoveCheckResult {
    const refusal = this.whyNotTake(check.name)
    return refusal === null ? { outcome: 'ready' } : { outcome: 'refused', reason: refusal }
  }

  private whyNotTake(name: string): string | null {
    if (name === MASTER_AGENT_NAME || RESERVED_AGENT_NAMES.includes(name)) return `"${name}" is reserved on ${this.config.machineName}`
    if (this.store.activeAgentByName(name)) return `an agent named ${name} already lives on ${this.config.machineName}`
    return null
  }

  /** A fully trusted peer hands an agent over. Taken once, by the handoff's id: sent again, it is answered as before, and
   * any message that arrived there meanwhile comes too. */
  private moveFromPeer(peer: PeerRow, move: PeerMove): PeerMoveResult {
    const here = (address: string) => addressFromPeer(address, peer.name, this.config.machineName)
    const taken = this.store.moveTaken(move.moveId)
    if (taken) {
      if (taken.fromMachineId !== peer.machineId) return { outcome: 'refused', reason: 'that handoff came from another computer' }
      const agent = this.requireAgentRow(taken.agentId)
      this.takeWaiting(agent, move.waiting, here)
      return { outcome: 'taken', address: `${agent.name}@${this.config.machineName}` }
    }
    const refusal = this.whyNotTake(move.agent.name)
    if (refusal !== null) return { outcome: 'refused', reason: refusal }
    const now = this.config.clock.now()
    const agentId = shortId()
    const folder = move.agent.folder.kind === 'in_default_folder' ? join(this.config.defaultFolder, move.agent.folder.relativePath) : move.agent.folder.path
    const runtime = runtimeOf(launchModelFor(move.agent.model, { openrouter: this.openrouterConfigured() }).model.provider)
    const conversation = move.conversation !== null && move.conversation.runtime === runtime ? move.conversation : null
    if (conversation) {
      const files = conversation.files.map((file) => ({ path: file.path, content: Buffer.from(file.contentBase64, 'base64') }))
      try {
        installConversation(runtime, { providerSessionId: conversation.providerSessionId, ranIn: conversation.ranIn, files }, folder, this.conversationStoresOf(agentId))
      } catch (error) {
        return { outcome: 'refused', reason: `its conversation couldn't be written here: ${(error as Error).message}` }
      }
    }
    this.store.insertAgent({
      id: agentId,
      name: move.agent.name,
      task: move.agent.task,
      folder,
      model: move.agent.model,
      parent: here(move.agent.parent),
      createdBy: here(move.agent.createdBy),
      createdAt: move.agent.createdAt,
      // It has run before, on the other computer: its next launch continues its conversation, or starts one seeded from
      // what's stored here.
      lifecycle: { state: { state: 'stopped', since: now, stopped: { reason: 'idle' } }, instanceGeneration: 1, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: move.agent.ownershipEpoch, consecutiveStalls: 0 },
      credentialHash: hashSecret(randomUUID()),
      // Files go by git, not by worktree: here it works in the folder it is given.
      worktree: null,
      promptCacheLifetime: move.agent.promptCacheLifetime,
    })
    if (conversation) this.store.updateAgentFields(agentId, { providerSessionId: conversation.providerSessionId })
    if (move.goal) {
      const goal = newGoal({ agentId, text: move.goal.text, kind: move.goal.kind, intervalSeconds: move.goal.chosenIntervalSeconds, setBy: here(move.goal.setBy), now })
      this.store.saveGoal({
        ...goal,
        setAt: move.goal.setAt,
        cycleCount: move.goal.cycleCount,
        costUsd: move.goal.costUsd,
        progress: move.goal.paused ? { status: 'paused', by: OWNER_ADDRESS, reason: `paused on ${peer.name}`, at: now } : { status: 'active' },
      })
    }
    if (move.goalNotes !== '') {
      mkdirSync(this.config.paths.agentDir(agentId), { recursive: true })
      writeFileSync(this.goalNotesPath(agentId), move.goalNotes)
    }
    if (move.memory) this.memory.takeSharedNotes(move.memory.projectKey, move.memory.notes)
    this.store.recordMoveTaken(move.moveId, peer.machineId, agentId, now)
    this.store.reparentAgents(`${move.agent.name}@${peer.name}`, move.agent.name)
    const agent = this.requireAgentRow(agentId)
    this.takeWaiting(agent, move.waiting, here)
    const carried = conversation ? 'Your conversation came with you' : 'Your conversation could not come with you, so this is a new one, with your recent messages below'
    this.postDirect({
      from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, purpose: 'system_notice', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null, attachments: [],
      text: `You were moved from ${peer.name} to ${this.config.machineName}. ${carried}; your files did not. Your folder is now ${folder} on ${this.config.machineName}: if your work is in git, fetch it here. Your address is ${agent.name}@${this.config.machineName}, and messages to ${agent.name}@${peer.name} are forwarded to you. Continue where you left off; if something you need stayed behind, say so.`,
    })
    this.requestWake(agentId, 'new_message')
    this.settleAgent(agentId)
    return { outcome: 'taken', address: `${agent.name}@${this.config.machineName}` }
  }

  /** Waiting messages that came with a moved agent, each kept once by its id, from their senders as written here. */
  private takeWaiting(agent: AgentRow, waiting: PeerMove['waiting'], here: (address: string) => string): void {
    for (const item of waiting) {
      if (this.store.messageById(item.messageId)) continue
      const from = here(item.from)
      const parsed = parseAddress(from)
      const localSender = parsed.kind === 'agent' && parsed.machine === null ? this.store.activeAgentByName(parsed.agentName) : null
      const senderKey: ParticipantKey = localSender ? `agent:${localSender.id}` : parsed.kind === 'agent' ? `remote:${from}` : `person:${from}`
      this.postDirectWithId(item.messageId, senderKey, { from, fromAgentId: localSender?.id ?? null, toAgent: agent, text: item.text, attachments: [], purpose: item.purpose, wake: item.wake, clientKey: null, answersAskId: null, relayedBy: null })
      if (item.wake === 'wake') this.requestWake(agent.id, 'new_message')
    }
    this.settleAgent(agent.id)
  }

  /** Why a message for this name can't be taken here, fit to show its sender. */
  private whyNoAgentHere(name: string): string {
    const moved = this.store.newestMovedAgentByName(name)
    if (moved && moved.lifecycle.state.state === 'moved') return `${name} moved to ${moved.lifecycle.state.to}: send it there`
    if (this.store.newestArchivedAgentByName(name)) return `${name} is archived on ${this.config.machineName}`
    return `no agent named ${name} on ${this.config.machineName}`
  }

  // Group chats

  /** A person, an agent that isn't archived here, or an agent on one of the person's other computers: someone who can be
   * in a group here. */
  private chatMemberAddress(address: string): string {
    const parsed = parseAddress(address)
    if (parsed.kind === 'agent') {
      if (parsed.machine !== null && parsed.machine !== this.config.machineName) {
        if (!this.store.peerByName(parsed.machine)) throw new CommandRefused('not_found', `no computer called ${parsed.machine}. See: ouro computers`)
        return `${parsed.agentName}@${parsed.machine}`
      }
      return this.recipientAgent(parsed.agentName).name
    }
    if (!this.store.personByAddress(address)) throw new CommandRefused('not_found', `no person at ${address}`)
    return address
  }

  private requireGroup(chatId: string): ChatEntity {
    const chat = this.store.chatEntity(chatId)
    if (!chat) throw new CommandRefused('not_found', 'no such chat')
    if (chat.kind !== 'group') throw new CommandRefused('invalid_request', 'a direct chat has its two members for good: message them instead')
    return chat
  }

  private commandCreateChat(caller: Caller, input: { title: string | null; members: string[] }): CommandOutput<'create_chat'> {
    const creator = addressOfCaller(caller)
    const id = `grp-${randomUUID()}`
    const title = input.title?.trim() ?? null
    if (title !== null) {
      const handle = chatHandle({ id, title })
      if (this.store.groupChats().some((chat) => chatHandle(chat) === handle)) throw new CommandRefused('chat_name_taken', `there is already a group called ${handle}`)
    }
    const now = this.config.clock.now()
    const addresses = [...new Set([creator, ...input.members.map((address) => this.chatMemberAddress(address))])]
    this.store.insertChat({ id, kind: 'group', title, createdBy: creator, createdAt: now, homeMachine: this.config.machineName, members: addresses.map((address) => ({ address, joinedAt: now })) })
    this.markUnreadChanged(id)
    this.replicateGroup(id, null, [])
    return { chat: this.store.chatEntity(id)! }
  }

  private commandChangeMembers(input: { chatId: string; address: string }, change: 'add' | 'remove'): CommandOutput<'add_chat_member'> {
    const chat = this.requireGroup(input.chatId)
    if (chat.homeMachine !== this.config.machineName) throw new CommandRefused('forbidden', `${chatHandle(chat)} lives on ${chat.homeMachine}: change its members there`)
    const machinesBefore = this.remoteMachinesOf(chat.members)
    const isMember = (address: string) => chat.members.some((member) => member.address === address)
    if (change === 'add') {
      const address = this.chatMemberAddress(input.address)
      if (!isMember(address)) {
        this.store.addChatMember(chat.id, address, this.config.clock.now())
        this.markUnreadChanged(chat.id)
      }
    } else if (isMember(input.address)) {
      // Marked before the removal, while they are still a member to tell.
      this.markUnreadChanged(chat.id)
      this.store.removeChatMember(chat.id, input.address)
    }
    // A machine that just lost its last member is told too, so its copy shows the change.
    this.replicateGroup(chat.id, null, machinesBefore)
    return { chat: this.store.chatEntity(chat.id)! }
  }

  private commandPostToChat(caller: Caller, input: { chatId: string; text: string; attachmentIds: string[] }, clientKey: string): CommandOutput<'post_to_chat'> {
    const chat = this.requireGroup(input.chatId)
    const message = this.postToGroup(caller, chat, input.text, this.resolveAttachments(input.attachmentIds), clientKey)
    return { message: this.store.messageEntity(this.store.messageById(message.id)!), pendingAtHome: chat.homeMachine !== this.config.machineName }
  }

  /**
   * Only members post. Each member agent gets the message: as a real one that wakes it when the post calls it by name,
   * otherwise as an FYI that waits for its next real message. People hear through unread counts, and a push if called.
   * A group whose home is another machine is posted to there, which gives everyone the post, this machine's members too.
   */
  private postToGroup(caller: Caller, chat: ChatEntity, text: string, attachments: AttachmentRef[], clientKey: string): MessageRow {
    if (text.trim() === '' && attachments.length === 0) throw new CommandRefused('empty_message', 'an empty message says nothing')
    const from = addressOfCaller(caller)
    if (!chat.members.some((member) => member.address === from)) throw new CommandRefused('not_a_member', `only members post in ${chatHandle(chat)}: join it first`)
    const acrossComputers = chat.homeMachine !== this.config.machineName || this.remoteMachinesOf(chat.members).length > 0
    if (acrossComputers && attachments.length > 0) throw new CommandRefused('invalid_request', 'files in groups across computers are not supported yet')
    if (caller.kind === 'agent') this.store.updateAgentFields(caller.agent.id, { lastActivityAt: this.config.clock.now() })
    if (chat.homeMachine !== this.config.machineName) return this.postToGroupElsewhere(caller, chat, from, text, clientKey)
    return this.postToGroupAtHome(chat, { messageId: randomUUID(), from, text, attachments, clientKey })
  }

  /** A post to a group whose home is here, from a member here or on another machine. */
  private postToGroupAtHome(chat: ChatEntity, post: { messageId: string; from: string; text: string; attachments: AttachmentRef[]; clientKey: string | null }): MessageRow {
    const now = this.config.clock.now()
    const message = this.store.insertMessage({ id: post.messageId, chatId: chat.id, from: post.from, at: now, text: post.text, attachments: post.attachments, purpose: 'message', clientKey: post.clientKey, posesAskId: null, answersAskId: null, relayedBy: null })
    const memberAgents = chat.members.flatMap((member) => {
      if (member.address === post.from) return []
      const agent = parseAddress(member.address).kind === 'agent' ? this.store.activeAgentByName(member.address) : null
      return agent ? [agent] : []
    })
    const remoteMembers = chat.members.flatMap((member) => {
      const remote = member.address === post.from ? null : this.remoteMemberOf(member.address)
      return remote ? [remote] : []
    })
    const called = mentionedMembers(post.text, [
      ...memberAgents.map((agent) => ({ address: agent.name, names: agentNames(agent.name, this.config.machineName) })),
      ...remoteMembers.map((member) => ({ address: member.address, names: agentNames(member.agentName, member.machine) })),
    ])
    for (const agent of memberAgents) {
      const wake: DeliveryWake = called.has(agent.name) ? 'wake' : 'fyi'
      this.store.insertDelivery({ id: randomUUID(), messageId: message.id, messageSeq: message.seq, recipient: agent.name, agentId: agent.id, wake, state: newQueuedDelivery(now) })
      if (wake === 'wake') this.requestWake(agent.id, 'new_message')
      this.settleAgent(agent.id)
    }
    this.replicateGroup(chat.id, { message, called }, [])
    this.markUnreadChanged(chat.id)
    this.pendingEffects.push({ effect: 'push_message', messageId: message.id, skipPushTokenHashes: [] })
    return message
  }

  /** A member's post to a group whose home is another machine: kept here, and sent home, which gives it to everyone. */
  private postToGroupElsewhere(caller: Caller, chat: ChatEntity, from: string, text: string, clientKey: string): MessageRow {
    const home = this.store.peerByName(chat.homeMachine)
    if (!home) throw new CommandRefused('forbidden', `${chatHandle(chat)} lives on ${chat.homeMachine}, which was removed from this computer: it can be read, not posted to`)
    if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner and agents post to groups on other computers')
    const now = this.config.clock.now()
    const message = this.store.insertMessage({ id: randomUUID(), chatId: chat.id, from, at: now, text, attachments: [], purpose: 'message', clientKey, posesAskId: null, answersAskId: null, relayedBy: null })
    const body: PeerGroupPost = { chatId: chat.id, messageId: message.id, from: caller.kind === 'agent' ? { kind: 'agent', name: caller.agent.name } : { kind: 'owner' }, text, sentAt: now }
    this.store.enqueueForPeer({ peerMachineId: home.machineId, request: { route: '/group-posts', body }, messageId: message.id, recipient: `${chatHandle(chat)}@${home.name}`, now })
    this.markUnreadChanged(chat.id)
    return message
  }

  /** A group member that is an agent on another machine. */
  private remoteMemberOf(address: string): { address: string; agentName: string; machine: string } | null {
    const parsed = parseAddress(address)
    if (parsed.kind !== 'agent' || parsed.machine === null || parsed.machine === this.config.machineName) return null
    return { address, agentName: parsed.agentName, machine: parsed.machine }
  }

  private remoteMachinesOf(members: { address: string }[]): string[] {
    return [...new Set(members.flatMap((member) => this.remoteMemberOf(member.address)?.machine ?? []))]
  }

  /** Tells each machine with members in a group, and those in `alsoTo`, how the group is now, with the post if there is
   * one. Called only at the group's home. */
  private replicateGroup(chatId: string, post: { message: MessageRow; called: Set<string> } | null, alsoTo: string[]): void {
    const chat = this.store.chatEntity(chatId)!
    const now = this.config.clock.now()
    const group: PeerGroupState = { chatId, title: chat.title, createdBy: chat.createdBy, createdAt: chat.createdAt, members: chat.members.map((member) => ({ address: member.address, joinedAt: member.joinedAt })) }
    const senderPushTokenHashes = this.ownerPushTokenHashes()
    for (const machine of new Set([...this.remoteMachinesOf(chat.members), ...alsoTo])) {
      const peer = this.store.peerByName(machine)
      if (!peer) continue
      const recipients = post === null ? [] : chat.members.flatMap((member) => {
        const remote = member.address === post.message.from ? null : this.remoteMemberOf(member.address)
        if (remote?.machine !== machine) return []
        return [{ name: remote.agentName, wake: post.called.has(member.address) ? 'wake' as const : 'fyi' as const }]
      })
      const body: PeerGroupUpdate = {
        group,
        post: post && { messageId: post.message.id, from: post.message.from, text: post.message.text, sentAt: post.message.at },
        recipients,
        senderPushTokenHashes: post === null ? [] : senderPushTokenHashes,
      }
      this.store.enqueueForPeer({ peerMachineId: peer.machineId, request: { route: '/group-updates', body }, messageId: post?.message.id ?? null, recipient: machine, now })
    }
  }

  /** A group's home says how it is now: this machine keeps a copy, and gives any post to its members here. */
  private groupUpdateFromPeer(peer: PeerRow, update: PeerGroupUpdate): PeerMessageResult {
    const existing = this.store.chatEntity(update.group.chatId)
    if (existing && existing.homeMachine !== peer.name) return { outcome: 'undeliverable', reason: `that group's home here is ${existing.homeMachine}, not ${peer.name}` }
    const here = (address: string) => addressFromPeer(address, peer.name, this.config.machineName)
    const { group } = update
    this.store.saveGroupCopy({ id: group.chatId, title: group.title, createdBy: here(group.createdBy), createdAt: group.createdAt, homeMachine: peer.name, members: group.members.map((member) => ({ address: here(member.address), joinedAt: member.joinedAt })) })
    if (update.post === null) return { outcome: 'accepted' }
    const now = this.config.clock.now()
    const kept = this.store.messageById(update.post.messageId)
    const message = kept ?? this.store.insertMessage({ id: update.post.messageId, chatId: group.chatId, from: here(update.post.from), at: now, text: update.post.text, attachments: [], purpose: 'message', clientKey: null, posesAskId: null, answersAskId: null, relayedBy: null })
    const delivered = new Set(this.store.deliveriesOfMessage(message.id).map((delivery) => delivery.agentId))
    for (const recipient of update.recipients) {
      const agent = this.store.activeAgentByName(recipient.name)
      if (!agent || delivered.has(agent.id)) continue
      this.store.insertDelivery({ id: randomUUID(), messageId: message.id, messageSeq: message.seq, recipient: agent.name, agentId: agent.id, wake: recipient.wake, state: newQueuedDelivery(now) })
      if (recipient.wake === 'wake') this.requestWake(agent.id, 'new_message')
      this.settleAgent(agent.id)
    }
    this.markUnreadChanged(group.chatId)
    // The home pushes its own phones. This machine pushes the rest: about a post new here, and about one posted here, which
    // it doesn't push when posting, since only now does it know which phones the home pushed. Once: an update sent again
    // after a lost answer pushes nothing.
    if (this.store.noteGroupPostPushed(message.id)) this.pendingEffects.push({ effect: 'push_message', messageId: message.id, skipPushTokenHashes: update.senderPushTokenHashes })
    return { outcome: 'accepted' }
  }

  /** A member on another machine posts to a group whose home is here. Taken once, by its id. */
  private groupPostFromPeer(peer: PeerRow, post: PeerGroupPost): PeerMessageResult {
    const chat = this.store.chatEntity(post.chatId)
    if (!chat || chat.kind !== 'group' || chat.homeMachine !== this.config.machineName) return { outcome: 'undeliverable', reason: `no such group on ${this.config.machineName}` }
    if (this.store.messageById(post.messageId)) return { outcome: 'accepted' }
    const from = post.from.kind === 'owner' ? OWNER_ADDRESS : `${post.from.name}@${peer.name}`
    if (!chat.members.some((member) => member.address === from)) return { outcome: 'undeliverable', reason: `${from} is not a member of ${chatHandle(chat)}` }
    this.postToGroupAtHome(chat, { messageId: post.messageId, from, text: post.text, attachments: [], clientKey: null })
    return { outcome: 'accepted' }
  }

  private recipientAgent(name: string): AgentRow {
    const agent = this.store.activeAgentByName(name)
    if (agent) return agent
    if (this.store.newestArchivedAgentByName(name)) throw new CommandRefused('agent_archived', `${name} is archived`)
    throw new CommandRefused('not_found', `no agent named ${name}`)
  }

  /** The person's own words, carried by their master agent: from the person, marked as relayed, closing asks as theirs would. */
  private commandRelay(caller: Caller, input: { to: string; text: string; answersAskId: string | null }, clientKey: string): CommandOutput<'relay_message'> {
    if (caller.kind !== 'agent' || caller.agent.name !== MASTER_AGENT_NAME) throw new CommandRefused('forbidden', "only the master agent relays a person's words")
    const person = this.store.personByAddress(caller.agent.createdBy)
    if (!person) throw new CommandRefused('not_found', `no person at ${caller.agent.createdBy}`)
    const parsed = parseAddress(input.to)
    if (parsed.kind !== 'agent' || parsed.machine !== null) throw new CommandRefused('invalid_request', "a relay goes to an agent on this machine")
    if (input.answersAskId !== null && !this.store.openAskById(input.answersAskId)) throw new CommandRefused('ask_closed', 'that question is already closed')
    const toAgent = this.recipientAgent(parsed.agentName)
    const message = this.postDirect({
      from: person.address, fromAgentId: null, toAgent, text: input.text, attachments: [], purpose: 'message', wake: 'wake', clientKey, answersAskId: input.answersAskId, relayedBy: caller.agent.name,
    })
    this.requestWake(toAgent.id, 'new_message')
    this.settleAgent(toAgent.id)
    this.closeAsksAnsweredBy(toAgent.name, input.answersAskId)
    return { message: this.store.messageEntity(this.store.messageById(message.id)!) }
  }

  private commandSendMessage(caller: Caller, input: { to: string; text: string; attachmentIds: string[]; wake: DeliveryWake; answersAskId: string | null }, clientKey: string): CommandOutput<'send_message'> {
    const askOpen = input.answersAskId === null || this.store.openAskById(input.answersAskId) !== null || this.store.remoteAskById(input.answersAskId) !== null
    if (!askOpen) throw new CommandRefused('ask_closed', 'that question is already closed')
    const message = this.sendFrom(caller, input.to, input.text, this.resolveAttachments(input.attachmentIds), input.wake, input.answersAskId, clientKey)
    if (caller.kind === 'person') this.closeAsksAnsweredBy(input.to, input.answersAskId)
    return { message: this.store.messageEntity(this.store.messageById(message.id)!) }
  }

  private commandBroadcast(caller: Caller, input: { text: string; attachmentIds: string[]; wake: DeliveryWake }, clientKey: string): CommandOutput<'broadcast_message'> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', 'only an agent broadcasts')
    const attachments = this.resolveAttachments(input.attachmentIds)
    const running = this.store.listUnarchivedAgents().filter((agent) => agent.id !== caller.agent.id && liveGeneration(agent.lifecycle.state) !== null)
    const messages = running.map((agent) => this.sendFrom(caller, agent.name, input.text, attachments, input.wake, null, clientKey))
    return { messages: messages.map((message) => this.store.messageEntity(this.store.messageById(message.id)!)) }
  }

  /** A person's direct message closes all of that agent's asks, unless it answers just one. */
  private closeAsksAnsweredBy(to: string, answersAskId: string | null): void {
    const parsed = parseAddress(to)
    if (parsed.kind === 'agent' && parsed.machine !== null && parsed.machine !== this.config.machineName) {
      this.removeRemoteAsksAnsweredBy({ agentName: parsed.agentName, machine: parsed.machine }, answersAskId)
      return
    }
    const now = this.config.clock.now()
    if (answersAskId !== null) {
      this.closeAsk(answersAskId, now)
      return
    }
    const agent = this.store.activeAgentByName(to)
    if (!agent) return
    // A system problem's ask closes when its cause clears, not when someone talks.
    for (const ask of this.store.openAsksOfAgent(agent.id)) if (ask.source.kind === 'agent') this.closeAsk(ask.id, now)
  }

  /** As closeAsksAnsweredBy, for the copies here of asks of an agent on another computer. That computer closes the asks
   * themselves when the message arrives, and says so; the copies go now, so the person isn't asked again meanwhile. */
  private removeRemoteAsksAnsweredBy(to: { agentName: string; machine: string }, answersAskId: string | null): void {
    if (answersAskId !== null) {
      this.store.removeRemoteAsk(answersAskId)
      return
    }
    const peer = this.store.peerByName(to.machine)
    if (!peer) return
    for (const askId of this.store.remoteAskIdsOfAgent(peer.machineId, to.agentName)) this.store.removeRemoteAsk(askId)
  }

  private commandAsk(caller: Caller, input: { to: string; text: string; level: AskEntity['level']; choices: string[] }, clientKey: string): CommandOutput<'ask'> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', 'only an agent can ask')
    const person = this.store.personByAddress(input.to)
    if (!person) throw new CommandRefused('not_found', `no person at ${input.to}`)
    if (input.text.trim() === '') throw new CommandRefused('empty_message', 'an empty message says nothing')
    const now = this.config.clock.now()
    const urgentCapReached = input.level === 'urgent' && this.store.countAsksSince(caller.agent.id, 'urgent', now - URGENT_ASK_WINDOW_MS) >= URGENT_ASK_LIMIT
    const ask: AskEntity = {
      id: randomUUID(),
      agentId: caller.agent.id,
      agentName: caller.agent.name,
      to: input.to,
      level: urgentCapReached ? 'blocked' : input.level,
      text: input.text,
      choices: input.choices,
      source: { kind: 'agent' },
      at: now,
      snooze: null,
    }
    this.store.insertAsk(ask)
    this.pendingEffects.push({ effect: 'push_ask', askId: ask.id })
    this.postToPerson({ fromAgent: caller.agent, to: person, text: input.text, attachments: [], purpose: 'message', clientKey, posesAskId: ask.id })
    return { ask }
  }

  private commandWithdrawAsk(caller: Caller, input: { askId: string }): Record<string, never> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', 'only an agent can withdraw an ask')
    const ask = this.store.openAskById(input.askId)
    if (!ask) throw new CommandRefused('ask_closed', 'that question is already closed')
    if (ask.agentId !== caller.agent.id) throw new CommandRefused('forbidden', "that question isn't yours")
    this.closeAsk(ask.id, this.config.clock.now())
    return {}
  }

  // Goals

  /** A folder's project memory, with the person's notes copied in, as Claude Code reads it before any hook runs. Codex has
   * no memory of its own to point at one. Memory is never a reason not to start: without it, Claude Code's own applies. */
  private syncedProjectMemoryOf(folder: string): ProjectMemory | null {
    try {
      const project = this.memory.projectMemoryOf(folder)
      if (project) this.memory.syncPersonalNotes(project)
      return project
    } catch (error) {
      this.config.log('memory_unavailable', { folder, error: (error as Error).message })
      return null
    }
  }

  /** The owner and agents manage computers; an invited person doesn't. */
  private requireComputerManager<T>(caller: Caller, body: () => T): T {
    if (caller.kind === 'person' && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner manages computers')
    return body()
  }

  /** As requireComputerManager, for what goes to another computer before the command runs: refused before it goes. */
  private async requireComputerManagerAsync<T>(caller: Caller, body: () => Promise<T>): Promise<T> {
    return await this.requireComputerManager(caller, body)
  }

  private commandSyncMemory(caller: Caller): Record<string, never> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', "only an agent has a project's memory")
    const project = this.memory.projectMemoryOf(caller.agent.folder)
    if (project) this.memory.syncPersonalNotes(project)
    return {}
  }

  private goalNotesPath(agentId: string): string {
    return join(this.config.paths.agentDir(agentId), 'goal-notes.md')
  }

  private cycleFacts(agent: AgentRow): CycleFacts {
    return {
      agentState: agent.lifecycle.state,
      agentQuietSince: agent.lifecycle.state.since,
      hasQueuedDeliveries: this.store.countQueuedDeliveries(agent.id) > 0,
      planHold: this.accountOf(agent) === 'claude' ? goalPlanHold(this.planReadingKnown('claude'), this.config.clock.now()) : null,
    }
  }

  private goalEntity(goal: GoalRecord): GoalEntity {
    const agent = this.requireAgentRow(goal.agentId)
    let notes = ''
    try {
      notes = readFileSync(this.goalNotesPath(goal.agentId), 'utf8').slice(0, NOTES_PREVIEW_CHARS)
    } catch { /* no notes yet */ }
    return {
      id: goal.agentId,
      agentId: goal.agentId,
      text: goal.text,
      kind: goal.kind,
      status: goalStatusOf(goal, this.cycleFacts(agent)),
      cycleCount: goal.cycleCount,
      interval: goal.chosenIntervalSeconds === null ? { kind: 'default', seconds: DEFAULT_GOAL_INTERVAL_SECONDS } : { kind: 'chosen', seconds: goal.chosenIntervalSeconds },
      costUsd: goal.costUsd,
      setBy: goal.setBy,
      setAt: goal.setAt,
      notes,
    }
  }

  private startGoalCycleIfDue(agentId: string): void {
    const goal = this.store.goalOf(agentId)
    const agent = this.store.agentById(agentId)
    if (!goal || !agent || !agentCanTakeCycle(agent.lifecycle.state)) return
    const next = nextCycle(goal, this.cycleFacts(agent))
    if (next.at === null || this.config.clock.now() < next.at) return
    const started = startCycle(goal, 'pending')
    const message = this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text: cyclePrompt(started, this.goalNotesPath(agentId)), attachments: [], purpose: 'goal_cycle', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
    this.store.saveGoal({ ...started, runningCycleMessageId: message.id })
    this.requestWake(agentId, 'queued_work')
    this.settleAgent(agentId)
  }

  private endGoalCycleIfFinished(agentId: string): void {
    const goal = this.store.goalOf(agentId)
    if (!goal?.runningCycleMessageId) return
    const delivery = this.store.deliveriesOfMessage(goal.runningCycleMessageId)[0]
    if (!delivery || delivery.state.state !== 'completed') return
    this.store.saveGoal(endCycle(goal, { interrupted: delivery.state.outcome === 'turn_interrupted', attempts: this.store.countDeliveryAttempts(delivery.id) }, this.config.clock.now()))
  }

  private requireGoal(agentId: string): GoalRecord {
    this.requireAgentRow(agentId)
    const goal = this.store.goalOf(agentId)
    if (!goal) throw new CommandRefused('not_found', 'it has no goal')
    return goal
  }

  private applyGoalChange(goal: GoalRecord, change: (goal: GoalRecord) => GoalRecord): { goal: GoalEntity } {
    let changed: GoalRecord
    try {
      changed = change(goal)
    } catch (error) {
      if (error instanceof GoalRefusal) throw new CommandRefused('goal_refused', error.message)
      throw error
    }
    this.store.saveGoal(changed)
    return { goal: this.goalEntity(changed) }
  }

  private withGoal(input: { agentId: string }, change: (goal: GoalRecord) => GoalRecord): { goal: GoalEntity } {
    return this.applyGoalChange(this.requireGoal(input.agentId), change)
  }

  private commandSetGoal(caller: Caller, input: { agentId: string; text: string; kind: GoalEntity['kind']; intervalSeconds: number | null }): { goal: GoalEntity } {
    const agent = this.requireAgentRow(input.agentId)
    if (agent.lifecycle.state.state === 'archived') throw new CommandRefused('agent_archived', `${agent.name} is archived`)
    let goal: GoalRecord
    try {
      goal = newGoal({ agentId: input.agentId, text: input.text, kind: input.kind, intervalSeconds: input.intervalSeconds, setBy: addressOfCaller(caller), now: this.config.clock.now() })
    } catch (error) {
      if (error instanceof GoalRefusal) throw new CommandRefused('goal_refused', error.message)
      throw error
    }
    this.store.saveGoal(goal)
    return { goal: this.goalEntity(goal) }
  }

  private commandPauseGoal(caller: Caller, input: { agentId: string; reason: string | null }): { goal: GoalEntity } {
    const goal = this.requireGoal(input.agentId)
    const by = addressOfCaller(caller)
    const result = this.applyGoalChange(goal, (current) => pauseGoal(current, by, input.reason, this.config.clock.now()))
    // An agent parking its own goal tells whoever set it.
    if (caller.kind === 'agent' && caller.agent.id === input.agentId && goal.setBy !== by) {
      this.tell(goal.setBy, `${caller.agent.name} paused its goal${input.reason ? `: ${input.reason}` : ''}`)
    }
    return result
  }

  private completeGoalWithNotice(goal: GoalRecord, summary: string, check: GoalCheckOutcome): GoalRecord {
    let completed: GoalRecord
    try {
      completed = completeGoal(goal, summary, check, this.config.clock.now())
    } catch (error) {
      if (error instanceof GoalRefusal) throw new CommandRefused('goal_refused', error.message)
      throw error
    }
    this.store.saveGoal(completed)
    const agent = this.requireAgentRow(goal.agentId)
    if (goal.setBy !== agent.name) this.tell(goal.setBy, `${agent.name} completed its goal: ${summary}`)
    return completed
  }

  private commandMarkGoalDone(input: { agentId: string; summary: string | null }, prepared: PreparedChecks): { goal: GoalEntity } {
    const goal = this.requireGoal(input.agentId)
    return { goal: this.goalEntity(this.completeGoalWithNotice(goal, input.summary ?? 'marked done', prepared.goalCheck)) }
  }

  private commandClearGoal(input: { agentId: string }): Record<string, never> {
    this.requireGoal(input.agentId)
    this.store.deleteGoal(input.agentId)
    return {}
  }

  /** Something the system tells an agent (as an FYI, so nothing loops) or a person (in their system chat). */
  private tell(address: string, text: string): void {
    const parsed = parseAddress(address)
    if (parsed.kind === 'agent') {
      const agent = parsed.machine === null ? this.store.activeAgentByName(parsed.agentName) : null
      if (agent) this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text, attachments: [], purpose: 'system_notice', wake: 'fyi', clientKey: null, answersAskId: null, relayedBy: null })
      return
    }
    this.postNoticeToPerson(address, text)
  }

  private postNoticeToPerson(address: string, text: string): MessageRow | null {
    const person = this.store.personByAddress(address)
    if (!person) return null
    const now = this.config.clock.now()
    const chatId = this.ensureDirectChat({ key: 'person:system', address: SYSTEM_ADDRESS }, { key: `person:${person.address}`, address: person.address }, SYSTEM_ADDRESS)
    const message = this.store.insertMessage({ id: randomUUID(), chatId, from: SYSTEM_ADDRESS, at: now, text, attachments: [], purpose: 'system_notice', clientKey: null, posesAskId: null, answersAskId: null, relayedBy: null })
    this.markUnreadChanged(chatId)
    return message
  }

  // Asks

  /** A copy of an ask from another computer is snoozed at that computer first: `prepared` has what it answered. */
  private commandSnoozeAsk(caller: Caller, input: { askId: string; snooze: AskSnooze | null }, prepared: PreparedChecks): CommandOutput<'snooze_ask'> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person snoozes')
    const copy = this.store.remoteAskById(input.askId)
    if (copy) {
      if (prepared.remoteAskSnoozed.kind !== 'snoozed') throw new CommandRefused('invalid_request', 'snoozing a question from another computer needs that computer to answer first')
      this.store.setRemoteAskSnooze(copy.id, prepared.remoteAskSnoozed.snooze)
      return { remoteAsk: this.store.remoteAskById(copy.id)! }
    }
    const ask = this.store.openAskById(input.askId)
    if (!ask) throw new CommandRefused('ask_closed', 'that question is already closed')
    if (ask.to !== caller.person.address) throw new CommandRefused('forbidden', "that question isn't for you")
    this.setAskSnooze(ask, this.snoozeAsAsked(caller.person.id, input.snooze), { remindNow: false })
    return { ask: this.store.openAskById(ask.id)! }
  }

  /** The snooze to keep for one asked by this person: until quiet hours end is until their next end, by this computer's
   * settings for them, as the phone asking shows them. Refused when it can't be kept. */
  private snoozeAsAsked(personId: string, snooze: AskSnooze | null): AskSnooze | null {
    const now = this.config.clock.now()
    if (snooze?.kind === 'quiet_hours_end') {
      const { quietHours } = this.store.notificationSettingsOf(personId)
      if (quietHours === null) throw new CommandRefused('invalid_request', 'you have no quiet hours set')
      return { kind: 'until', at: quietHoursEndAfter(quietHours, now) }
    }
    if (snooze?.kind === 'until' && snooze.at > now + MAX_ASK_SNOOZE_MS) throw new CommandRefused('invalid_request', 'a snooze lasts a week at most')
    return snooze
  }

  /** Being back: a person's device reads the state. Snoozes until then end, here and, for copies of asks from other
   * computers, at their computers, which tell this one. */
  private notePersonBack(address: string): void {
    const asks = this.store.openAsksSnoozedFor('person_back', { to: address })
    if (asks.length > 0) {
      this.commit(() => {
        for (const ask of asks) this.setAskSnooze(ask, null, { remindNow: false })
      })
    }
    if (this.store.personByAddress(address)?.isOwner !== true) return
    for (const copy of this.store.listRemoteAskEntities()) {
      if (copy.snooze?.kind !== 'person_back' || this.personBackSent.has(copy.id)) continue
      this.personBackSent.add(copy.id)
      this.peers.snoozeRemoteAsk(copy.computerId, { askId: copy.id, snooze: null })
        .catch((error: unknown) => this.config.log('remote_ask_snooze_not_ended', { askId: copy.id, error: (error as Error).message }))
        .finally(() => this.personBackSent.delete(copy.id))
    }
  }

  private commandReply(caller: Caller, input: { text: string; attachmentIds: string[] }, clientKey: string): CommandOutput<'reply'> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', 'only an agent can reply')
    const answering = this.store.latestAnswerableMessage(caller.agent.id)
    if (!answering) throw new CommandRefused('not_found', 'there is no message to reply to')
    const answeringChat = this.store.chatEntity(answering.chatId)
    if (answeringChat?.kind === 'group') {
      const posted = this.postToGroup(caller, answeringChat, input.text, this.resolveAttachments(input.attachmentIds), clientKey)
      return { message: this.store.messageEntity(this.store.messageById(posted.id)!) }
    }
    const message = this.sendFrom(caller, answering.from, input.text, this.resolveAttachments(input.attachmentIds), 'wake', null, clientKey)
    return { message: this.store.messageEntity(this.store.messageById(message.id)!) }
  }

  private commandFinish(caller: Caller, input: { summary: string }, clientKey: string, prepared: PreparedChecks): CommandOutput<'finish_agent'> {
    if (caller.kind !== 'agent') throw new CommandRefused('forbidden', 'only an agent can finish itself')
    if (caller.agent.name === MASTER_AGENT_NAME) throw new CommandRefused('forbidden', 'the master agent never finishes: it stays the front door. End your turn instead.')
    const goal = this.store.goalOf(caller.agent.id)
    if (goal && goal.progress.status === 'active') this.completeGoalWithNotice(goal, input.summary, prepared.goalCheck)
    const decision = this.applyAgentEvent(caller.agent.id, { type: 'finish_requested', summary: input.summary })
    if (decision.outcome === 'refused') throw new CommandRefused('agent_state_conflict', `can't finish now: ${decision.why}`)
    // The done report answers everything the agent was asked.
    this.dropRepliesOwed(caller.agent.id)
    this.sendFrom(caller, this.reportTarget(caller.agent), input.summary, [], 'wake', null, clientKey, 'done_report')
    return { agent: this.agentEntityOf(this.requireAgentRow(caller.agent.id)), runningHelpers: this.runningHelpersOf(caller.agent.name) }
  }

  private withRepliesDropped<T>(input: { agentId: string }, output: T): T {
    this.dropRepliesOwed(input.agentId)
    return output
  }

  /** Nothing the agent has taken in so far is owed a reply any more. */
  private dropRepliesOwed(agentId: string): void {
    this.store.updateAgentFields(agentId, { repliesSettledThroughSeq: this.store.takenThroughSeq(agentId) })
  }

  /**
   * At the end of a turn with nothing more to do: one reminder if a message it took in is still owed a reply, unless the
   * owner turned reminders off. Whatever it took in up to here is settled either way, so the reminder is the only one.
   */
  private remindOfRepliesOwed(agent: AgentRow): void {
    const taken = this.store.takenMessagesAfter(agent.id, agent.name, agent.repliesSettledThroughSeq)
    if (taken.length === 0) return
    this.store.updateAgentFields(agent.id, { repliesSettledThroughSeq: Math.max(...taken.map((row) => row.message.seq)) })
    if (!this.replyRemindersOn()) return
    const reminder = replyReminder(taken.map((row) => {
      const chat = row.chatKind === 'group' ? this.store.chatEntity(row.message.chatId) : null
      return {
        from: row.message.from,
        fromKind: parseAddress(row.message.from).kind === 'agent' ? 'agent' : 'person',
        purpose: row.message.purpose,
        wake: row.wake,
        replyTo: chat ? chatHandle(chat) : row.message.from,
        answersOwnAsk: row.answersOwnAsk,
        followsOwnMessage: row.followsOwnMessage,
        answeredInChat: row.answeredInChat,
      }
    }))
    if (reminder === null) return
    this.postDirect({ from: SYSTEM_ADDRESS, fromAgentId: null, toAgent: agent, text: reminder, attachments: [], purpose: 'reply_reminder', wake: 'wake', clientKey: null, answersAskId: null, relayedBy: null })
    this.settleAgent(agent.id)
  }

  /** Helpers with a runner, which would carry on after their parent finished. */
  private runningHelpersOf(parentName: string): string[] {
    return this.store.listUnarchivedAgents().filter((agent) => agent.parent === parentName && liveGeneration(agent.lifecycle.state) !== null).map((agent) => agent.name)
  }

  /** The parent if it can receive this, otherwise the creator. */
  private reportTarget(agent: AgentRow): string {
    const parsed = parseAddress(agent.parent)
    if (parsed.kind === 'agent' && parsed.machine === null && !this.store.activeAgentByName(parsed.agentName)) return agent.createdBy
    return agent.parent
  }

  private commandAgentEvent(input: { agentId: string }, event: AgentEvent, refusalReason: string): { agent: AgentEntity } {
    const decision = this.applyAgentEvent(input.agentId, event)
    if (decision.outcome === 'refused') throw new CommandRefused('agent_state_conflict', `can't do that now: ${refusalReason}`)
    return { agent: this.agentEntityOf(this.requireAgentRow(input.agentId)) }
  }

  /** An agent asked to work in a project's main checkout works in its own worktree of it instead. */
  private placeInOwnWorktree(agent: AgentRow): void {
    let place: ReturnType<typeof placeAgent>
    try {
      place = placeAgent(agent.name, agent.id, agent.folder)
    } catch (error) {
      throw new CommandRefused('invalid_request', (error as Error).message)
    }
    if (place.worktree !== null) this.store.moveAgentFolder(agent.id, place.folder, place.worktree)
  }

  /** Outside a transaction: git may take a moment. A branch that didn't merge is reported to whoever the agent reports to. */
  private mergeBranchBack(agentId: string, afterwards: 'keep_worktree' | 'remove_worktree'): void {
    const agent = this.store.agentById(agentId)
    if (agent === null || agent.worktree === null) return
    const worktree = agent.worktree
    const merge = mergeAgentBranch(worktree)
    this.commit(() => {
      const report = unmergedBranchReport(agent.name, merge)
      if (report !== null) this.alert(this.reportTarget(agent), report)
      else if (afterwards === 'remove_worktree') this.removeWorktreeOf({ ...agent, worktree })
    })
  }

  /** After a clean merge on archive. Unarchived, the agent carries on in the main checkout. */
  private removeWorktreeOf(agent: AgentRow & { worktree: AgentWorktree }): void {
    const removal = removeAgentWorktree(agent.worktree)
    if (removal.kind === 'kept') {
      this.alert(this.reportTarget(agent), `${agent.name}'s branch ${agent.worktree.branch} merged, but its worktree was kept: ${removal.why}. Commit or discard them, then ouro merge ${agent.name}.`)
      return
    }
    this.store.moveAgentFolder(agent.id, join(agent.worktree.repo, relative(agent.worktree.dir, agent.folder)), null)
  }

  private commandMergeBranch(input: { agentId: string }): CommandOutput<'merge_agent_branch'> {
    const agent = this.requireAgentRow(input.agentId)
    if (agent.worktree === null) throw new CommandRefused('invalid_request', `${agent.name} works in ${agent.folder} directly, with no branch of its own`)
    if (liveGeneration(agent.lifecycle.state) !== null) throw new CommandRefused('agent_state_conflict', `${agent.name} is running: stop it first, or let it finish`)
    const merge = mergeAgentBranch(agent.worktree)
    if (merge.kind !== 'not_merged' && agent.lifecycle.state.state === 'archived') this.removeWorktreeOf({ ...agent, worktree: agent.worktree })
    return { merge }
  }

  private commandUnarchive(input: { agentId: string }): { agent: AgentEntity } {
    const row = this.requireAgentRow(input.agentId)
    if (this.store.activeAgentByName(row.name)) throw new CommandRefused('agent_name_taken', `the name "${row.name}" is in use now`)
    return this.commandAgentEvent(input, { type: 'unarchive_requested' }, 'it is not archived')
  }

  private commandSetModel(input: { agentId: string; model: string }): { agent: AgentEntity } {
    const row = this.requireAgentRow(input.agentId)
    // A conversation lives in the program that held it: one in Claude Code can't be resumed in Codex. The next start in
    // the other one begins a new conversation, seeded from what's stored.
    const sameRuntime = runtimeOf(catalogModel(row.model).provider) === runtimeOf(catalogModel(input.model).provider)
    this.store.updateAgentFields(input.agentId, sameRuntime ? { model: input.model } : { model: input.model, providerSessionId: null })
    return { agent: this.agentEntityOf(this.requireAgentRow(input.agentId)) }
  }

  private commandRegisterPushToken(caller: Caller, input: PushTokenRegistration): { apnsConfigured: boolean } {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a phone registers for pushes')
    this.store.setDevicePushToken(caller.deviceId, input)
    return { apnsConfigured: this.config.sendPush !== null }
  }

  private commandClearPushToken(caller: Caller): Record<string, never> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a phone registers for pushes')
    this.store.setDevicePushToken(caller.deviceId, null)
    return {}
  }

  private commandSetNotificationSettings(caller: Caller, input: NotificationSettings): CommandOutput<'set_notification_settings'> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person has notification settings')
    this.store.saveNotificationSettings(caller.person.id, input)
    return { settings: { id: caller.person.id, ...input } }
  }

  private commandWatchAgent(caller: Caller, input: { agentId: string }): Record<string, never> {
    this.requireAgentRow(input.agentId)
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person watches an agent')
    this.summaries.watch(input.agentId, caller.deviceId, WATCH_LEASE_MS)
    this.pendingEffects.push({ effect: 'consider_live_line', agentId: input.agentId })
    return {}
  }

  private commandMarkRead(caller: Caller, input: { chatId: string; readThroughSeq: number }): CommandOutput<'mark_chat_read'> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person has read marks')
    if (!this.store.chatExists(input.chatId)) throw new CommandRefused('not_found', 'no such chat')
    this.store.setReadThroughSeq(caller.person.id, input.chatId, input.readThroughSeq)
    return { readState: this.store.readStateEntity(caller.person.id, input.chatId, caller.person.address) }
  }

  private commandStartPairing(caller: Caller, input: { inviteePersonName: string | null }): CommandOutput<'start_pairing'> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person can start pairing')
    if (input.inviteePersonName !== null && !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner can invite people')
    return this.startPairing(input.inviteePersonName)
  }

  private commandRevokeDevice(caller: Caller, input: { deviceId: string }): CommandOutput<'revoke_device'> {
    if (caller.kind !== 'person') throw new CommandRefused('forbidden', 'only a person can revoke a device')
    const device = this.store.deviceById(input.deviceId)
    if (!device) throw new CommandRefused('not_found', 'no such device')
    if (!caller.person.isOwner && device.personId !== caller.person.id) throw new CommandRefused('forbidden', "only the owner can revoke someone else's device")
    this.store.revokeDevice(input.deviceId, this.config.clock.now())
    this.pendingDisconnects.push(input.deviceId)
    queueMicrotask(() => this.flushDeviceDisconnects())
    return { device: this.store.deviceEntity(device) }
  }

  /** Their devices stop connecting at once and their open questions close; their chats and messages stay. */
  private commandRemovePerson(caller: Caller, input: { personId: string }): Record<string, never> {
    if (caller.kind !== 'person' || !caller.person.isOwner) throw new CommandRefused('forbidden', 'only the owner can remove people')
    const person = this.store.personById(input.personId)
    if (!person) throw new CommandRefused('not_found', 'no such person')
    if (person.isOwner) throw new CommandRefused('forbidden', "the owner can't be removed")
    const now = this.config.clock.now()
    for (const deviceId of this.store.activeDeviceIdsOf(person.id)) {
      this.store.revokeDevice(deviceId, now)
      this.pendingDisconnects.push(deviceId)
    }
    for (const askId of this.store.openAskIdsTo(person.address)) this.closeAsk(askId, now)
    this.store.removePerson(person.id, now)
    queueMicrotask(() => this.flushDeviceDisconnects())
    return {}
  }

  private readonly pendingDisconnects: string[] = []

  private flushDeviceDisconnects(): void {
    for (const deviceId of this.pendingDisconnects.splice(0)) {
      for (const listener of this.deviceDisconnectListeners) listener(deviceId)
    }
  }

  // Attachments

  attachmentPath(id: string): string {
    return join(this.config.paths.attachments, id)
  }

  /**
   * The attachment under the name it was sent with, for a model to read: tools tell an image from text by its extension.
   * A hard link to the stored bytes, made when first needed.
   */
  private namedAttachmentPath(attachment: AttachmentRef): string {
    const folder = join(this.config.paths.attachments, 'named', attachment.id)
    const path = join(folder, safeFileName(attachment.fileName))
    if (!existsSync(path)) {
      mkdirSync(folder, { recursive: true })
      linkSync(this.attachmentPath(attachment.id), path)
    }
    return path
  }

  /** Content-addressed, so the same bytes are stored once and a name from outside can't pick a path. */
  saveAttachment(bytes: Buffer, fileName: string, mimeType: string): AttachmentRef {
    const id = createHash('sha256').update(bytes).digest('hex')
    if (!existsSync(this.attachmentPath(id))) writeFileSync(this.attachmentPath(id), bytes)
    const attachment: AttachmentRef = { id, fileName, mimeType, byteLength: bytes.length }
    this.store.insertAttachment(attachment, this.config.clock.now())
    return attachment
  }
}

/** Who is in a direct chat. `remote`: an agent on another machine, by its address here. */
type ParticipantKey = `agent:${string}` | `person:${string}` | `remote:${string}`

interface DirectPost { from: string; fromAgentId: string | null; toAgent: AgentRow; text: string; attachments: AttachmentRef[]; purpose: MessagePurpose; wake: DeliveryWake; clientKey: string | null; answersAskId: string | null; relayedBy: string | null }

interface NewAgentRequest { task: string; name: string | null; model: string | null; folder: string | null; promptCacheLifetime: PromptCacheLifetime; attachmentIds: string[] }

/** Who starts a new agent, and where it works. `parentAgentId`: the parent's id when it is an agent of this machine. */
interface NewAgentOrigin { parent: string; createdBy: string; parentAgentId: string | null; folder: string }

/** What a command needed from outside the transaction it runs in, found out before it. */
/** A sender's file name as one safe path segment. */
function safeFileName(fileName: string): string {
  const safe = fileName.replace(/[/\\\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120)
  return safe === '' ? 'file' : safe
}

export interface PreparedChecks {
  goalCheck: GoalCheckOutcome
  /** join_computer: the machine that took this one in, as it answered. */
  joinedHost: PeerIdentity | null
  /** control_remote_agent and create_remote_agent: the agent as its computer answered, after the action or made. */
  remoteAgentAnswer: { computerId: string; card: PeerAgentCard } | null
  /** move_agent: the other computer said it would take the agent. */
  moveTargetReady: boolean
  /** A plan's windows, read from its provider for `refresh_plan_usage`. */
  planUsageRead: { kind: 'not_needed' } | { kind: 'read'; account: PlanAccount; windows: PlanWindowReading[] } | { kind: 'openrouter_read' }
  /** snooze_ask on a copy of an ask from another computer: the snooze that computer has now. */
  remoteAskSnoozed: { kind: 'not_needed' } | { kind: 'snoozed'; snooze: AskSnooze | null }
  /** create_agent with no name: the name the model suggested from the task, if any, and what asking cost. */
  agentName: { kind: 'not_needed' } | { kind: 'suggested'; suggestion: NameSuggestion }
}

const NOTHING_PREPARED: PreparedChecks = {
  goalCheck: { kind: 'not_needed' },
  joinedHost: null,
  remoteAgentAnswer: null,
  moveTargetReady: false,
  planUsageRead: { kind: 'not_needed' },
  agentName: { kind: 'not_needed' },
  remoteAskSnoozed: { kind: 'not_needed' },
}


const REMOTE_ACTION_COMMANDS = {
  stop: 'stop_agent',
  interrupt: 'interrupt_agent',
  archive: 'archive_agent',
  set_model: 'set_agent_model',
} as const satisfies Record<RemoteAgentAction['kind'], CommandName>

const callerKeyOf = (caller: Caller): string => (caller.kind === 'person' ? `person:${caller.person.id}` : `agent:${caller.agent.id}`)

function runCheck(command: string, folder: string): Promise<GoalCheckOutcome> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd: folder, timeout: GOAL_CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(error === null ? { kind: 'passed' } : { kind: 'failed', output: `${stdout}${stderr}`.slice(-4000) || error.message })
    })
  })
}

function addressOfCaller(caller: Caller): string {
  return caller.kind === 'person' ? caller.person.address : caller.agent.name
}

function logRecordOf(record: JournalRecord): LogRecord[] {
  switch (record.kind) {
    case 'incoming': return [{ kind: 'incoming', at: record.at, from: record.from, text: record.text }]
    case 'text': return [{ kind: 'text', at: record.at, text: record.text }]
    case 'tool_use': return [{ kind: 'tool_use', at: record.at, toolName: record.toolName, input: record.input }]
    case 'tool_result': return [{ kind: 'tool_result', at: record.at, text: record.text, isError: record.isError }]
    case 'notice': return [{ kind: 'notice', at: record.at, text: record.text }]
    case 'turn_failed': return [{ kind: 'notice', at: record.at, text: `turn failed: ${record.failure}: ${record.detail}` }]
    case 'runner_exiting': return [{ kind: 'notice', at: record.at, text: `runner exited: ${record.reason}` }]
    case 'session_unresumable': return [{ kind: 'notice', at: record.at, text: `the conversation could not be resumed, so the next start begins a new one: ${record.detail}` }]
    case 'runner_started':
    case 'runner_ready':
    case 'session_identified':
    case 'taken_in':
    case 'thinking':
    case 'turn_result':
    case 'compaction_finished':
    case 'plan_usage_observed':
      return []
  }
}

/** How a turn failure taken for a passing one is written as its agent's transition cause (`decideTurnFailed`). */
const PASSING_FAILURE_CAUSE = 'turn failed: transient: '
