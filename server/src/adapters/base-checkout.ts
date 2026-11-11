// Bases in the person's own copy of the source. A base is the commit its tag `base-<n>` points to, in the base repository's
// own history, which the person's source shares. `ouro-base` tracks the newest base commit fetched; the person's branch
// merges it, so the base it has is the highest tag in its history. A base is merged in a worktree beside the live checkout,
// so nobody's uncommitted work or running agent is in the way, and the person's branch moves only after the merge is
// live. Merged, never rebased: a rebase would lose the link to the base.
import { existsSync } from 'node:fs'
import { git, gitTry, lastLines, refExists } from './git.ts'

const BASE_BRANCH = 'ouro-base'
const BASE_TAG_NAME = /^base-([1-9][0-9]*)$/
const OURO_IDENTITY = ['-c', 'user.name=Ouro', '-c', 'user.email=ouro@localhost']

const updateBranchOf = (n: number) => `ouro-update/${n}`

/** Where base `n` is merged: a worktree beside the person's checkout. */
export const besideDirOf = (root: string, n: number): string => `${root}.base-update-${n}`

/** The highest base whose tag is in `commit`'s history; 0 when none, as before bases or when the tags aren't fetched. */
function baseNumberAt(root: string, commit: string): number {
  const tags = gitTry(root, 'tag', '--merged', commit, '--list', 'base-*')
  if (!tags.ok) return 0
  return Math.max(0, ...tags.output.split('\n').map((name) => BASE_TAG_NAME.exec(name.trim())).flatMap((match) => (match ? [Number(match[1])] : [])))
}

/** The branch the person's checkout has out: bases merge into it. */
function personBranchOf(root: string): string {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') throw new Error(`${root} has no branch out, so there is nothing to merge a base into`)
  return branch
}

/** The base the person's branch has merged; null when this copy takes no bases, having no `ouro-base`. */
export function integratedBase(root: string): number | null {
  return refExists(root, `refs/heads/${BASE_BRANCH}`) ? baseNumberAt(root, 'HEAD') : null
}

/** The newest base `ouro-base` has, merged or not. */
export const receivedBase = (root: string): number => baseNumberAt(root, BASE_BRANCH)

/** Whether `commit` is in the person's branch already, as a computer made from a base starts: not by merging it. */
export const branchHas = (root: string, commit: string): boolean => gitTry(root, 'merge-base', '--is-ancestor', commit, 'HEAD').ok

/** Moves `ouro-base` to base `n`'s commit, once its tag is fetched. The person's branch isn't touched. */
export function trackBase(root: string, n: number): void {
  const commit = gitTry(root, 'rev-parse', '--verify', `refs/tags/base-${n}^{commit}`)
  if (!commit.ok) throw new Error(`base ${n}'s tag isn't in ${root}`)
  git(root, 'update-ref', `refs/heads/${BASE_BRANCH}`, commit.output)
}

export type BaseMerge = { kind: 'merged' } | { kind: 'conflicted'; files: string[] }

/** Merges `ouro-base` into a new branch from the person's, beside the live checkout. Conflicts are left there to resolve. */
export function mergeBeside(root: string, n: number): BaseMerge {
  const dir = besideDirOf(root, n)
  git(root, 'worktree', 'add', '-q', '-B', updateBranchOf(n), dir, personBranchOf(root))
  const merged = gitTry(dir, ...OURO_IDENTITY, 'merge', '-q', '--no-edit', '-m', `Merge Ouro base ${n}`, BASE_BRANCH)
  if (merged.ok) return { kind: 'merged' }
  const files = unmergedFiles(dir)
  if (files.length === 0) {
    removeBeside(root, n)
    throw new Error(`merging base ${n} failed: ${lastLines(merged.output)}`)
  }
  return { kind: 'conflicted', files }
}

const unmergedFiles = (dir: string): string[] => git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)

/** Whether base `n` is merged beside the live checkout already, from an earlier attempt. */
export const isMergedBeside = (root: string, n: number): boolean =>
  existsSync(besideDirOf(root, n)) && unfinishedMergeIn(besideDirOf(root, n)) === null && gitTry(besideDirOf(root, n), 'merge-base', '--is-ancestor', BASE_BRANCH, 'HEAD').ok

/** What the merge beside the live checkout still lacks before it can go live, or null when it is committed. */
export function unfinishedMergeIn(dir: string): string | null {
  if (!existsSync(dir)) return `${dir} is gone`
  const files = unmergedFiles(dir)
  if (files.length > 0) return `still conflicted in ${dir}: ${files.join(', ')}`
  if (gitTry(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok) return `the merge in ${dir} isn't committed yet: commit it, then ouro base continue`
  return null
}

/**
 * The commit to put live: the merge beside, with whatever the person's branch gained meanwhile merged in too, so going live
 * loses nothing. Throws if that no longer merges.
 */
export function commitToDeploy(root: string, n: number): string {
  const dir = besideDirOf(root, n)
  const branch = personBranchOf(root)
  if (!gitTry(dir, 'merge-base', '--is-ancestor', branch, 'HEAD').ok) {
    const merged = gitTry(dir, ...OURO_IDENTITY, 'merge', '-q', '--no-edit', branch)
    if (!merged.ok) {
      gitTry(dir, 'merge', '--abort')
      throw new Error(`${branch} moved on and no longer merges with base ${n}: ${lastLines(merged.output)}`)
    }
  }
  return git(dir, 'rev-parse', 'HEAD')
}

export type MainMerge = { kind: 'merged'; before: string } | { kind: 'not_merged'; why: string }

/** Moves the person's branch to the live commit: forward if it can, otherwise by a merge. */
export function mergeIntoPersonBranch(root: string, commit: string): MainMerge {
  const before = git(root, 'rev-parse', 'HEAD')
  if (gitTry(root, 'merge', '-q', '--ff-only', commit).ok) return { kind: 'merged', before }
  const merged = gitTry(root, ...OURO_IDENTITY, 'merge', '-q', '--no-edit', commit)
  if (merged.ok) return { kind: 'merged', before }
  gitTry(root, 'merge', '--abort')
  return { kind: 'not_merged', why: lastLines(merged.output) }
}

/** Whether `folder` (relative to the root) differs between two commits. */
export const changedBetween = (root: string, from: string, to: string, folder: string): boolean => !gitTry(root, 'diff', '--quiet', from, to, '--', folder).ok

export function removeBeside(root: string, n: number): void {
  gitTry(root, 'worktree', 'remove', '--force', besideDirOf(root, n))
  gitTry(root, 'branch', '-D', updateBranchOf(n))
}
