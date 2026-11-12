// The chats list as data: yours, then others' you can read. A direct chat you're in opens the agent's conversation;
// everything else opens the room. Pure: Screen.tsx only draws this.
import { parseAddress } from '@ouro/contract'
import type { ChatEntity, ComputerEntity, PinTarget, RemoteAgentEntity } from '@ouro/contract'
import type { MentionOption } from '../../design/messageText.ts'
import { ago, foldForSearch, oneLine } from '../../design/format.ts'
import { listedAgents, memberLabel, shownConnection, sortedPins } from '../shared/agentFacts.ts'
import type { PinView, StoreView } from '../shared/agentFacts.ts'
import type { ConnectionStatus } from '../../core/session/syncEngine.ts'

export const isPersonAddress = (address: string) => parseAddress(address).kind !== 'agent'

export const isMember = (chat: ChatEntity, viewerAddress: string | undefined) => chat.members.some((member) => member.address === viewerAddress)

/** The other side of a direct chat: the agent if there is one, else whoever isn't the viewer. */
export function otherMember(chat: ChatEntity, viewerAddress: string | undefined): string {
  const addresses = chat.members.map((member) => member.address)
  return addresses.find((address) => !isPersonAddress(address)) ?? addresses.find((address) => address !== viewerAddress) ?? addresses[0] ?? ''
}

export function chatTitle(store: StoreView, chat: ChatEntity): string {
  if (chat.title) return chat.title
  const viewer = store.viewer?.address
  if (chat.kind === 'direct' && isMember(chat, viewer)) return memberLabel(store, otherMember(chat, viewer))
  return chat.members.map((member) => memberLabel(store, member.address)).join(chat.kind === 'direct' ? ' & ' : ', ')
}

/** A group's last message with who said it; your direct chat's with "you:" on yours; none for others' direct chats. */
export function chatPreview(store: StoreView, chat: ChatEntity): string | null {
  const latest = chat.latestMessage
  if (!latest) return null
  if (chat.kind === 'group') return `${memberLabel(store, latest.from)}: ${latest.text}`
  const viewer = store.viewer?.address
  if (!isMember(chat, viewer)) return null
  return (latest.from === viewer ? 'you: ' : '') + latest.text
}

export const chatTime = (chat: ChatEntity) => chat.latestMessage?.at ?? chat.createdAt

export interface ChatRowModel {
  chatId: string
  kind: ChatEntity['kind']
  /** Who the avatar shows, for a direct chat. */
  avatarAddress: string | null
  avatarIsPerson: boolean
  title: string
  memberCount: number
  /** "3 members". */
  membersText: string
  timeText: string
  previewText: string | null
  unread: number
  pinned: boolean
}

export const membersText = (count: number) => (count === 1 ? '1 member' : `${count} members`)

/**
 * Each pinned chat of the viewer's, by its place among their pins: a group pinned itself, or a direct chat with a pinned
 * agent. Worked out once for a whole list.
 */
export function pinRanksOfChats(store: StoreView & PinView): ReadonlyMap<string, number> {
  const viewer = store.viewer?.address
  const directWith = new Map<string, string>()
  for (const chat of store.chats.values()) if (chat.kind === 'direct' && isMember(chat, viewer)) directWith.set(otherMember(chat, viewer), chat.id)
  const chatOf = (target: PinTarget): string | undefined => {
    switch (target.kind) {
      case 'chat': return target.chatId
      case 'remote_agent': return directWith.get(target.address)
      case 'agent': {
        const agent = store.agents.get(target.agentId)
        return agent && directWith.get(agent.name)
      }
    }
  }
  const ranks = new Map<string, number>()
  sortedPins(store).forEach((pin, rank) => {
    const chatId = chatOf(pin.target)
    if (chatId !== undefined && !ranks.has(chatId)) ranks.set(chatId, rank)
  })
  return ranks
}

/** `pinned`: from pinRanksOfChats. */
export function chatRow(store: StoreView, chat: ChatEntity, now: number, pinned: boolean): ChatRowModel {
  const other = otherMember(chat, store.viewer?.address)
  const preview = chatPreview(store, chat)
  return {
    chatId: chat.id,
    kind: chat.kind,
    avatarAddress: chat.kind === 'direct' ? other : null,
    avatarIsPerson: isPersonAddress(other),
    title: chatTitle(store, chat),
    memberCount: chat.members.length,
    membersText: membersText(chat.members.length),
    timeText: ago(chatTime(chat), now),
    previewText: preview === null ? null : oneLine(preview),
    unread: store.readStateOfChat(chat.id)?.unreadCount ?? 0,
    pinned,
  }
}

export interface ChatsListModel { mine: ChatRowModel[]; others: ChatRowModel[]; emptyText: string | null }

/** Yours with pinned ones first, in pin order, then latest first; then others' you can read, the same way. */
export function chatsListModel(store: StoreView & PinView, connection: ConnectionStatus, now: number): ChatsListModel {
  const viewer = store.viewer?.address
  const ranks = pinRanksOfChats(store)
  const byPinThenLatest = (x: ChatEntity, y: ChatEntity): number => {
    const rankX = ranks.get(x.id)
    const rankY = ranks.get(y.id)
    if (rankX !== undefined && rankY !== undefined) return rankX - rankY
    if (rankX !== undefined) return -1
    if (rankY !== undefined) return 1
    return chatTime(y) - chatTime(x)
  }
  const rows = (chats: ChatEntity[]) => chats.sort(byPinThenLatest).map((chat) => chatRow(store, chat, now, ranks.has(chat.id)))
  const all = [...store.chats.values()]
  const mine = rows(all.filter((chat) => isMember(chat, viewer)))
  // pinTargetOfChat offers no pin for others' chats, but a pin of one made elsewhere (by an agent) still leads.
  const others = rows(all.filter((chat) => !isMember(chat, viewer)))
  const emptyText = mine.length ? null
    : others.length ? 'You aren’t in any chats yet.'
    : shownConnection(connection, now) === 'live' ? 'No chats yet.' : 'Connecting…'
  return { mine, others, emptyText }
}

/** Where a chat opens: your direct chat with an agent is that agent's conversation. */
export type ChatDestination = { screen: 'Chat'; agentRef: string } | { screen: 'ChatRoom'; chatId: string }
export function chatDestination(store: StoreView, chat: ChatEntity): ChatDestination {
  const viewer = store.viewer?.address
  const other = otherMember(chat, viewer)
  if (chat.kind === 'direct' && isMember(chat, viewer) && !isPersonAddress(other)) {
    const agent = [...store.agents.values()].find((candidate) => candidate.name === parseAgentName(other) && candidate.state.state !== 'archived')
    if (agent) return { screen: 'Chat', agentRef: agent.id }
  }
  return { screen: 'ChatRoom', chatId: chat.id }
}

/** What pinning a chat pins: a group itself, or the agent on the other side of your direct chat. Null for a chat between
 * people, or one you aren't in: the lists keep only your own chats at the top. */
export function pinTargetOfChat(store: StoreView, chat: ChatEntity): PinTarget | null {
  const viewer = store.viewer?.address
  if (!isMember(chat, viewer)) return null
  if (chat.kind === 'group') return { kind: 'chat', chatId: chat.id }
  const other = otherMember(chat, viewer)
  if (isPersonAddress(other)) return null
  const parsed = parseAddress(other)
  if (parsed.kind !== 'agent') return null
  if (parsed.machine !== null) return { kind: 'remote_agent', address: other }
  const agent = [...store.agents.values()].find((candidate) => candidate.name === parsed.agentName && candidate.state.state !== 'archived')
  return agent ? { kind: 'agent', agentId: agent.id } : null
}

function parseAgentName(address: string) {
  const parsed = parseAddress(address)
  return parsed.kind === 'agent' ? parsed.agentName : address
}

/** Who @ completes to: a person by name (their address's name when theirs has a space), an agent by bare name, with
 * its machine when two members share the name. Never yourself. */
export function mentionOptions(store: StoreView, chat: ChatEntity): MentionOption[] {
  const viewer = store.viewer?.address
  const others = chat.members.map((member) => member.address).filter((address) => address !== viewer)
  const agentNames = others.map((address) => parseAddress(address)).flatMap((parsed) => (parsed.kind === 'agent' ? [parsed.agentName] : []))
  return others.map((address) => {
    const parsed = parseAddress(address)
    const label = memberLabel(store, address)
    if (parsed.kind === 'person') return { label, insert: /\s/.test(label) ? parsed.person : label }
    if (parsed.kind === 'owner') return { label, insert: /\s/.test(label) ? address : label }
    const shared = agentNames.filter((name) => name === parsed.agentName).length > 1
    return { label, insert: shared && parsed.machine !== null ? `${parsed.agentName}@${parsed.machine}` : parsed.agentName }
  })
}

// ---- choosing members ----

export interface MemberChoice { address: string; label: string }

/** Who a new group, or an existing one, can take: people and agents on this server, less you and its members. */
export function memberChoices(store: StoreView, chat: ChatEntity | null, query: string): { people: MemberChoice[]; agents: MemberChoice[] } {
  const viewer = store.viewer?.address
  const taken = new Set(chat?.members.map((member) => member.address) ?? [])
  const wanted = foldForSearch(query.trim())
  const offered = (choice: MemberChoice) => choice.address !== viewer && !taken.has(choice.address) && foldForSearch(choice.label).includes(wanted)
  const byLabel = (x: MemberChoice, y: MemberChoice) => x.label.localeCompare(y.label)
  const people = [...store.people.values()].map((person) => ({ address: person.address, label: person.name })).filter(offered).sort(byLabel)
  const agents = listedAgents(store).map((agent) => ({ address: agent.name, label: agent.name })).filter(offered).sort(byLabel)
  return { people, agents }
}

/** Agents on the person's other computers, a section per computer by its name, each agent toggled by its bare name. */
export function agentsElsewhereChoices(
  remoteAgents: Iterable<RemoteAgentEntity>, computers: ReadonlyMap<string, ComputerEntity>, chat: ChatEntity | null, query: string,
): { computerName: string; agents: MemberChoice[] }[] {
  const taken = new Set(chat?.members.map((member) => member.address) ?? [])
  const wanted = foldForSearch(query.trim())
  const byComputer = new Map<string, MemberChoice[]>()
  for (const agent of remoteAgents) {
    const computerName = computers.get(agent.computerId)?.name
    if (computerName === undefined || taken.has(agent.address) || !foldForSearch(agent.name).includes(wanted)) continue
    byComputer.set(computerName, [...(byComputer.get(computerName) ?? []), { address: agent.address, label: agent.name }])
  }
  return [...byComputer]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([computerName, agents]) => ({ computerName, agents: agents.sort((x, y) => x.label.localeCompare(y.label)) }))
}

/** The sheet's done button: Create a group, or Add to one, and what it says while that is under way. */
export const memberPickerDoneTitle = (adding: boolean, busy: boolean) => (busy ? (adding ? 'Adding…' : 'Creating…') : adding ? 'Add' : 'Create')

/** The toggled members and the one typed as name@server, each once. */
export function chosenMembers(toggled: readonly string[], typed: string): string[] {
  const typedAddress = typed.trim()
  return [...new Set(typedAddress ? [...toggled, typedAddress] : toggled)]
}

export const NEW_CHAT_COPY = {
  notListedFooter: 'Someone not listed? Type them as human@server, or an agent as name@server.',
} as const

/** The chats an agent or person is in, for their Chats section. */
export function chatsWithMember(store: StoreView, address: string): { chatId: string; title: string }[] {
  return [...store.chats.values()]
    .filter((chat) => chat.members.some((member) => member.address === address))
    .sort((x, y) => chatTime(y) - chatTime(x))
    .map((chat) => ({ chatId: chat.id, title: chatTitle(store, chat) }))
}

/** Adds each member in turn and stops at the first refusal. Null once all are in, else "`member`: `reason`" (NCHAT-06). */
export async function addMembersInTurn(addresses: readonly string[], add: (address: string) => Promise<string | null>, labelOf: (address: string) => string): Promise<string | null> {
  for (const address of addresses) {
    const refusal = await add(address)
    if (refusal !== null) return `${labelOf(address)}: ${refusal}`
  }
  return null
}
