// A chat's details as data: when and by whom it was made, where it lives, its members, and who can be removed. A direct
// chat keeps its two members for good. Pure: Screen.tsx only draws this.
import { parseAddress } from '@ouro/contract'
import type { ChatEntity } from '@ouro/contract'
import { dateTimeOf } from '../../design/format.ts'
import { listedAgents, memberLabel } from '../shared/agentFacts.ts'
import type { StoreView } from '../shared/agentFacts.ts'

export const CHAT_INFO_COPY = {
  gone: 'This chat isn’t here any more.',
  removeMessage: 'What was said stays in the chat.',
  add: 'Add people or agents',
} as const

export interface MemberRemoval { buttonLabel: string; confirmTitle: string; confirmAction: 'Leave' | 'Remove' }

export interface MemberRowModel {
  address: string
  label: string
  isPerson: boolean
  /** Null in a direct chat. */
  removal: MemberRemoval | null
}

export interface ChatInfoModel {
  facts: string[]
  membersTitle: string
  members: MemberRowModel[]
  canAddMembers: boolean
}

export function chatInfoModel(store: StoreView, chat: ChatEntity): ChatInfoModel {
  const isGroup = chat.kind === 'group'
  const thisMachine = store.server?.machineName
  const facts = [`Created by ${memberLabel(store, chat.createdBy)} · ${dateTimeOf(chat.createdAt)}`]
  if (thisMachine !== undefined && chat.homeMachine !== thisMachine) facts.push(`Lives on ${chat.homeMachine}`)
  return {
    facts,
    membersTitle: `Members (${chat.members.length})`,
    members: chat.members.map(({ address }) => ({
      address,
      label: memberLabel(store, address),
      isPerson: parseAddress(address).kind !== 'agent',
      removal: isGroup ? removalOf(store, address) : null,
    })),
    canAddMembers: isGroup,
  }
}

function removalOf(store: StoreView, address: string): MemberRemoval {
  if (address === store.viewer?.address) return { buttonLabel: 'Leave', confirmTitle: 'Leave this chat?', confirmAction: 'Leave' }
  const label = memberLabel(store, address)
  return { buttonLabel: `Remove ${label}`, confirmTitle: `Remove ${label}?`, confirmAction: 'Remove' }
}

/** A member's page: an agent this server lists has its details; anyone else, the person page. */
export type MemberDestination = { screen: 'Agent'; agentRef: string } | { screen: 'Person'; address: string }
export function memberDestination(store: StoreView, address: string): MemberDestination {
  const agent = listedAgents(store).find((candidate) => candidate.name === address)
  return agent ? { screen: 'Agent', agentRef: agent.id } : { screen: 'Person', address }
}
