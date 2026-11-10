// Taking a base: where an update stands, as stored, and what may start or continue one. Pure.
import type { BaseOffer, BaseUpdate } from '@ouro/contract'

/**
 * Where a base update stands. `merging`: fetching base `n` and merging it beside the live source, or carrying on after a
 * conflict. `deploying`: the guardian is building, checking and switching to `commit`, the merge, as `deploymentId`.
 */
export type BaseUpdateRecord =
  | { state: 'idle' }
  | { state: 'merging'; n: number }
  | { state: 'conflict'; n: number; files: string[] }
  | { state: 'deploying'; n: number; deploymentId: string; commit: string }
  | { state: 'failed'; n: number; why: string }

export const NO_BASE_UPDATE: BaseUpdateRecord = { state: 'idle' }

export function baseUpdateOf(record: BaseUpdateRecord): BaseUpdate {
  switch (record.state) {
    case 'idle': return { state: 'idle' }
    case 'merging':
    case 'deploying': return { state: 'updating', n: record.n }
    case 'conflict': return { state: 'conflict', n: record.n, files: record.files }
    case 'failed': return { state: 'failed', n: record.n, why: record.why }
  }
}

export type BaseUpdateRefusal =
  | { code: 'base_not_offered'; message: string }
  | { code: 'base_update_in_progress'; message: string }
  | { code: 'base_conflict_unresolved'; message: string }

/** Why base `n` can't be taken now, or null. A failed update can be taken again; the merge beside it is kept. */
export function takeRefusal(record: BaseUpdateRecord, offered: BaseOffer | null, n: number): BaseUpdateRefusal | null {
  if (record.state === 'merging' || record.state === 'deploying') return { code: 'base_update_in_progress', message: `base ${record.n} is being taken now` }
  if (record.state === 'conflict') return { code: 'base_update_in_progress', message: `base ${record.n} is waiting on its conflicts: resolve them, then ouro base continue` }
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

/** What the master agent is told when a base and the person's changes touch the same files. */
export function conflictBrief(n: number, notes: string, files: string[], besideDir: string): string {
  return `Ouro base ${n} conflicts with this computer's own changes in: ${files.join(', ')}. Nothing live has changed. What the base changes: ${notes}\n`
    + `Resolve it in ${besideDir}, a worktree with the merge in progress. Rule: keep what the person's change was for, and take the base's change. `
    + 'If both can\'t stand, ask the person with choices (keep mine / take Ouro\'s / keep both), saying in one line what each loses. '
    + 'Leave no conflict markers. Commit the merge there, then run: ouro base continue'
}
