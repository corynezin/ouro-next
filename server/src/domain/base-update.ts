// Taking a base: where an update stands, as stored, and what may start or continue one. Pure.
import { MASTER_AGENT_NAME } from '@ouro/contract'
import type { BaseOffer, BaseUpdate } from '@ouro/contract'

/**
 * Where a base update stands. `merging`: fetching base `n` and merging it beside the live source, or carrying on after a
 * conflict. `conflict`: the base and the person's changes touch the same `files`; the merge waits beside the live source
 * until the person has an agent resolve it, `resolver` (null until then; absent in records from before the choice, which
 * went to the master agent at once), or drops it. `deploying`: the guardian is building, checking and switching to
 * `commit`, the merge, as `deploymentId`.
 */
export type BaseUpdateRecord =
  | { state: 'idle' }
  | { state: 'merging'; n: number }
  | { state: 'conflict'; n: number; files: string[]; notes?: string; resolver?: string | null }
  | { state: 'deploying'; n: number; deploymentId: string; commit: string }
  | { state: 'failed'; n: number; why: string }

export const NO_BASE_UPDATE: BaseUpdateRecord = { state: 'idle' }

export function baseUpdateOf(record: BaseUpdateRecord): BaseUpdate {
  switch (record.state) {
    case 'idle': return { state: 'idle' }
    case 'merging':
    case 'deploying': return { state: 'updating', n: record.n }
    case 'conflict': return { state: 'conflict', n: record.n, files: record.files, resolver: resolverOf(record) }
    case 'failed': return { state: 'failed', n: record.n, why: record.why }
  }
}

/** The agent resolving a conflict, or null while the person hasn't chosen. Older records went to the master agent at once. */
const resolverOf = (record: Extract<BaseUpdateRecord, { state: 'conflict' }>): string | null =>
  record.resolver === undefined ? MASTER_AGENT_NAME : record.resolver

export type BaseUpdateRefusal =
  | { code: 'base_not_offered'; message: string }
  | { code: 'base_update_in_progress'; message: string }
  | { code: 'base_conflict_unresolved'; message: string }

/** Why base `n` can't be taken now, or null. A failed update can be taken again; the merge beside it is kept. */
export function takeRefusal(record: BaseUpdateRecord, offered: BaseOffer | null, n: number): BaseUpdateRefusal | null {
  if (record.state === 'merging' || record.state === 'deploying') return { code: 'base_update_in_progress', message: `base ${record.n} is being taken now` }
  if (record.state === 'conflict') {
    return { code: 'base_update_in_progress', message: resolverOf(record) === null
      ? `base ${record.n} is waiting on its conflicts: have the master agent merge them (ouro base resolve) or drop it (ouro base drop)`
      : `base ${record.n} is waiting on its conflicts: resolve them, then ouro base continue, or drop it (ouro base drop)` }
  }
  if (offered === null) return { code: 'base_not_offered', message: 'no newer base is offered to this machine' }
  if (offered.n !== n) return { code: 'base_not_offered', message: `base ${offered.n} is the one offered, not ${n}` }
  return null
}

export type ContinueDecision = { kind: 'continues'; n: number } | { kind: 'refused'; refusal: BaseUpdateRefusal }

/**
 * Whether a conflicted update carries on. `unresolvedIn(n)`: what the merge of base `n` beside the live source still lacks,
 * or null once it is resolved and committed.
 */
export function continueDecision(record: BaseUpdateRecord, unresolvedIn: (n: number) => string | null): ContinueDecision {
  if (record.state !== 'conflict') return { kind: 'refused', refusal: { code: 'base_conflict_unresolved', message: 'no base update is waiting on conflicts' } }
  const unresolved = unresolvedIn(record.n)
  if (unresolved !== null) return { kind: 'refused', refusal: { code: 'base_conflict_unresolved', message: unresolved } }
  return { kind: 'continues', n: record.n }
}

export type ResolveDecision = { kind: 'goes_ahead'; n: number; files: string[]; notes: string } | { kind: 'refused'; refusal: BaseUpdateRefusal }

/** Whether the master agent can be told to resolve a conflicted update: only while no agent has been. */
export function resolveDecision(record: BaseUpdateRecord): ResolveDecision {
  const conflict = waitingConflict(record)
  if (conflict.kind === 'refused') return conflict
  const { n, files, notes, resolver } = conflict
  if (resolver !== null) return { kind: 'refused', refusal: { code: 'base_update_in_progress', message: `an agent, ${resolver}, is resolving base ${n} already` } }
  return { kind: 'goes_ahead', n, files, notes }
}

/**
 * Whether a conflicted update can be dropped, its merge thrown away. Always, even while an agent is resolving it: the
 * agent may have stalled or the person changed their mind, and nothing else lets them out. `stopping` is that agent, to be
 * told to stop, or null when none was on it.
 */
export type DropDecision = { kind: 'goes_ahead'; n: number; stopping: string | null } | { kind: 'refused'; refusal: BaseUpdateRefusal }

export function dropDecision(record: BaseUpdateRecord): DropDecision {
  const conflict = waitingConflict(record)
  if (conflict.kind === 'refused') return conflict
  return { kind: 'goes_ahead', n: conflict.n, stopping: conflict.resolver }
}

type WaitingConflict =
  | { kind: 'conflict'; n: number; files: string[]; notes: string; resolver: string | null }
  | { kind: 'refused'; refusal: BaseUpdateRefusal }

function waitingConflict(record: BaseUpdateRecord): WaitingConflict {
  if (record.state !== 'conflict') return { kind: 'refused', refusal: { code: 'base_conflict_unresolved', message: 'no base update is waiting on conflicts' } }
  return { kind: 'conflict', n: record.n, files: record.files, notes: record.notes ?? '', resolver: resolverOf(record) }
}

/** What the agent resolving base `n` is told when the person drops it instead. */
export function droppedBrief(n: number): string {
  return `Ouro base ${n} was dropped: the person chose not to take it now, and its merge was thrown away. Stop resolving its conflicts; there is nothing more to do for it.`
}

/** What the owner is told when base `n` conflicts and waits for their choice, so an app without the buttons still says how. */
export function conflictWaitingNotice(n: number, files: string[]): string {
  return `Ouro base ${n} conflicts with this computer's own changes in ${files.join(', ')}. Nothing live has changed. `
    + 'Choose in Settings under Updates (an app from before this choice has no buttons for it), or run: '
    + 'ouro base resolve to have your master agent merge it, or ouro base drop to leave it for now.'
}

/** What the master agent is told, once the person asks it to merge, when a base and their changes touch the same files. */
export function conflictBrief(n: number, notes: string, files: string[], besideDir: string): string {
  return `Ouro base ${n} conflicts with this computer's own changes in: ${files.join(', ')}. Nothing live has changed. What the base changes: ${notes}\n`
    + `Resolve it in ${besideDir}, a worktree with the merge in progress. Rule: keep what the person's change was for, and take the base's change. `
    + 'If both can\'t stand, ask the person with choices (keep mine / take Ouro\'s / keep both), saying in one line what each loses. '
    + 'Leave no conflict markers. Commit the merge there, then run: ouro base continue'
}
