// Archived agents, newest first. An archived name another agent has taken can't come back under it.
import type { AgentEntity } from '@ouro/contract'
import { dateTimeOf } from '../../design/format.ts'
import { isArchived } from '../shared/agentFacts.ts'
import type { StoreView } from '../shared/agentFacts.ts'

export interface ArchivedRow { agentId: string; name: string; dateText: string; detail: string | null; nameInUse: boolean }

const archivedAt = (agent: AgentEntity) => agent.state.since

export function archivedRows(store: StoreView): ArchivedRow[] {
  const all = [...store.agents.values()]
  const namesInUse = new Set(all.filter((agent) => !isArchived(agent)).map((agent) => agent.name))
  return all.filter(isArchived).sort((x, y) => archivedAt(y) - archivedAt(x)).map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    dateText: dateTimeOf(archivedAt(agent)),
    // Its latest summary says what it did; the task, what it was for (ARC-02).
    detail: store.summaries.get(agent.id)?.latest?.line ?? (agent.task.trim() || null),
    nameInUse: namesInUse.has(agent.name),
  }))
}

export const unarchivedNote = (name: string) => `${name} is back (stopped; a message wakes it)`
