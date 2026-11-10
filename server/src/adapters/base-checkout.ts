// Bases in the person's own copy of the source. Each base arrives as a commit on `ouro-base`, the bases alone, unchanged;
// the person's branch merges them, so the base it has is the newest one their branch and `ouro-base` share. A base is
// merged in a worktree beside the live checkout, so nobody's uncommitted work or running agent is in the way, and the
// person's branch moves only after the merge is live. Merged, never rebased: a rebase would lose the link to the base.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { git, gitTry, lastLines, refExists } from './git.ts'

const BASE_BRANCH = 'ouro-base'
const BASE_TRAILER = 'Ouro-Base'
const OURO_IDENTITY = ['-c', 'user.name=Ouro', '-c', 'user.email=ouro@localhost']

const updateBranchOf = (n: number) => `ouro-update/${n}`

/** Where base `n` is merged: a worktree beside the person's checkout. */
export const besideDirOf = (root: string, n: number): string => `${root}.base-update-${n}`

const baseNumberAt = (root: string, commit: string): number => Number(git(root, 'log', '-1', `--format=%(trailers:key=${BASE_TRAILER},valueonly)`, commit).trim() || 0)

/** The branch the person's checkout has out: bases merge into it. */
function personBranchOf(root: string): string {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') throw new Error(`${root} has no branch out, so there is nothing to merge a base into`)
  return branch
}

/** The base the person's branch has merged; null when this copy takes no bases, having no `ouro-base`. */
export function integratedBase(root: string): number | null {
  if (!refExists(root, `refs/heads/${BASE_BRANCH}`)) return null
  const shared = gitTry(root, 'merge-base', 'HEAD', BASE_BRANCH)
  return shared.ok ? baseNumberAt(root, shared.output) : 0
}

/** The newest base committed to `ouro-base`, merged or not. */
export const receivedBase = (root: string): number => baseNumberAt(root, BASE_BRANCH)

/**
 * The git tree of the files in `dir`, exactly as they are: ignore rules don't apply, since a base's files are all its own.
 * Its objects are written into `root`'s repository. Equal files make an equal tree on any machine, so it names a base.
 */
export function treeHashOf(root: string, dir: string): string {
  const indexDir = mkdtempSync(join(tmpdir(), 'ouro-base-index-'))
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir')
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index'), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    const added = spawnSync('git', ['--git-dir', gitDir, '--work-tree', dir, 'add', '-A', '-f', '.'], { cwd: dir, env, encoding: 'utf8' })
    if (added.status !== 0) throw new Error(`git couldn't read the files in ${dir}: ${lastLines(`${added.stdout}\n${added.stderr}`)}`)
    const tree = spawnSync('git', ['--git-dir', gitDir, 'write-tree'], { env, encoding: 'utf8' })
    if (tree.status !== 0) throw new Error(`git couldn't write the tree of ${dir}: ${lastLines(tree.stderr)}`)
    return tree.stdout.trim()
  } finally {
    rmSync(indexDir, { recursive: true, force: true })
  }
}

/**
 * Commits base `n`'s files, as they are in `treeDir`, onto `ouro-base`, once they are checked to be the ones published as
 * `treeHash`. The person's branch isn't touched.
 */
export function commitBase(root: string, n: number, treeDir: string, treeHash: string): void {
  const tree = treeHashOf(root, treeDir)
  if (tree !== treeHash) throw new Error(`base ${n}'s files aren't the ones published: their tree is ${tree}, not ${treeHash}`)
  const parent = git(root, 'rev-parse', BASE_BRANCH)
  const commit = git(root, ...OURO_IDENTITY, 'commit-tree', tree, '-p', parent, '-m', `Ouro base ${n}`, '-m', `${BASE_TRAILER}: ${n}`)
  git(root, 'update-ref', `refs/heads/${BASE_BRANCH}`, commit, parent)
}

export type BranchExport = { kind: 'exported'; commit: string } | { kind: 'uncommitted'; files: string[] }

/**
 * Exports the person's branch, as committed, into the empty folder `into`: what a publisher makes a base from. Refuses
 * while tracked files have uncommitted changes, which the base would silently leave out.
 */
export function exportPersonBranch(root: string, into: string): BranchExport {
  const files = git(root, 'diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
  if (files.length > 0) return { kind: 'uncommitted', files }
  const archive = join(into, '..', `${basename(into)}.tar`)
  const commit = git(root, 'rev-parse', personBranchOf(root))
  try {
    git(root, 'archive', '--format=tar', '-o', archive, commit)
    const extracted = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error(`couldn't unpack ${archive}: ${lastLines(extracted.stderr)}`)
  } finally {
    rmSync(archive, { force: true })
  }
  return { kind: 'exported', commit }
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
