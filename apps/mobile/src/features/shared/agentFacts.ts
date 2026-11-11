// What every screen says about an agent. Pure: store -> display. The rules here are the brief's and the reference app's;
// keeping them in one file is what stops two screens from disagreeing.
import { displayStateOf, parseAddress } from '@ouro/contract'
import type { HoldReason } from '@ouro/contract'
import type { AgentEntity, AskEntity, AskSnooze, ChatEntity, GoalEntity, ModelOption, PersonEntity, PinEntity, PinTarget, ReadStateEntity, RemoteAskEntity, ServerEntity, SummaryEntity, Viewer } from '@ouro/contract'
import { tokensText, untilText } from '../../design/format.ts'
import type { IdleFold } from '../../core/accounts/preferences.ts'
import type { ConnectionStatus } from '../../core/session/syncEngine.ts'

/** The part of a session's store these rules read. */
export interface StoreView {
  readonly viewer: Viewer | null
  readonly agents: ReadonlyMap<string, AgentEntity>
  readonly chats: ReadonlyMap<string, ChatEntity>
  readonly asks: ReadonlyMap<string, AskEntity>
  readonly goals: ReadonlyMap<string, GoalEntity>
  readonly summaries: ReadonlyMap<string, SummaryEntity>
  readonly people: ReadonlyMap<string, PersonEntity>
  readonly server: { machineName: string; models: readonly ModelOption[]; limits: { idleFoldMinutes: number | null }; planUsage: ServerEntity['planUsage'] } | null
  readStateOfChat(chatId: string): ReadStateEntity | undefined
}

/** The viewer's pins, which the lists put first. */
export interface PinView { readonly pins: ReadonlyMap<string, PinEntity> }

/** In the order the person put them. */
export const sortedPins = (store: PinView): PinEntity[] => [...store.pins.values()].sort((x, y) => x.position - y.position || x.pinnedAt - y.pinnedAt)

const sameTarget = (x: PinTarget, y: PinTarget) =>
  x.kind === y.kind && (x.kind === 'agent' ? x.agentId === (y as typeof x).agentId : x.kind === 'chat' ? x.chatId === (y as typeof x).chatId : x.address === (y as typeof x).address)

export const pinOf = (store: PinView, target: PinTarget): PinEntity | undefined => [...store.pins.values()].find((pin) => sameTarget(pin.target, target))
export const isArchived = (agent: AgentEntity) => agent.state.state === 'archived'
export const listedAgents = (store: StoreView) => [...store.agents.values()].filter((agent) => !isArchived(agent))

/** The name or id in a route, which a link or a notification may give either way. Live agents win over archived namesakes. */
export function agentByRef(store: StoreView, ref: string): AgentEntity | undefined {
  const byId = store.agents.get(ref)
  if (byId) return byId
  const named = [...store.agents.values()].filter((agent) => agent.name === ref)
  return named.find((agent) => !isArchived(agent)) ?? named[0]
}

// ---- state ----

const reachable = { reachable: true }

export type AgentState = 'running' | 'done' | 'stopped'
export function stateOf(agent: Pick<AgentEntity, 'state'>): AgentState {
  const shown = displayStateOf(agent.state, reachable)
  return shown.display === 'running' ? 'running' : shown.display === 'done' ? 'done' : 'stopped'
}

/** What it's doing right now, in words, with when it started. Null when idle or not running. */
export function activityOf(agent: Pick<AgentEntity, 'state'>): { label: string; since: number } | null {
  const { state } = agent
  switch (state.state) {
    case 'starting': return { label: 'starting', since: state.since }
    case 'interrupting': return { label: 'interrupting', since: state.since }
    case 'compacting': return { label: 'compacting', since: state.since }
    case 'stopping': return { label: 'stopping', since: state.since }
    case 'in_turn':
      switch (state.activity.kind) {
        case 'waiting': return { label: 'working', since: state.since }
        case 'thinking': return { label: 'thinking', since: state.since }
        case 'tool': return { label: `running ${state.activity.toolName}`, since: state.since }
      }
    // falls through only if the union grows; the switch above is exhaustive under the type checker
    case 'moving': return { label: `moving to ${state.toMachine}`, since: state.since }
    default: return null
  }
}

export const isBusy = (agent: AgentEntity) => activityOf(agent) !== null

/** The filled dot means busy, mint running idle, a check done, a ring stopped. */
/** A summary covers through `coversThroughAt`: it is before the agent's latest turn when the agent is idle and has acted since. */
export function isBeforeLatestTurn(agent: AgentEntity, coversThroughAt: number): boolean {
  return !isBusy(agent) && agent.lastActivityAt > coversThroughAt + 1000
}

export type StateDotKind = 'busy' | 'running' | 'done' | 'stopped'
export function stateDotOf(agent: AgentEntity): StateDotKind {
  const state = stateOf(agent)
  if (state === 'running') return isBusy(agent) ? 'busy' : 'running'
  return state
}

// ---- the status line ----

/** A compacted context isn't cached until the next turn writes it. Whole minutes, so the line changes once a minute. */
function cacheText(cache: NonNullable<AgentEntity['cache']>, now: number) {
  if (!cache.compacted && cache.expiresAt > now) return `cache warm · ${Math.ceil((cache.expiresAt - now) / 60_000)}m left`
  if (cache.compacted) return `compacted · ${tokensText(cache.tokens)} to write`
  return `cache cold · ${tokensText(cache.tokens)} to rewrite`
}

/** "between goal cycles · next in 25 s", for an active goal with a cycle scheduled. */
export function nextCycleLine(goal: GoalEntity, now: number): string | null {
  const { status } = goal
  if (status.status !== 'active' || status.waitingFor !== null || status.nextCycleAt === null) return null
  const seconds = Math.max(0, Math.ceil(status.nextCycleAt / 1000 - now / 1000))
  return `between goal cycles · next ${seconds === 0 ? 'any moment' : seconds >= 120 ? `in ${Math.round(seconds / 60)} min` : `in ${seconds} s`}`
}

const HOLD_TEXT: Record<HoldReason, string> = {
  budget: 'over its budget',
  logged_out: 'Claude Code is signed out',
  credits: 'out of credits',
  usage_limit: 'usage limit reached',
  no_slot: 'waiting for a free slot',
}

const secondsUntil = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000))

/** Why a stop wasn't the ordinary kind: a crash or a hold. Null for idle, deliberate and unarchived stops. */
export function stopCauseText(agent: AgentEntity, now: number): string | null {
  const { state } = agent
  if (state.state === 'held') return HOLD_TEXT[state.hold]
  if (state.state !== 'stopped' || state.stopped.reason !== 'crash') return null
  const { consecutiveCrashes, relaunch } = state.stopped
  const crashed = consecutiveCrashes > 1 ? `crashed ${consecutiveCrashes}×` : 'crashed'
  switch (relaunch.kind) {
    case 'at': return `${crashed}, retrying in ${secondsUntil(relaunch.at, now)} s`
    case 'on_message': return `${crashed}, a message restarts it`
    case 'gave_up': return `${crashed}, gave up: ${relaunch.why}`
  }
}

/** A refused last turn, until a later turn finishes. A gave-up failure is said by the crash cause instead. */
function lastTurnFailureText(agent: AgentEntity): string | null {
  const failure = agent.lastTurnFailure?.failure
  return failure?.kind === 'model_refused' ? 'the model refused its last message' : null
}

export function statusLine(agent: AgentEntity, goal: GoalEntity | undefined, viewerAddress: string | undefined, now: number): string {
  const activity = activityOf(agent)
  if (activity) return activity.label
  if (agent.interruptedBy !== null) return agent.interruptedBy === viewerAddress ? 'interrupted by you' : `interrupted by ${agent.interruptedBy}`
  const state = stateOf(agent)
  if (state === 'done') return 'done'
  if (state === 'stopped') {
    const why = stopCauseText(agent, now) ?? lastTurnFailureText(agent)
    if (why) return `stopped · ${why}`
    return agent.cache ? `stopped · ${cacheText(agent.cache, now)}` : 'stopped'
  }
  const refused = lastTurnFailureText(agent)
  if (refused) return `idle · ${refused}`
  const between = goal ? nextCycleLine(goal, now) : null
  if (between) return between
  return agent.cache ? `idle · ${cacheText(agent.cache, now)}` : 'idle'
}

// ---- conversations ----

/** The direct chat between the viewer and this agent. A helper's may not exist until the first message between them. */
export const directChatOf = (store: StoreView, agent: AgentEntity) => directChatWith(store, agent.name)

/** The direct chat between the viewer and this address: a local agent's name, or `name@machine` for one elsewhere. */
export function directChatWith(store: StoreView, address: string): ChatEntity | undefined {
  const viewer = store.viewer?.address
  for (const chat of store.chats.values()) {
    if (chat.kind !== 'direct') continue
    const members = chat.members.map((m) => m.address)
    if (members.includes(address) && viewer !== undefined && members.includes(viewer)) return chat
  }
  return undefined
}

export function unreadOf(store: StoreView, agent: AgentEntity) {
  const chat = directChatOf(store, agent)
  return chat ? store.readStateOfChat(chat.id)?.unreadCount ?? 0 : 0
}

/** The app icon's badge: unread in chats with listed agents. */
export const agentUnreadTotal = (store: StoreView) => listedAgents(store).reduce((sum, agent) => sum + unreadOf(store, agent), 0)

/** The bubble's last word and who said it. */
export function lastMessagePreview(store: StoreView, agent: AgentEntity): { text: string; mine: boolean } | null {
  const latest = directChatOf(store, agent)?.latestMessage
  return latest ? { text: latest.text, mine: latest.from !== agent.name } : null
}

export const activityTime = (agent: AgentEntity, now: number) => (isBusy(agent) ? now : agent.lastActivityAt)

// ---- asks ----

/** What showing and ordering an ask needs: a local ask, or a remote ask's copy as `openCopyOf` gives it. */
export type ShownAsk = Pick<AskEntity, 'id' | 'level' | 'text' | 'choices' | 'at' | 'snooze'>

/** Who put an ask to the person: an agent here, or one on another computer, whose chat is a different screen. */
export type Asker = { kind: 'local'; agentId: string } | { kind: 'remote'; remoteAgentId: string }

/** A remote ask's copy can't be snoozed here: snoozes stay with the ask's own computer. */
export const openCopyOf = (ask: RemoteAskEntity): ShownAsk => ({ id: ask.id, level: ask.level, text: ask.text, choices: ask.choices, at: ask.at, snooze: ask.snooze })

export const isSnoozed = (ask: Pick<AskEntity, 'snooze'>, now: number) => {
  const { snooze } = ask
  if (snooze === null) return false
  return snooze.kind === 'until' ? snooze.at > now : true
}

export const askRank = (level: AskEntity['level']) => (level === 'urgent' ? 2 : level === 'blocked' ? 1 : 0)

/** Not snoozed first, then highest level, then oldest. */
export function sortAsks<A extends ShownAsk>(asks: readonly A[], now: number): A[] {
  return [...asks].sort((x, y) => {
    const sx = isSnoozed(x, now)
    const sy = isSnoozed(y, now)
    if (sx !== sy) return sx ? 1 : -1
    if (x.level !== y.level) return askRank(y.level) - askRank(x.level)
    if (x.at !== y.at) return x.at - y.at
    return x.id.localeCompare(y.id)
  })
}

export function asksOf(store: StoreView, agent: AgentEntity) {
  return [...store.asks.values()].filter((ask) => ask.agentId === agent.id)
}

export function topAsk(asks: readonly AskEntity[]) {
  return asks.reduce<AskEntity | null>((top, ask) => (!top || askRank(ask.level) > askRank(top.level) ? ask : top), null)
}

export function askSnoozeText(ask: Pick<AskEntity, 'snooze'>, now: number) {
  switch (ask.snooze?.kind) {
    case 'until': return `zz ${untilText(ask.snooze.at, now)}`
    case 'agent_done_or_idle': return "zz when it's done"
    case 'person_back': return "zz when you're back"
    case 'quiet_hours_end': return 'zz after quiet hours'
    default: return ''
  }
}

/** A snooze sheet's choice. `snooze: null` ends a snooze: "Remind me now". */
export interface SnoozeChoice { title: string; snooze: AskSnooze | null }

/** As the reference offers them: fixed delays, tomorrow at 9:00 local time, when it's done, when you're back. */
export function snoozeChoices(snoozed: boolean, now: number): SnoozeChoice[] {
  const tomorrowAtNine = new Date(now)
  tomorrowAtNine.setDate(tomorrowAtNine.getDate() + 1)
  tomorrowAtNine.setHours(9, 0, 0, 0)
  const after = (minutes: number): AskSnooze => ({ kind: 'until', at: now + minutes * 60_000 })
  return [
    { title: 'Remind me in 30 minutes', snooze: after(30) },
    { title: 'Remind me in 1 hour', snooze: after(60) },
    { title: 'Remind me in 3 hours', snooze: after(180) },
    { title: 'Remind me in Tomorrow 9:00', snooze: { kind: 'until', at: tomorrowAtNine.getTime() } },
    { title: "Remind me when it's done", snooze: { kind: 'agent_done_or_idle' } },
    { title: "Remind me when I'm back", snooze: { kind: 'person_back' } },
    ...(snoozed ? [{ title: 'Remind me now', snooze: null }] : []),
  ]
}

/** The ask row's swipe: snooze an hour, or end a snooze. */
export const quickSnooze = (snoozed: boolean, now: number): SnoozeChoice =>
  snoozed ? { title: 'Remind', snooze: null } : { title: 'Snooze 1h', snooze: { kind: 'until', at: now + 60 * 60_000 } }

export interface AskSymbol { name: string; color: 'red' | 'orange' | 'teal' }
export function askSymbol(level: AskEntity['level']): AskSymbol {
  if (level === 'urgent') return { name: 'exclamationmark.octagon.fill', color: 'red' }
  if (level === 'blocked') return { name: 'hand.raised.fill', color: 'orange' }
  return { name: 'questionmark.circle', color: 'teal' }
}

// ---- list order ----

/** Agents active within this stay in the top bucket, in a fixed order, so a busy team doesn't reshuffle. */
const RECENTLY_ACTIVE_MS = 60_000

/** One entry of the list as its order sees it: a name and when it was last active. */
export interface ListPlace { name: string; at: number }

/** The list's order: recently active first by name, then the rest by latest activity. */
export function listPlaceOrder(now: number): (x: ListPlace, y: ListPlace) => number {
  const recentSince = now - RECENTLY_ACTIVE_MS
  return (x, y) => {
    const recentX = x.at >= recentSince
    const recentY = y.at >= recentSince
    if (recentX !== recentY) return recentX ? -1 : 1
    if (recentX) return x.name.localeCompare(y.name)
    return x.at !== y.at ? y.at - x.at : x.name.localeCompare(y.name)
  }
}

export function sortForList(agents: readonly AgentEntity[], now: number): AgentEntity[] {
  const order = listPlaceOrder(now)
  return agents.map((agent) => ({ agent, place: { name: agent.name, at: activityTime(agent, now) } }))
    .sort((x, y) => order(x.place, y.place))
    .map((x) => x.agent)
}

/** After how many quiet minutes an agent folds into Idle; null when nothing folds. */
export const foldMinutes = (store: StoreView, fold: IdleFold) =>
  fold.kind === 'after_minutes' ? fold.minutes : fold.kind === 'never' ? null : store.server?.limits.idleFoldMinutes ?? null

/** Folded into "Idle (n)": quiet longer than the chosen time, not in a turn, nothing unread or waiting. */
export function isFolded(store: StoreView, agent: AgentEntity, fold: IdleFold, now: number): boolean {
  const minutes = foldMinutes(store, fold)
  if (minutes === null || isBusy(agent) || unreadOf(store, agent) > 0 || agent.queuedDeliveries > 0) return false
  return now - agent.lastActivityAt > minutes * 60_000
}

/** The agents in the list's order: awake ones, then Idle. */
export function listOrder(store: StoreView, fold: IdleFold, now: number) {
  const agents = sortForList(listedAgents(store), now)
  const idle = agents.filter((agent) => isFolded(store, agent, fold, now))
  const idleIds = new Set(idle.map((agent) => agent.id))
  return { awake: agents.filter((agent) => !idleIds.has(agent.id)), idle }
}

// ---- next unread ----

/** The top open ask of another agent, else the next agent after `current` with unread messages, wrapping. */
export function nextUnread(store: StoreView, current: AgentEntity | null, order: readonly AgentEntity[], now: number): AgentEntity | null {
  const ask = sortAsks([...store.asks.values()], now).find((a) => a.agentId !== current?.id && !isSnoozed(a, now))
  if (ask) {
    const agent = store.agents.get(ask.agentId)
    if (agent) return agent
  }
  const position = order.findIndex((agent) => agent.id === current?.id)
  for (let step = 1; step <= order.length; step++) {
    const agent = order[(position + step + order.length) % order.length]!
    if (agent.id !== current?.id && unreadOf(store, agent) > 0) return agent
  }
  return null
}

/** How many other agents next unread can go to: open asks and unread messages. */
export function unreadElsewhereCount(store: StoreView, current: AgentEntity | null, order: readonly AgentEntity[], now: number) {
  const ids = new Set<string>()
  for (const ask of store.asks.values()) if (ask.agentId !== current?.id && !isSnoozed(ask, now)) ids.add(ask.agentId)
  for (const agent of order) if (agent.id !== current?.id && unreadOf(store, agent) > 0) ids.add(agent.id)
  return ids.size
}

// ---- connection ----

/** How long the stream may be down before the Offline banner shows: a restarting server is back within a second or two. */
export const OFFLINE_GRACE_MS = 5000

export type ShownConnection = 'live' | 'connecting' | 'offline' | 'unpaired'

/** Down is "connecting" during the grace, then "offline" until live again, so retries can't make the banner blink. */
export function shownConnection(status: ConnectionStatus, now: number): ShownConnection {
  if (status.phase === 'live' || status.phase === 'unpaired') return status.phase
  if (status.downSince === null) return status.phase
  return now - status.downSince < OFFLINE_GRACE_MS ? 'connecting' : 'offline'
}

export type ConnectionNote = { kind: 'offline' | 'unpaired'; text: string }

/** What a screen says about a lost connection, once the grace is over; null while live or still connecting. */
export function connectionNoteOf(status: ConnectionStatus, now: number): ConnectionNote | null {
  switch (shownConnection(status, now)) {
    case 'offline': return { kind: 'offline', text: `Offline: ${status.detail || 'no connection'}` }
    case 'unpaired': return { kind: 'unpaired', text: status.detail || 'This server is not paired (or was revoked).' }
    default: return null
  }
}

// ---- addresses ----

/** How a member reads: the viewer as "You", a person by their name, an agent by its address. */
export function memberLabel(store: Pick<StoreView, 'viewer' | 'people'>, address: string) {
  if (address === store.viewer?.address) return 'You'
  for (const person of store.people.values()) if (person.address === address) return person.name
  const parsed = parseAddress(address)
  return parsed.kind === 'person' ? parsed.person : address
}
