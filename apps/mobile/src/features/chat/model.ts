// One conversation as data. Pure: messages + outbox -> what the list and bars show. Screen.tsx only draws this.
import { goalWaitText, receiptOf, turnFailureText } from '@ouro/contract'
import type { AgentEntity, AskEntity, GoalEntity, MessageEntity, MessageReceipt, SummaryEntity } from '@ouro/contract'
import { ago, formatSize, oneLine, timerText } from '../../design/format.ts'
import { outboxEntriesNotYetListed } from '../../core/session/outbox.ts'
import type { NewSend, OutboxEntry } from '../../core/session/outbox.ts'
import type { ConnectionStatus } from '../../core/session/syncEngine.ts'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { activityOf, askSymbol, connectionNoteOf, isBeforeLatestTurn, isSnoozed, listedAgents, sortAsks, stateDotOf, statusLine } from '../shared/agentFacts.ts'
import type { AskSymbol, ShownAsk, StateDotKind, StoreView } from '../shared/agentFacts.ts'
import { goalColorOf, goalMarkerOf } from '../agents/model.ts'
import type { GoalColor } from '../agents/model.ts'

export type ChatItem =
  | { kind: 'message'; key: string; message: MessageEntity; mine: boolean; receiptText: string | null; failedText: string | null }
  | { kind: 'outbox'; key: string; entry: OutboxEntry }

export const receiptText: Record<Exclude<MessageReceipt, 'undeliverable' | 'failed'>, string> = {
  sent: '→ sent',
  queued: '◌ queued',
  delivered: '→ delivered',
  read: '✓ read',
}

function undeliverableReason(message: MessageEntity) {
  const state = message.deliveries[0]?.state
  if (state?.state === 'undeliverable') return state.reason
  if (state?.state === 'failed') return turnFailureText(state.failure)
  return null
}

/** Newest first, as an inverted list wants them: what's listed, then what's still going out. */
export function chatItems(input: { messages: readonly MessageEntity[]; outbox: readonly OutboxEntry[]; viewerAddress: string | undefined; recipientLastOutputAt: number | null }): ChatItem[] {
  const { messages, outbox, viewerAddress, recipientLastOutputAt } = input
  const listed: ChatItem[] = messages.map((message) => {
    const mine = message.from === viewerAddress
    const receipt = mine ? receiptOf(message, recipientLastOutputAt) : null
    const reason = undeliverableReason(message)
    return {
      kind: 'message',
      key: message.id,
      message,
      mine,
      receiptText: receipt && receipt !== 'undeliverable' && receipt !== 'failed' ? receiptText[receipt] : null,
      failedText: mine && (receipt === 'undeliverable' || receipt === 'failed') ? `⚠ not delivered: ${reason ?? 'refused'}` : null,
    }
  })
  const going: ChatItem[] = outboxEntriesNotYetListed(outbox, messages).map((entry) => ({ kind: 'outbox', key: entry.idempotencyKey, entry }))
  return [...listed, ...going].reverse()
}

/** `failureReason` is null while sending; once failed it is the reason, which also titles the failed bubble's sheet (CHAT-20). */
export interface OutboxBubbleModel { text: string; footnote: string; failureReason: string | null; faded: boolean }

export function outboxBubble(entry: OutboxEntry): OutboxBubbleModel {
  const lines = [entry.text, ...entry.attachments.map((a) => `📎 ${a.fileName}${a.uploadedAttachmentId !== null ? ' ✓' : ''}`)].filter(Boolean)
  const text = lines.join('\n') || `📎 ${entry.attachments.length} files`
  if (entry.delivery.state === 'sending') return { text, footnote: 'sending…', failureReason: null, faded: true }
  return { text, footnote: `⚠ not sent: ${entry.delivery.reason} · tap to retry`, failureReason: entry.delivery.reason, faded: false }
}

// ---- history ----

/** The top of a conversation (CHAT-15, ROOM-04): until its first page is here, Load messages, which also retries a first
 * load that failed; then Earlier messages while older ones remain; a spinner while a page is coming. */
export type HistoryFooterModel = { kind: 'loading' } | { kind: 'button'; label: 'Load messages' | 'Earlier messages' }

export function historyFooter(input: { loaded: boolean; hasOlder: boolean; loading: boolean }): HistoryFooterModel | null {
  if (input.loading) return { kind: 'loading' }
  if (!input.loaded) return { kind: 'button', label: 'Load messages' }
  return input.hasOlder ? { kind: 'button', label: 'Earlier messages' } : null
}

/** A page of history that failed to load is said in the status bar's note; one that loaded clears it (CHAT-16). */
export const historyLoadNote = (loaded: ApiResult<unknown>): string | null => (loaded.ok ? null : failureText(loaded.failure))

// ---- files ----

/** `imageSource` carries the device's credentials: attachments are served only to a paired device, images included. */
export interface MessageFileModel { key: string; attachmentId: string; fileName: string; isImage: boolean; sizeText: string; imageSource: { uri: string; headers: Record<string, string> } | null }

export function messageFiles(message: MessageEntity, attachmentUrl: (attachmentId: string) => string, headers: Record<string, string>): MessageFileModel[] {
  return message.attachments.map((attachment) => {
    const isImage = attachment.mimeType.startsWith('image/')
    return {
      key: attachment.id,
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      isImage,
      sizeText: formatSize(attachment.byteLength),
      imageSource: isImage ? { uri: attachmentUrl(attachment.id), headers } : null,
    }
  })
}

// ---- the chat's menus ----

/** The header's "next unread" button: how many there are, and its words when there are none. */
export const nextUnreadLabel = (count: number) => (count ? `Next unread, ${count}` : 'No other unread')

export type ChatMenuAction = 'pin' | 'log' | 'context' | 'goal' | 'summaries' | 'details' | 'interrupt' | 'stop'
export interface ChatMenuItem { action: ChatMenuAction; title: string; symbol: string; disabled?: boolean; destructive?: boolean }

/** The More menu: Pin or Unpin first; Interrupt and Stop only while it runs, Interrupt only while it's busy; Goal or Set a
 * goal by whether it has one. */
export function chatMoreMenu(agent: { hasGoal: boolean; running: boolean; busy: boolean; pinned: boolean }): ChatMenuItem[] {
  const items: ChatMenuItem[] = [
    agent.pinned ? { action: 'pin', title: 'Unpin', symbol: 'pin.slash' } : { action: 'pin', title: 'Pin to top', symbol: 'pin' },
    { action: 'log', title: 'Log', symbol: 'text.alignleft' },
    { action: 'context', title: 'Context', symbol: 'text.magnifyingglass' },
    { action: 'goal', title: agent.hasGoal ? 'Goal' : 'Set a goal', symbol: 'target' },
    { action: 'summaries', title: 'Summaries', symbol: 'text.badge.star' },
    { action: 'details', title: 'Details', symbol: 'info.circle' },
  ]
  if (!agent.running) return items
  return [...items, { action: 'interrupt', title: 'Interrupt', symbol: 'hand.raised', disabled: !agent.busy }, { action: 'stop', title: 'Stop', symbol: 'stop.circle', destructive: true }]
}

/** Stopping from the menu asks first; it keeps its session. What it then says on the status bar. */
export const STOP_COPY = {
  confirmTitle: (name: string) => `Stop ${name}?`,
  confirmMessage: 'It keeps its session; a message restarts it.',
  confirmAction: 'Stop',
  done: (name: string) => `stopped ${name}`,
} as const

export type FailedSendAction = 'retry' | 'edit' | 'delete'
/** What a failed send offers, in a chat or a room: try again, take it back into the composer, or let it go. */
export const FAILED_SEND_ACTIONS: readonly { action: FailedSendAction; title: string; destructive?: boolean }[] = [
  { action: 'retry', title: 'Retry' },
  { action: 'edit', title: 'Edit' },
  { action: 'delete', title: 'Delete', destructive: true },
]

// ---- sending ----

export interface ComposedFile { localId: string; uri: string; fileName: string; byteLength: number; mimeType: string; isImage: boolean }

/** A direct message to this agent. Its conversation is the agent's id: its chat may not exist until this very message. */
export function directSend(agent: AgentEntity, text: string, files: readonly ComposedFile[], answersAskId: string | null): NewSend {
  return {
    destination: { kind: 'direct', to: agent.name, answersAskId },
    conversationId: agent.id,
    text,
    attachments: files.map(({ localId, uri, fileName, byteLength, mimeType }) => ({ localId, uri, fileName, byteLength, mimeType })),
  }
}

/** A failed send back in the composer, for Edit. */
export function composedFilesOf(entry: OutboxEntry): ComposedFile[] {
  return entry.attachments.map(({ localId, uri, fileName, byteLength, mimeType }) => ({
    localId, uri, fileName, byteLength, mimeType, isImage: mimeType.startsWith('image/'),
  }))
}

/** When the agent last said anything, which is what turns "delivered" into "read". */
export function recipientLastOutputOf(agent: AgentEntity | undefined) {
  if (!agent) return null
  return agent.state.state === 'in_turn' ? agent.state.lastOutputAt : agent.lastActivityAt
}

// ---- bars ----

export interface GoalBarModel { text: string; color: GoalColor }
export function goalBar(goal: GoalEntity | undefined): GoalBarModel | null {
  if (!goal) return null
  return { text: `${goalMarkerOf(goal)} goal: ${goalLine(goal)}`, color: goalColorOf(goal) }
}

/** `active · cycle 12`, `paused by you: lunch`, `waiting: 5h usage`, `complete`. */
export function goalLine(goal: GoalEntity, viewerAddress?: string): string {
  const { status } = goal
  switch (status.status) {
    case 'active':
      return status.waitingFor !== null ? `waiting: ${goalWaitText(status.waitingFor)}` : `active · cycle ${goal.cycleCount}`
    case 'paused': {
      const by = status.by === viewerAddress ? 'you' : status.by
      return `paused by ${by}${status.reason ? `: ${status.reason}` : ''}`
    }
    case 'complete': return 'complete'
  }
}

export interface SummaryBarModel { text: string; ageText: string }

/** The live line if it's newer, else the latest summary. "(before its latest turn)" when idle and it has acted since. */
export function summaryBar(summary: SummaryEntity | undefined, agent: AgentEntity | undefined, now: number): SummaryBarModel | null {
  if (!summary || !agent) return null
  const { latest, live } = summary
  const shown = live && (!latest || live.at > latest.at) ? live : latest
  if (!shown) return null
  const stale = isBeforeLatestTurn(agent, shown.coversThroughAt)
  return { text: shown.line, ageText: `${ago(shown.at, now)}${stale ? ' (before its latest turn)' : ''}` }
}

/** While the connection is lost the agent's state is stale, so the bar says so instead, as the agents list does. */
export type StatusBarModel =
  /** `label` is `text` without its timer: what the screen holds steady (`useSteady`). */
  | { kind: 'agent'; dot: StateDotKind; busy: boolean; label: string; text: string }
  | { kind: 'connection_lost'; text: string }
export function statusBar(store: StoreView, agent: AgentEntity, connection: ConnectionStatus, now: number): StatusBarModel {
  const lost = connectionNoteOf(connection, now)
  if (lost) return { kind: 'connection_lost', text: lost.text }
  const activity = activityOf(agent)
  const line = statusLine(agent, store.goals.get(agent.id), store.viewer?.address, now)
  return { kind: 'agent', dot: stateDotOf(agent), busy: activity !== null, label: line, text: activity ? `${line}  ${timerText(now - activity.since)}` : line }
}

export interface PanelAskModel { askId: string; symbol: AskSymbol; text: string; choices: readonly string[]; snoozed: boolean; answering: boolean }

export function asksPanel(asks: readonly ShownAsk[], answeringAskId: string | null, now: number): { rows: PanelAskModel[]; hint: string | null } {
  const rows = sortAsks(asks, now).map((ask) => ({
    askId: ask.id, symbol: askSymbol(ask.level), text: oneLine(ask.text), choices: ask.choices, snoozed: isSnoozed(ask, now), answering: ask.id === answeringAskId,
  }))
  return { rows, hint: rows.length > 1 && answeringAskId === null ? `A reply closes all ${rows.length}; tap one to answer just it.` : null }
}

/** "Answer ask 2" counts from the top of the panel; "Message alice" otherwise. */
export function composerPlaceholder(agentName: string, panel: readonly PanelAskModel[]) {
  const position = panel.findIndex((ask) => ask.answering)
  return position >= 0 ? `Answer ask ${position + 1}` : `Message ${agentName}`
}

// ---- choices ----

const CHOICE_REPEAT_WINDOW_MS = 3000

/** A second tap on one ask's choices within 3 seconds sends nothing. One per session: it's about taps, not answers. */
export class ChoiceTapGuard {
  private lastTapAt = new Map<string, number>()
  accept(askId: string, now: number) {
    const last = this.lastTapAt.get(askId)
    if (last !== undefined && now - last < CHOICE_REPEAT_WINDOW_MS) return false
    this.lastTapAt.set(askId, now)
    return true
  }
}

// ---- agents a message names ----

/** An explicit mention of an agent: `@name`, `→ name` or `` `name` ``. A bare name isn't one: agents called `api` or
 * `test` would get a chip under every message with that word. */
const AGENT_MENTION = /(?:(?<![\w-])@|→\s*|`)([A-Za-z0-9][\w-]*)/g

/** Agents an agent's message mentions, in the order they appear, at most 4. One pass over the text, whatever the number
 * of agents. */
export function routedAgents(text: string, store: StoreView, selfId: string): AgentEntity[] {
  const byName = new Map(listedAgents(store).filter((agent) => agent.id !== selfId).map((agent) => [agent.name.toLowerCase(), agent]))
  const found: AgentEntity[] = []
  for (const match of text.matchAll(AGENT_MENTION)) {
    const agent = byName.get(match[1]!.toLowerCase())
    if (agent && !found.includes(agent)) found.push(agent)
  }
  return found.slice(0, 4)
}

/** A posed ask's choices stay on its message only while the ask is open. */
export function choicesForMessage(message: MessageEntity, asks: ReadonlyMap<string, Pick<AskEntity, 'id' | 'choices'>>) {
  if (message.posesAskId === null) return null
  const ask = asks.get(message.posesAskId)
  return ask?.choices.length ? { askId: ask.id, options: ask.choices } : null
}

// ---- opening at a message ----

/** A message to open a chat at, from search. */
export interface MessageAt { messageId: string; seq: number }

/** Older messages loaded a page at a time while looking for one, and how many pages before giving up. */
export const JUMP_PAGE_SIZE = 200
export const MAX_JUMP_PAGES = 25

export type JumpStep =
  | { kind: 'scroll'; index: number; messageId: string }
  | { kind: 'load_older' }
  | { kind: 'too_far' }
  | { kind: 'not_here' }

export const JUMP_COPY = {
  tooFar: 'That message is too far back to jump to.',
  /** A chat with no messages at all. */
  notHere: 'That message isn’t in this chat any more.',
} as const

/** What to do next to show `target`, given the items as listed (newest first) and the pages loaded so far. Once its place
 * is loaded and it isn't there, the nearest message at or before it stands in (CHAT-71), or the oldest when all are after
 * it. */
export function jumpStep(items: readonly ChatItem[], target: MessageAt, hasOlder: boolean, pagesLoaded: number): JumpStep {
  const index = items.findIndex((item) => item.kind === 'message' && item.message.id === target.messageId)
  const found = items[index]
  if (found?.kind === 'message') return { kind: 'scroll', index, messageId: found.message.id }
  const oldestSeq = items.reduce((oldest, item) => (item.kind === 'message' ? Math.min(oldest, item.message.seq) : oldest), Infinity)
  const placeLoaded = !hasOlder || oldestSeq < target.seq
  if (!placeLoaded) return pagesLoaded < MAX_JUMP_PAGES ? { kind: 'load_older' } : { kind: 'too_far' }
  return nearestBefore(items, target.seq) ?? { kind: 'not_here' }
}

function nearestBefore(items: readonly ChatItem[], seq: number): JumpStep | null {
  const atOrBefore = items.findIndex((item) => item.kind === 'message' && item.message.seq <= seq)
  const index = atOrBefore >= 0 ? atOrBefore : items.findLastIndex((item) => item.kind === 'message')
  const nearest = items[index]
  return nearest?.kind === 'message' ? { kind: 'scroll', index, messageId: nearest.message.id } : null
}

/** A copy pulled from a shared network: where it came from, and, while it waits to be started, the button that starts it.
 * Null for any other agent. */
export function pulledBar(agent: AgentEntity): { text: string; canStart: boolean } | null {
  if (!agent.pulled) return null
  const { from, network, awaitingStart } = agent.pulled
  return { text: `Copy of ${from}, from the shared network ${network}${awaitingStart ? '. Paused: it runs once started.' : ''}`, canStart: awaitingStart }
}
