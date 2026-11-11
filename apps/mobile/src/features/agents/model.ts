// The agents list as data. Pure: store -> rows and sections. Screen.tsx only draws this.
import type { AgentEntity, AskEntity, IntegrationEntity } from '@ouro/contract'
import { ago, foldForSearch, money, oneLine } from '../../design/format.ts'
import type { IdleFold } from '../../core/accounts/preferences.ts'
import type { ConnectionStatus } from '../../core/session/syncEngine.ts'
import {
  activityTime, askSnoozeText, listPlaceOrder, connectionNoteOf, askSymbol, asksOf, directChatOf, directChatWith, isBusy, isMaster, isSnoozed, lastMessagePreview, listedAgents, listOrder, shownConnection,
  openCopyOf, sortAsks, stateDotOf, statusLine, stateOf, topAsk, unreadElsewhereCount, unreadOf,
} from '../shared/agentFacts.ts'
import type { Asker, AskSymbol, ListPlace, ShownAsk, StateDotKind, StoreView } from '../shared/agentFacts.ts'
import { remoteListEntries } from '../remoteAgent/model.ts'
import type { RemoteAgentRowModel, RemoteView } from '../remoteAgent/model.ts'
import { isClaudeOnPlan, openRouterSpentUsd, planUsageLine } from '../shared/planUsage.ts'

/** Primitive fields only, so a memoized row re-renders only when something it shows changed. */
export interface AgentRowModel {
  agentId: string
  name: string
  model: string
  goalMarker: string | null
  goalColor: GoalColor | null
  runningOldRelease: boolean
  costText: string | null
  timeText: string
  statusText: string
  statusTone: 'busy' | 'quiet'
  summaryLine: string | null
  previewText: string | null
  previewLines: 1 | 2
  askSymbolName: string | null
  askSymbolColor: AskSymbol['color'] | null
  askCount: number
  unread: number
}

/** A row of the list: an agent here, or one on another of the person's computers, beside each other. */
export type ListedRow = { kind: 'local'; row: AgentRowModel } | { kind: 'remote'; row: RemoteAgentRowModel }

export type GoalColor = 'secondary' | 'yellow' | 'orange'

export interface MasterCardModel {
  agentId: string
  dot: StateDotKind
  timeText: string
  statusText: string
  previewText: string | null
  unread: number
}

export interface AskRowModel {
  askId: string
  asker: Asker
  /** `name@machine` for an agent on another computer. */
  agentName: string
  symbolName: string
  symbolColor: AskSymbol['color']
  timeText: string
  text: string
  choices: readonly string[]
  snoozed: boolean
}

export type NoteRow =
  | { kind: 'offline'; text: string }
  | { kind: 'unpaired'; text: string }
  | { kind: 'failure'; text: string }

export interface AgentsListModel {
  dotColor: 'green' | 'yellow' | 'red'
  /** Null until a plan's usage has been read. */
  usageLine: string | null
  notes: NoteRow[]
  master: MasterCardModel | null
  /** Null when there are no open asks. */
  asks: { headerText: string; headerTone: 'orange' | 'secondary'; rows: AskRowModel[] } | null
  awake: ListedRow[]
  idle: ListedRow[]
  search: { rows: ListedRow[]; emptyText: string | null } | null
  emptyText: string | null
  nextUnreadCount: number
  /** Unread in group chats. Direct chats count on their agents' rows. */
  groupChatUnread: number
}

const goalMarkerOf = (goal: NonNullable<ReturnType<StoreView['goals']['get']>>) => {
  switch (goal.status.status) {
    case 'complete': return '✓'
    case 'paused': return '‖'
    case 'active':
      if (goal.status.waitingFor !== null) return '◷'
      return goal.kind.kind === 'open_ended' ? '∞' : '◎'
  }
}

export function goalColorOf(goal: NonNullable<ReturnType<StoreView['goals']['get']>>): GoalColor {
  if (goal.status.status === 'complete') return 'secondary'
  if (goal.status.status === 'paused' || goal.status.waitingFor !== null) return 'yellow'
  return 'orange'
}
export { goalMarkerOf }

/**
 * The reference shows only OpenRouter spend: that is money the owner pays per use. A subscription's turns report a
 * notional cost too, which nobody pays, so it isn't shown.
 */
function payAsYouGoCostText(store: StoreView, agent: AgentEntity): string | null {
  const provider = store.server?.models.find((option) => option.id === agent.model)?.provider
  return provider === 'openrouter' && agent.costUsd > 0 ? money(agent.costUsd) : null
}

function agentRow(store: StoreView, agent: AgentEntity, now: number): AgentRowModel {
  const goal = store.goals.get(agent.id)
  const summary = store.summaries.get(agent.id)?.latest ?? null
  const preview = lastMessagePreview(store, agent)
  const asks = asksOf(store, agent)
  const top = topAsk(asks)
  const symbol = top ? askSymbol(top.level) : null
  return {
    agentId: agent.id,
    name: agent.name,
    model: agent.model,
    goalMarker: goal ? goalMarkerOf(goal) : null,
    goalColor: goal ? goalColorOf(goal) : null,
    runningOldRelease: agent.runningOldRelease,
    costText: payAsYouGoCostText(store, agent),
    timeText: ago(activityTime(agent, now), now),
    statusText: pulledPrefix(agent) + statusLine(agent, goal, store.viewer?.address, now),
    statusTone: isBusy(agent) ? 'busy' : 'quiet',
    summaryLine: summary?.line ?? null,
    previewText: preview ? (preview.mine ? 'you: ' : '') + oneLine(preview.text) : null,
    previewLines: summary ? 1 : 2,
    askSymbolName: symbol?.name ?? null,
    askSymbolColor: symbol?.color ?? null,
    askCount: asks.length,
    unread: unreadOf(store, agent),
  }
}

function masterCard(store: StoreView, master: AgentEntity, now: number): MasterCardModel {
  const preview = lastMessagePreview(store, master)
  return {
    agentId: master.id,
    dot: stateDotOf(master),
    timeText: ago(activityTime(master, now), now),
    statusText: isBusy(master) ? statusLine(master, store.goals.get(master.id), store.viewer?.address, now) : 'Tell me what you need; I route it',
    previewText: preview ? (preview.mine ? 'you: ' : '') + oneLine(preview.text) : null,
    unread: unreadOf(store, master),
  }
}

/** A local ask or a remote ask's copy, with who asked: the section orders them together. */
type ListedAsk = ShownAsk & { asker: Asker; agentName: string }

function askRow(ask: ListedAsk, now: number): AskRowModel {
  const symbol = askSymbol(ask.level)
  const snoozed = isSnoozed(ask, now)
  return {
    askId: ask.id,
    asker: ask.asker,
    agentName: ask.agentName,
    symbolName: symbol.name,
    symbolColor: symbol.color,
    timeText: snoozed ? askSnoozeText(ask, now) : ago(ask.at, now),
    text: oneLine(ask.text),
    choices: ask.choices,
    snoozed,
  }
}

function asksSection(store: StoreView & RemoteView, masterId: string | undefined, now: number): AgentsListModel['asks'] {
  const local = [...store.asks.values()].filter((ask) => ask.agentId !== masterId)
    .map((ask): ListedAsk => ({ ...ask, asker: { kind: 'local', agentId: ask.agentId } }))
  const remote = [...store.remoteAsks.values()]
    .map((ask): ListedAsk => ({ ...openCopyOf(ask), asker: { kind: 'remote', remoteAgentId: ask.remoteAgentId }, agentName: ask.address }))
  const asks = sortAsks([...local, ...remote], now)
  if (!asks.length) return null
  const open = asks.filter((ask) => !isSnoozed(ask, now)).length
  return {
    headerText: open ? `Asks (${open})` : 'Asks (all snoozed)',
    headerTone: open ? 'orange' : 'secondary',
    rows: asks.map((ask) => askRow(ask, now)),
  }
}

type SearchRank = 0 | 1 | 2

/** Name prefix first (bare, or `name@machine`), then a name containing it, then its task, summary, done summary or last
 * message. Null: no match. `q` is already folded. */
function searchRankOf(q: string, names: readonly string[], texts: readonly (string | null | undefined)[]): SearchRank | null {
  const has = (text: string | null | undefined) => !!text && foldForSearch(text).includes(q)
  if (names.some((name) => foldForSearch(name).startsWith(q))) return 0
  if (names.some(has)) return 1
  return texts.some(has) ? 2 : null
}

/** Case- and accent-insensitive, idle agents and master included, agents here and on the person's other computers side by
 * side: by rank, then by the list's own order. */
export function searchAgents(store: StoreView & RemoteView, query: string, now: number): ListedRow[] {
  const q = foldForSearch(query.trim())
  if (!q) return []
  const machineName = store.server?.machineName
  const local = listOrder(store, { kind: 'never' }, now).awake.flatMap((agent) => {
    const doneSummary = agent.state.state === 'done' ? agent.state.summary : null
    const names = machineName ? [agent.name, `${agent.name}@${machineName}`] : [agent.name]
    const rank = searchRankOf(q, names, [agent.task, store.summaries.get(agent.id)?.latest?.line, doneSummary, directChatOf(store, agent)?.latestMessage?.text])
    return rank === null ? [] : [{ rank, place: { name: agent.name, at: activityTime(agent, now) }, row: { kind: 'local', row: agentRow(store, agent, now) } satisfies ListedRow }]
  })
  const remote = remoteListEntries(store, { kind: 'never' }, now).flatMap((entry) => {
    const agent = store.remoteAgents.get(entry.row.remoteAgentId)
    if (!agent) return []
    const details = agent.details
    const doneSummary = details?.state.state === 'done' ? details.state.summary : null
    const rank = searchRankOf(q, [agent.name, agent.address], [details?.task, details?.summaryLine, doneSummary, directChatWith(store, agent.address)?.latestMessage?.text])
    return rank === null ? [] : [{ rank, place: entry.place, row: { kind: 'remote', row: entry.row } satisfies ListedRow }]
  })
  const order = listPlaceOrder(now)
  return [...local, ...remote].sort((x, y) => x.rank - y.rank || order(x.place, y.place)).map((x) => x.row)
}

/** Local rows in `listOrder`'s order with the remote ones placed among them by the same rule. */
function interleave(local: readonly { row: ListedRow; place: ListPlace }[], remote: readonly { row: ListedRow; place: ListPlace }[], now: number): ListedRow[] {
  const order = listPlaceOrder(now)
  return [...local, ...remote].sort((x, y) => order(x.place, y.place)).map((x) => x.row)
}

/** The top line's badge: unread on the saved servers that aren't open, from their last check. Zero hides it (AG-11). */
export function otherServersUnreadTotal(counts: ReadonlyMap<string, number>, activeServerId: string): number {
  return [...counts].reduce((total, [serverId, count]) => (serverId === activeServerId ? total : total + count), 0)
}

/** The account states the list's top line reads. */
/** The integrations the list's usage line reads: whether Claude is on a plan, and OpenRouter's spend. */
export interface IntegrationView { integration<P extends 'claude' | 'openrouter'>(provider: P): Extract<IntegrationEntity, { provider: P }> | null }

export function agentsListModel(store: StoreView & RemoteView & IntegrationView, input: { connection: ConnectionStatus; fold: IdleFold; query: string; failureNote: string | null; now: number }): AgentsListModel {
  const { connection, fold, now, query, failureNote } = input
  const shown = shownConnection(connection, now)
  const everyone = listedAgents(store)
  const master = everyone.find(isMaster) ?? null
  const others = (agents: readonly AgentEntity[]) => agents.filter((agent) => !isMaster(agent))

  const notes: NoteRow[] = []
  const connectionNote = connectionNoteOf(connection, now)
  if (connectionNote) notes.push(connectionNote)
  if (failureNote) notes.push({ kind: 'failure', text: failureNote })

  const { awake, idle } = listOrder(store, fold, now)
  const trimmedQuery = query.trim()
  const found = trimmedQuery ? searchAgents(store, trimmedQuery, now) : null
  const remote = remoteListEntries(store, fold, now)
  const noOthers = others(everyone).length === 0 && remote.length === 0
  const localEntries = (agents: readonly AgentEntity[]) => others(agents).map((agent) => ({
    row: { kind: 'local', row: agentRow(store, agent, now) } satisfies ListedRow,
    place: { name: agent.name, at: activityTime(agent, now) },
  }))
  const remoteEntries = (folded: boolean) => remote.filter((entry) => entry.folded === folded)
    .map((entry) => ({ row: { kind: 'remote', row: entry.row } satisfies ListedRow, place: entry.place }))

  return {
    dotColor: shown === 'live' ? 'green' : shown === 'connecting' ? 'yellow' : 'red',
    usageLine: store.server ? planUsageLine(store.server.planUsage, isClaudeOnPlan(store.integration('claude')?.state ?? null), openRouterSpentUsd(store.integration('openrouter')?.state ?? null, everyone, store.server.models), now) : null,
    notes,
    master: master ? masterCard(store, master, now) : null,
    asks: asksSection(store, master?.id, now),
    awake: interleave(localEntries(awake), remoteEntries(false), now),
    idle: interleave(localEntries(idle), remoteEntries(true), now),
    search: found && {
      rows: found,
      emptyText: found.length ? null : `No agents match “${trimmedQuery}”.`,
    },
    emptyText: noOthers ? (shown === 'live' ? 'No agents yet.' : 'Connecting…') : null,
    nextUnreadCount: unreadElsewhereCount(store, null, [...awake, ...idle], now),
    groupChatUnread: [...store.chats.values()].filter((chat) => chat.kind === 'group').reduce((total, chat) => total + (store.readStateOfChat(chat.id)?.unreadCount ?? 0), 0),
  }
}

export type SwipeActionModel =
  | { kind: 'interrupt' }
  | { kind: 'pause_goal' }
  | { kind: 'resume_goal' }
  | { kind: 'archive' }
  | { kind: 'stop' }

/** In order, as the reference: Interrupt (busy), Pause or Resume goal (unfinished goal), Archive (not running), Stop (running). */
export function swipeActionsOf(store: StoreView, agent: AgentEntity): SwipeActionModel[] {
  const running = stateOf(agent) === 'running'
  const goal = store.goals.get(agent.id)
  const actions: SwipeActionModel[] = []
  if (running && isBusy(agent)) actions.push({ kind: 'interrupt' })
  if (goal && goal.status.status !== 'complete') actions.push({ kind: goal.status.status === 'paused' ? 'resume_goal' : 'pause_goal' })
  if (!running) actions.push({ kind: 'archive' })
  if (running) actions.push({ kind: 'stop' })
  return actions
}

/** A copy pulled from a shared network says so in the list, beside its original's `name@machine`. */
export function pulledPrefix(agent: AgentEntity): string {
  if (!agent.pulled) return ''
  return agent.pulled.awaitingStart ? `copy from ${agent.pulled.network}, paused · ` : `copy from ${agent.pulled.network} · `
}
