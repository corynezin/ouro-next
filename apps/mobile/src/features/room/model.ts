// A chat room as data: its header, who said each message, and what the bottom of the screen offers. Pure.
import type { ChatEntity, MessageEntity } from '@ouro/contract'
import type { NewSend } from '../../core/session/outbox.ts'
import { memberLabel } from '../shared/agentFacts.ts'
import type { StoreView } from '../shared/agentFacts.ts'
import { chatTitle, isMember } from '../chats/model.ts'

export function roomHeader(store: StoreView, chat: ChatEntity): { title: string; subtitle: string } {
  const count = chat.members.length
  const notIn = isMember(chat, store.viewer?.address) ? '' : ' · you aren’t in it'
  return {
    title: chatTitle(store, chat),
    subtitle: chat.kind === 'direct' ? 'Direct chat' : `${count} member${count === 1 ? '' : 's'}${notIn}`,
  }
}

/** The bottom of the room: a composer for members, a way in for a group you aren't in, nothing for others' direct chats. */
export type RoomFooter =
  | { kind: 'composer'; placeholder: string }
  | { kind: 'members_only' }
  | { kind: 'reading_others' }

export function roomFooter(store: StoreView, chat: ChatEntity): RoomFooter {
  if (isMember(chat, store.viewer?.address)) return { kind: 'composer', placeholder: `Message ${chatTitle(store, chat)}` }
  return chat.kind === 'direct' ? { kind: 'reading_others' } : { kind: 'members_only' }
}

export const ROOM_COPY = {
  empty: 'No messages yet.',
  membersOnly: 'Only members can post here.',
  readingOthers: 'You’re reading someone else’s chat.',
  join: 'Join',
  joining: 'Joining…',
} as const

/**
 * Under your post to a chat whose home is another computer, until the home has it: posts there go through it. The sync
 * stream brings the change, so nothing polls for it.
 */
export function homeDeliveryNote(store: StoreView, chat: ChatEntity, message: MessageEntity): string | null {
  const thisMachine = store.server?.machineName ?? null
  if (thisMachine === null || chat.homeMachine === thisMachine || message.from !== store.viewer?.address) return null
  return message.remoteDeliveries.some((delivery) => delivery.state.state === 'queued') ? `◌ on its way to ${chat.homeMachine}` : null
}

/** The name over someone else's message; none over yours. */
export const senderLabel = (store: StoreView, from: string) => (from === store.viewer?.address ? undefined : memberLabel(store, from))

/** A post to a group: text only. Its conversation is the chat. */
export const groupSend = (chat: ChatEntity, text: string): NewSend => ({
  destination: { kind: 'group', chatId: chat.id }, conversationId: chat.id, text, attachments: [],
})
