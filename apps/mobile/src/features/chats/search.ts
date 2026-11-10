// Searching from Chats, as data: chats by name here, and messages found by the server, yours first, with the words
// marked. Pure: Screen.tsx draws this and runs the search.
import type { ChatEntity, SearchHit, SearchPage } from '@ouro/contract'
import { ago, foldForSearch } from '../../design/format.ts'
import { memberLabel } from '../shared/agentFacts.ts'
import type { StoreView } from '../shared/agentFacts.ts'
import { chatRow, chatTime, chatTitle, isMember, isPersonAddress, otherMember } from './model.ts'
import type { ChatRowModel } from './model.ts'

/** Typing pauses this long before the server is asked: each word would otherwise search every message. */
export const SEARCH_PAUSE_MS = 300

/** The server's answer for one query. */
export type MessageSearch =
  | { kind: 'searching' }
  | { kind: 'failed'; reason: string }
  | { kind: 'found'; page: SearchPage }

/** The server's last answer, with the query it answered. */
export interface AnsweredSearch { query: string; search: MessageSearch }

/** The search to show for what is typed now: an answer for an older query is ignored, so it's still searching (ROOMS-16). */
export function searchFor(typed: string, answered: AnsweredSearch | null): MessageSearch {
  return answered?.query === typed ? answered.search : { kind: 'searching' }
}

export interface MarkedPart { text: string; marked: boolean }

export interface HitRowModel {
  key: string
  chatId: string
  messageId: string
  seq: number
  /** Null for a chat this phone doesn't have yet. */
  kind: ChatEntity['kind'] | null
  avatarAddress: string | null
  avatarIsPerson: boolean
  title: string
  timeText: string
  senderText: string
  excerpt: MarkedPart[]
}

export type SearchRow = { kind: 'chat'; chat: ChatRowModel } | { kind: 'hit'; hit: HitRowModel }
export interface SearchSection { key: 'named' | 'hits_mine' | 'hits_others'; title: string; rows: SearchRow[] }
export interface ChatSearchModel { sections: SearchSection[]; noteText: string }

export const SEARCH_COPY = {
  placeholder: 'Chats and messages',
  searching: 'Searching messages…',
  newestOnly: 'These are the newest matches. More words narrow it down.',
  archivedLeftOut: 'Archived agents’ direct chats aren’t searched.',
  newChat: 'A new chat',
} as const

/** The query's words, as the server splits them. */
const queryWords = (query: string) => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]

export function chatSearchModel(store: StoreView, query: string, search: MessageSearch, now: number): ChatSearchModel {
  const words = queryWords(query).map(foldForSearch)
  const viewer = store.viewer?.address
  const named = [...store.chats.values()]
    .filter((chat) => { const title = foldForSearch(chatTitle(store, chat)); return words.every((word) => title.includes(word)) })
    .sort((x, y) => Number(isMember(y, viewer)) - Number(isMember(x, viewer)) || chatTime(y) - chatTime(x))
    .map((chat): SearchRow => ({ kind: 'chat', chat: chatRow(store, chat, now) }))
  const hits = search.kind === 'found' ? search.page.hits : []
  const inMine = (hit: SearchHit) => { const chat = store.chats.get(hit.chatId); return chat !== undefined && isMember(chat, viewer) }
  const hitRows = (list: SearchHit[]) => list.map((hit): SearchRow => ({ kind: 'hit', hit: hitRow(store, hit, query, now) }))
  const sections: SearchSection[] = [
    { key: 'named' as const, title: 'Chats', rows: named },
    { key: 'hits_mine' as const, title: 'In your chats', rows: hitRows(hits.filter(inMine)) },
    { key: 'hits_others' as const, title: 'In other chats', rows: hitRows(hits.filter((hit) => !inMine(hit))) },
  ].filter((section) => section.rows.length > 0)
  return { sections, noteText: searchNote(query, search, sections.length > 0) }
}

function hitRow(store: StoreView, hit: SearchHit, query: string, now: number): HitRowModel {
  const chat = store.chats.get(hit.chatId)
  const other = chat ? otherMember(chat, store.viewer?.address) : null
  return {
    key: `${hit.chatId}/${hit.messageId}`,
    chatId: hit.chatId,
    messageId: hit.messageId,
    seq: hit.seq,
    kind: chat?.kind ?? null,
    avatarAddress: chat?.kind === 'direct' ? other : null,
    avatarIsPerson: other !== null && isPersonAddress(other),
    title: chat ? chatTitle(store, chat) : SEARCH_COPY.newChat,
    timeText: ago(hit.at, now),
    senderText: memberLabel(store, hit.from),
    excerpt: markWords(hit.excerpt, query),
  }
}

/** What to say under the results: still looking, couldn't, nothing, that only the newest came back, and what's left out. */
function searchNote(query: string, search: MessageSearch, anyResults: boolean): string {
  switch (search.kind) {
    case 'searching': return SEARCH_COPY.searching
    case 'failed': return `Couldn’t search messages: ${search.reason}`
    case 'found': {
      return [
        ...(anyResults ? [] : [`Nothing matches “${query.trim()}”.`]),
        ...(search.page.more ? [SEARCH_COPY.newestOnly] : []),
        SEARCH_COPY.archivedLeftOut,
      ].join('\n\n')
    }
  }
}

/** `text` cut at the query's words, in any case, to mark them. */
export function markWords(text: string, query: string): MarkedPart[] {
  const words = queryWords(query).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return [{ text, marked: false }]
  // Longest first, so a word containing another is marked whole.
  const pattern = new RegExp(`(${words.sort((x, y) => y.length - x.length).join('|')})`, 'giu')
  return text.split(pattern).map((part, index) => ({ text: part, marked: index % 2 === 1 })).filter((part) => part.text)
}
