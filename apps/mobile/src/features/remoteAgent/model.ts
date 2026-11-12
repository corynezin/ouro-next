// An agent on another of the person's computers, as the list and its chat show it. Pure: screens only draw this.
import type { ComputerEntity, RemoteAgentEntity, RemoteAskEntity } from '@ouro/contract'
import type { IdleFold } from '../../core/accounts/preferences.ts'
import type { NewSend } from '../../core/session/outbox.ts'
import { ago, oneLine, timerText } from '../../design/format.ts'
import { activityOf, directChatWith, foldMinutes, stateOf } from '../shared/agentFacts.ts'
import type { ListPlace, StoreView } from '../shared/agentFacts.ts'

/** The part of a session's store that holds the other computers and their agents. */
export interface RemoteView {
  readonly computers: ReadonlyMap<string, ComputerEntity>
  readonly remoteAgents: ReadonlyMap<string, RemoteAgentEntity>
  /** Copies of the open asks those agents put to the person, kept here while the person talks to them from here. */
  readonly remoteAsks: ReadonlyMap<string, RemoteAskEntity>
}

/** Primitive fields only, so a memoized row re-renders only when something it shows changed. */
export interface RemoteAgentRowModel {
  remoteAgentId: string
  name: string
  computerName: string
  /** Null where that computer trusts this one only limitedly. */
  model: string | null
  /** Null when nothing says when it was last active. */
  timeText: string | null
  statusText: string
  /** Offline: its computer is off, so the line is orange and the row dimmed (AG-31, AG-35). */
  statusTone: 'busy' | 'quiet' | 'offline'
  summaryLine: string | null
  previewText: string | null
  previewLines: 1 | 2
  unread: number
}

/** In a turn or getting into or out of one. Without details, its computer's word for it. */
export const isRemoteBusy = (remote: RemoteAgentEntity) => (remote.details ? activityOf(remote.details) !== null : remote.activity === 'running')

/** The reference's words: offline names the computer; reconnecting shows only while there is nothing livelier to say. */
export function remoteStatusText(remote: RemoteAgentEntity, computer: ComputerEntity): string {
  if (computer.status === 'offline') return `⊘ ${computer.name} offline`
  const busy = isRemoteBusy(remote)
  if (computer.status === 'reconnecting' && !busy) return `${computer.name} reconnecting…`
  const { details } = remote
  if (!details) return busy ? 'working' : 'waiting'
  const activity = activityOf(details)
  if (activity) return activity.label
  switch (stateOf(details)) {
    case 'running': return 'idle'
    case 'done': return 'done'
    case 'stopped': return 'stopped'
  }
}

/** When it was last active: now while busy; unknown without details. */
function remoteActivityTime(remote: RemoteAgentEntity, now: number): number | null {
  if (isRemoteBusy(remote)) return now
  return remote.details?.lastActivityAt ?? null
}

export const remoteUnreadOf = (store: StoreView, remote: RemoteAgentEntity) => {
  const chat = directChatWith(store, remote.address)
  return chat ? store.readStateOfChat(chat.id)?.unreadCount ?? 0 : 0
}

export interface RemoteListEntry { row: RemoteAgentRowModel; place: ListPlace; folded: boolean }

/** Every agent on the other computers, with where it goes in the list and whether it folds into Idle. Without details
 * nothing says how long it has been quiet, so it never folds. */
export function remoteListEntries(store: StoreView & RemoteView, fold: IdleFold, now: number): RemoteListEntry[] {
  const minutes = foldMinutes(store, fold)
  return [...store.remoteAgents.values()].flatMap((remote): RemoteListEntry[] => {
    const computer = store.computers.get(remote.computerId)
    if (!computer) return []
    const at = remoteActivityTime(remote, now)
    const unread = remoteUnreadOf(store, remote)
    const latest = directChatWith(store, remote.address)?.latestMessage
    const quietSince = remote.details && !isRemoteBusy(remote) && unread === 0 ? remote.details.lastActivityAt : null
    const row: RemoteAgentRowModel = {
      remoteAgentId: remote.id,
      name: remote.name,
      computerName: computer.name,
      model: remote.details?.model ?? null,
      timeText: at === null ? null : ago(at, now),
      statusText: remoteStatusText(remote, computer),
      statusTone: computer.status === 'offline' ? 'offline' : isRemoteBusy(remote) ? 'busy' : 'quiet',
      summaryLine: remote.details?.summaryLine ?? null,
      previewText: latest ? (latest.from === remote.address ? '' : 'you: ') + oneLine(latest.text) : null,
      previewLines: remote.details?.summaryLine ? 1 : 2,
      unread,
    }
    return [{
      row,
      place: { name: remote.name, at: at ?? 0 },
      folded: minutes !== null && quietSince !== null && now - quietSince > minutes * 60_000,
    }]
  })
}

export type RemoteActionModel = { kind: 'interrupt' } | { kind: 'stop' } | { kind: 'archive' }

/** As a local agent's, in the same order, for one this computer fully trusts with a computer that answers. A limited
 * computer shows no state to decide by and takes no control. */
export function remoteActionsOf(remote: RemoteAgentEntity, computer: ComputerEntity): RemoteActionModel[] {
  if (!remote.details || computer.status === 'offline') return []
  const running = stateOf(remote.details) === 'running'
  const actions: RemoteActionModel[] = []
  if (running && isRemoteBusy(remote)) actions.push({ kind: 'interrupt' })
  if (!running) actions.push({ kind: 'archive' })
  if (running) actions.push({ kind: 'stop' })
  return actions
}

export interface RemoteChatModel {
  title: string
  subtitle: string
  statusText: string
  /** The status without its timer: what the chat holds steady by, so the timer stays live while a blip waits. */
  statusLabel: string
  busy: boolean
  /** Its latest one-line summary, as its computer last told this one. */
  summaryLine: string | null
  /** Its log is read from its computer, which shows it only to a computer it trusts fully. */
  canReadLog: boolean
}

/** The bare name as the title with its computer beneath, and its status, which says so when that computer shows no more.
 * While it works, the status runs a timer, as a local agent's does. */
export function remoteChatModel(remote: RemoteAgentEntity, computer: ComputerEntity, now: number): RemoteChatModel {
  const status = remoteStatusText(remote, computer)
  const statusLabel = remote.details ? status : `${status} · ${REMOTE_COPY.limited}`
  const activity = remote.details && computer.status !== 'offline' ? activityOf(remote.details) : null
  return {
    title: remote.name,
    subtitle: `@${computer.name}`,
    statusText: activity ? `${statusLabel}  ${timerText(now - activity.since)}` : statusLabel,
    statusLabel,
    busy: activity !== null,
    summaryLine: remote.details?.summaryLine ?? null,
    canReadLog: remote.details !== null,
  }
}

/** A message to it, text only. Its conversation is the remote agent's id: the chat may not exist until this message.
 * `answersAskId`: the copy of its ask this answers alone; without one, the message closes all its asks on both computers. */
export const remoteSend = (remote: RemoteAgentEntity, text: string, answersAskId: string | null): NewSend => ({
  destination: { kind: 'direct', to: remote.address, answersAskId }, conversationId: remote.id, text, attachments: [],
})

/** The copies of its open asks here. */
export const remoteAsksOf = (store: RemoteView, remote: RemoteAgentEntity): RemoteAskEntity[] =>
  [...store.remoteAsks.values()].filter((ask) => ask.remoteAgentId === remote.id)

export const REMOTE_COPY = {
  empty: 'No messages yet.',
  limited: 'That computer trusts this one only to send messages.',
  archiveTitle: (name: string) => `Archive ${name}?`,
  archiveMessage: 'It stops and leaves the list on its computer too; nothing is deleted.',
} as const
