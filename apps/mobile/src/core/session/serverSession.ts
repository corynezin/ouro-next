// All state, requests and streams for one server. Disposing cancels everything it owns, and it has no reference to any
// other server, so a late answer has nowhere to land. Its outbox is the one thing that outlives it.
import type { CommandInput, CommandName, CommandOutput } from '@ouro/contract'
import type { AppLifecycle, Clock, IdSource, Network } from '../platform/ports.ts'
import { EntityStore } from './entityStore.ts'
import type { ServerDrafts } from './drafts.ts'
import type { NewSend, ServerOutbox } from './outbox.ts'
import { failureText, ServerApi } from './serverApi.ts'
import type { ApiResult, ServerEndpoint } from './serverApi.ts'
import { SyncEngine } from './syncEngine.ts'

const HISTORY_PAGE_SIZE = 50
/** How often the list asks for the ChatGPT plan's usage while it is on screen, as the reference (AG-10). */
export const PLAN_USAGE_REFRESH_MS = 120_000
/** An agent's chat on screen says so this often, well inside the server's lease, so its live line keeps coming. */
export const WATCH_BEAT_MS = 25_000

export interface SessionDeps {
  network: Network
  clock: Clock
  lifecycle: AppLifecycle
  ids: IdSource
}

export class ServerSession {
  readonly serverId: string
  readonly store = new EntityStore()
  readonly outbox: ServerOutbox
  readonly drafts: ServerDrafts
  readonly api: ServerApi
  private readonly sync: SyncEngine
  private readonly lifetime = new AbortController()
  private readonly cleanups: (() => void)[] = []
  private readonly statusListeners = new Set<() => void>()
  /** Chats on screen, counted because the same chat can be in the stack twice. */
  private readonly openChatCounts = new Map<string, number>()
  private readonly loadingHistory = new Map<string, Promise<ApiResult<void>>>()
  private disposed = false

  private readonly refreshesInProgress: (() => void)[] = []
  private readonly clock: Clock

  constructor(deps: SessionDeps, serverId: string, endpoint: ServerEndpoint, parts: { outbox: ServerOutbox; drafts: ServerDrafts }) {
    this.serverId = serverId
    this.clock = deps.clock
    this.outbox = parts.outbox
    this.drafts = parts.drafts
    this.api = new ServerApi(deps, endpoint, this.lifetime.signal)
    this.sync = new SyncEngine({
      api: this.api,
      store: this.store,
      clock: deps.clock,
      lifecycle: deps.lifecycle,
      onStatusChange: () => {
        if (this.sync.status.phase !== 'connecting') this.finishRefreshes()
        this.notifyStatus()
      },
      onCaughtUp: () => this.refreshOpenChats(),
    })
  }

  start() {
    this.cleanups.push(this.outbox.onAccepted((message) => this.store.putMessageIfAbsent(message)))
    this.cleanups.push(this.store.subscribe(() => this.markOpenChatsRead()))
    this.sync.start()
  }

  /** While the agents list is on screen: the ChatGPT plan's usage and OpenRouter's spend are read now and every 2
   * minutes, each only while it is signed in or has a key. Answers arrive through sync like any change; a refusal (OpenRouter
   * not answering) keeps the last reading. The returned function stops it. */
  followPlanUsage(): () => void {
    let stopped = false
    let cancelTimer = () => {}
    const tick = async () => {
      const reads: Promise<unknown>[] = []
      if (this.store.integration('chatgpt')?.state.status === 'signed_in') reads.push(this.command('refresh_plan_usage', { provider: 'chatgpt' }))
      if (this.store.integration('openrouter')?.state.status === 'configured') reads.push(this.command('refresh_plan_usage', { provider: 'openrouter' }))
      await Promise.all(reads)
      if (!stopped && !this.disposed) cancelTimer = this.clock.setTimer(PLAN_USAGE_REFRESH_MS, () => { void tick() })
    }
    void tick()
    return () => { stopped = true; cancelTimer() }
  }

  /**
   * The person is looking at this agent's chat: the server keeps its live line fresh while told so. Said now and every 25 s
   * until the returned stop; then the server's lease runs out by itself, so leaving needs no word.
   */
  watchAgent(agentId: string): () => void {
    let stopped = false
    let cancelTimer = () => {}
    const beat = async () => {
      await this.command('watch_agent', { agentId })
      if (!stopped && !this.disposed) cancelTimer = this.clock.setTimer(WATCH_BEAT_MS, () => { void beat() })
    }
    void beat()
    return () => { stopped = true; cancelTimer() }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.sync.stop()
    this.lifetime.abort()
    for (const cleanup of this.cleanups) cleanup()
    this.finishRefreshes()
  }

  /** Pull to refresh. Settles once the new snapshot is followed to live, or the attempt has failed; the status says which. */
  refresh() {
    return new Promise<void>((resolve) => {
      if (this.disposed) return resolve()
      this.refreshesInProgress.push(resolve)
      this.sync.takeNewSnapshot()
    })
  }

  private finishRefreshes() {
    for (const finish of this.refreshesInProgress.splice(0)) finish()
  }

  get isDisposed() { return this.disposed }
  get connection() { return this.sync.status }

  subscribeToConnection(listener: () => void) {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }
  private notifyStatus() { for (const listener of this.statusListeners) listener() }

  /** Runs a command with a new idempotency key. `attempts` covers proxy errors while the machine wakes, as for Stop. */
  async command<N extends CommandName>(name: N, input: CommandInput<N>, attempts = 1): Promise<ApiResult<CommandOutput<N>>> {
    return this.api.commandRetryingWhileUnreachable(name, input, attempts)
  }

  /** Words for a command's failure, or null if it worked. Most actions only need this. */
  async commandError<N extends CommandName>(name: N, input: CommandInput<N>, attempts = 1): Promise<string | null> {
    const result = await this.command(name, input, attempts)
    return result.ok ? null : failureText(result.failure)
  }

  send(newSend: NewSend) { return this.outbox.send(newSend) }

  // ---- chats on screen ----

  /** A chat is on screen. Its history loads, its replies count as read. Returns what to call when it leaves. */
  openChat(chatId: string): () => void {
    this.openChatCounts.set(chatId, (this.openChatCounts.get(chatId) ?? 0) + 1)
    if (!this.store.timeline(chatId)) void this.loadLatest(chatId)
    this.markRead(chatId)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const remaining = (this.openChatCounts.get(chatId) ?? 1) - 1
      if (remaining > 0) this.openChatCounts.set(chatId, remaining)
      else this.openChatCounts.delete(chatId)
    }
  }

  isChatOpen(chatId: string) { return this.openChatCounts.has(chatId) }

  private refreshOpenChats() {
    for (const chatId of this.openChatCounts.keys()) void this.loadLatest(chatId)
  }

  loadLatest(chatId: string) {
    return this.loadPage(chatId, 'latest', HISTORY_PAGE_SIZE)
  }

  /** One older page. Nothing happens if a page is already coming or there's nothing older. */
  loadOlder(chatId: string, limit = HISTORY_PAGE_SIZE) {
    const timeline = this.store.timeline(chatId)
    if (timeline && !timeline.hasOlder) return Promise.resolve<ApiResult<void>>({ ok: true, value: undefined })
    return this.loadPage(chatId, timeline ? 'older' : 'latest', limit)
  }

  private loadPage(chatId: string, kind: 'latest' | 'older', limit: number) {
    const running = this.loadingHistory.get(chatId)
    if (running) return running
    const load = this.fetchPage(chatId, kind, limit).finally(() => this.loadingHistory.delete(chatId))
    this.loadingHistory.set(chatId, load)
    return load
  }

  private async fetchPage(chatId: string, kind: 'latest' | 'older', limit: number): Promise<ApiResult<void>> {
    const oldest = this.store.timeline(chatId)?.messages[0]
    const page = await this.api.history(chatId, { beforeSeq: kind === 'older' ? oldest?.seq ?? null : null, limit })
    if (!page.ok) return page
    this.store.applyHistoryPage(chatId, page.value, kind)
    this.markRead(chatId)
    return { ok: true, value: undefined }
  }

  // ---- read marks ----

  private markOpenChatsRead() {
    for (const chatId of this.openChatCounts.keys()) this.markRead(chatId)
  }

  private readonly readMarkInFlight = new Map<string, number>()

  /** Marks through the newest known message, if that's further than the server has and nothing is on its way. */
  private markRead(chatId: string) {
    if (!this.openChatCounts.has(chatId)) return
    const newestSeq = this.newestSeqOf(chatId)
    if (newestSeq === 0) return
    const readThrough = this.store.readStateOfChat(chatId)?.readThroughSeq ?? 0
    const inFlight = this.readMarkInFlight.get(chatId) ?? 0
    if (newestSeq <= readThrough || newestSeq <= inFlight) return
    this.readMarkInFlight.set(chatId, newestSeq)
    void this.command('mark_chat_read', { chatId, readThroughSeq: newestSeq }).finally(() => {
      if (this.readMarkInFlight.get(chatId) === newestSeq) this.readMarkInFlight.delete(chatId)
    })
  }

  private newestSeqOf(chatId: string) {
    const timelineSeq = this.store.timeline(chatId)?.messages.at(-1)?.seq ?? 0
    const previewSeq = this.store.chats.get(chatId)?.latestMessage?.seq ?? 0
    return Math.max(timelineSeq, previewSeq)
  }

  // ---- addresses ----

  /** The direct chat between the viewer and `address`. Null until the server has one. */
  directChatWith(address: string) {
    const viewer = this.store.viewer?.address
    for (const chat of this.store.chats.values()) {
      if (chat.kind !== 'direct') continue
      const members = chat.members.map((m) => m.address)
      if (members.includes(address) && viewer !== undefined && members.includes(viewer)) return chat
    }
    return null
  }
}
