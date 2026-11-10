// An agent's details as rows. Pure: Screen.tsx only draws this.
import type { AgentEntity, BranchMerge } from '@ouro/contract'
import { ago, dateStampOf, money } from '../../design/format.ts'
import { isBeforeLatestTurn, isBusy, memberLabel, stateOf, statusLine } from '../shared/agentFacts.ts'
import type { StoreView } from '../shared/agentFacts.ts'
import { agentUsageText } from '../shared/planUsage.ts'

export const DETAILS_COPY = {
  modelFooter: 'Applies from its next start; it keeps its context.',
  staleSummary: 'before its latest turn',
  earlierSummaries: 'Earlier summaries',
  noChats: 'None yet',
} as const

export interface DetailRow { label: string; value: string; monospaced: boolean }

const row = (label: string, value: string | null, monospaced = false): DetailRow[] => (value ? [{ label, value, monospaced }] : [])

export interface DetailsModel {
  rows: DetailRow[]
  doneSummary: string | null
  lately: { title: string; line: string; details: readonly string[]; stale: boolean } | null
  task: string
  chats: { chatId: string; title: string }[]
  canInterrupt: boolean
  canStop: boolean
  /** Its branch while it can be merged: it has one and isn't running. */
  mergeable: { branch: string; base: string } | null
}

export function detailsModel(store: StoreView, agent: AgentEntity, now: number): DetailsModel {
  const viewer = store.viewer?.address
  const running = stateOf(agent) === 'running'
  const summary = store.summaries.get(agent.id)?.latest ?? null
  const chats = [...store.chats.values()]
    .filter((chat) => chat.members.some((member) => member.address === agent.name))
    .map((chat) => ({ chatId: chat.id, title: chat.title ?? chatMembersText(store, chat.members, agent.name) }))
  return {
    rows: [
      ...row('State', stateOf(agent)),
      ...row('Now', statusLine(agent, store.goals.get(agent.id), viewer, now)),
      ...row('Usage', agentUsageText(agent)),
      ...row('Created by', memberLabel(store, agent.createdBy)),
      ...row('Reports to', memberLabel(store, agent.parent)),
      ...row('Folder', agent.folder, true),
      ...row('Branch', agent.branch && `${agent.branch.name} → ${agent.branch.base}`, true),
      ...row('Started', dateStampOf(agent.createdAt)),
      ...row('Waiting messages', agent.queuedDeliveries > 0 ? String(agent.queuedDeliveries) : null),
    ],
    doneSummary: agent.state.state === 'done' ? agent.state.summary : null,
    lately: summary && {
      title: `Lately · ${ago(summary.at, now)}`,
      line: summary.line,
      details: summary.details,
      stale: isBeforeLatestTurn(agent, summary.coversThroughAt),
    },
    task: agent.task.trim() || '—',
    chats,
    canInterrupt: running && isBusy(agent),
    canStop: running,
    mergeable: running ? null : agent.branch && { branch: agent.branch.name, base: agent.branch.base },
  }
}

/** What merging did. A conflict is left where it is, so the words say nothing was forced. */
export function branchMergeText(merge: BranchMerge): string {
  switch (merge.kind) {
    case 'merged': return merge.how === 'rebase'
      ? `Rebased ${merge.branch} onto ${merge.base} and merged it.`
      : `Merged ${merge.branch} into ${merge.base}.`
    case 'nothing_to_merge': return `Nothing to merge: ${merge.base} already has ${merge.branch}.`
    case 'not_merged': return `Not merged: ${merge.why}`
  }
}

/** An untitled chat reads as who else is in it. */
function chatMembersText(store: StoreView, members: readonly { address: string }[], agentName: string) {
  return members.filter((member) => member.address !== agentName).map((member) => memberLabel(store, member.address)).join(', ')
}

/** How many screens on top of the stack are about this agent, to leave them all after archiving it. */
export function screensAboutAgent(routes: readonly { params?: object | undefined }[], agentIds: { id: string; name: string }) {
  let count = 0
  for (let index = routes.length - 1; index > 0; index--) {
    const params = routes[index]!.params
    const ref = params && 'agentRef' in params ? params.agentRef : null
    if (ref !== agentIds.id && ref !== agentIds.name) break
    count++
  }
  return Math.max(1, count)
}
