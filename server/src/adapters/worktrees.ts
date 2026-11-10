// Agent worktrees in git: made beside a project's main checkout, merged back into the branch they started from, and
// removed once merged.
import { existsSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { BranchMerge } from '@ouro/contract'
import type { AgentWorktree } from '../domain/worktree.ts'
import { git, gitTry, lastLines, refExists } from './git.ts'

/**
 * The top of the project holding `folder`, and where in it the folder is, looking from its nearest existing ancestor;
 * null outside one. A folder the project ignores, such as a data directory inside it, isn't part of it.
 */
function projectHolding(folder: string): { root: string; subfolder: string } | null {
  const wanted = resolve(folder)
  let existing = wanted
  while (!existsSync(existing)) {
    if (dirname(existing) === existing) return null
    existing = dirname(existing)
  }
  const real = join(realpathSync(existing), relative(existing, wanted))
  const top = gitTry(existing, 'rev-parse', '--show-toplevel')
  if (!top.ok || top.output === '') return null
  const root = realpathSync(top.output)
  if (real !== root && !real.startsWith(root + sep)) return null
  const subfolder = relative(root, real)
  if (subfolder !== '' && gitTry(root, 'check-ignore', '-q', subfolder).ok) return null
  return { root, subfolder }
}

/** A main checkout's `.git` is a directory; a linked worktree's is a file. */
function isMainCheckout(repo: string): boolean {
  try {
    return statSync(join(repo, '.git')).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where an agent named `agentName`, asked to work in `folder`, actually works. Inside a main checkout, that is its own
 * new worktree on `agent/<name>` (keeping any subfolder); anywhere else, including inside another agent's worktree, it is
 * `folder` itself. A branch or folder left by an earlier agent of the same name, still unmerged, is never reused.
 */
export function placeAgent(agentName: string, agentId: string, folder: string): { folder: string; worktree: AgentWorktree | null } {
  const project = projectHolding(folder)
  if (project === null || !isMainCheckout(project.root)) return { folder, worktree: null }
  const repo = project.root
  const worktreesDir = join(dirname(repo), `.${basename(repo)}.worktrees`)
  const leftOver = refExists(repo, `refs/heads/agent/${agentName}`) || existsSync(join(worktreesDir, agentName))
  const label = leftOver ? `${agentName}-${agentId}` : agentName
  const branch = `agent/${label}`
  const dir = join(worktreesDir, label)
  const head = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const base = head === 'HEAD' ? git(repo, 'rev-parse', 'HEAD') : head
  const added = gitTry(repo, 'worktree', 'add', '-b', branch, dir, base)
  if (!added.ok) {
    gitTry(repo, 'branch', '-D', branch)
    rmSync(dir, { recursive: true, force: true })
    gitTry(repo, 'worktree', 'prune')
    throw new Error(`could not make a worktree for ${agentName} in ${repo}: ${lastLines(added.output)}`)
  }
  // node_modules isn't committed: the main checkout's saves the agent installing from scratch.
  if (existsSync(join(repo, 'node_modules')) && !existsSync(join(dir, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'))
  return { folder: project.subfolder === '' ? dir : join(dir, project.subfolder), worktree: { repo, dir, branch, base } }
}

/**
 * Merges the agent's branch into its base in the main checkout: a fast-forward, after rebasing the branch in the agent's
 * worktree if the base moved on. Only when the main checkout has the base out, so the merge updates its files and
 * nobody's other branch moves under them. A failed rebase is aborted and the branch left as it was.
 */
export function mergeAgentBranch(worktree: AgentWorktree): BranchMerge {
  const { repo, dir, branch, base } = worktree
  const named = { branch, base }
  if (!refExists(repo, `refs/heads/${branch}`)) return { kind: 'nothing_to_merge', ...named }
  if (!refExists(repo, `refs/heads/${base}`)) {
    const why = /^[0-9a-f]{40,64}$/.test(base) ? `it started from a detached checkout at ${base.slice(0, 12)}, with no branch to merge into` : `${base} no longer exists`
    return { kind: 'not_merged', ...named, why }
  }
  const baseTip = git(repo, 'rev-parse', `refs/heads/${base}`)
  const branchTip = git(repo, 'rev-parse', `refs/heads/${branch}`)
  if (gitTry(repo, 'merge-base', '--is-ancestor', branchTip, baseTip).ok) return { kind: 'nothing_to_merge', ...named }
  const checkedOut = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (checkedOut !== base) return { kind: 'not_merged', ...named, why: `the main checkout ${repo} has ${checkedOut === 'HEAD' ? 'a detached HEAD' : checkedOut} out, not ${base}` }

  const baseIsAncestor = gitTry(repo, 'merge-base', '--is-ancestor', baseTip, branchTip).ok
  if (!baseIsAncestor) {
    if (!existsSync(dir)) return { kind: 'not_merged', ...named, why: `${base} moved on and the worktree to rebase in, ${dir}, is gone` }
    const rebased = gitTry(dir, 'rebase', base)
    if (!rebased.ok) {
      gitTry(dir, 'rebase', '--abort')
      return { kind: 'not_merged', ...named, why: `rebasing it onto ${base} conflicted:\n${lastLines(rebased.output)}` }
    }
  }
  const merged = gitTry(repo, 'merge', '--ff-only', branch)
  if (!merged.ok) return { kind: 'not_merged', ...named, why: `the fast-forward failed:\n${lastLines(merged.output)}` }
  return { kind: 'merged', ...named, how: baseIsAncestor ? 'fast_forward' : 'rebase' }
}

export type WorktreeRemoval = { kind: 'removed' } | { kind: 'kept'; why: string }

/**
 * Removes a merged agent's worktree, and its branch when that holds nothing the base lacks. A worktree with changes not
 * committed is kept: they exist nowhere else.
 */
export function removeAgentWorktree(worktree: AgentWorktree): WorktreeRemoval {
  if (existsSync(worktree.dir)) {
    const status = gitTry(worktree.dir, 'status', '--porcelain')
    const uncommitted = status.output.split('\n').filter((line) => line !== '' && line !== '?? node_modules')
    if (!status.ok || uncommitted.length > 0) return { kind: 'kept', why: `${worktree.dir} has changes not committed` }
  }
  gitTry(worktree.repo, 'worktree', 'remove', '--force', worktree.dir)
  rmSync(worktree.dir, { recursive: true, force: true })
  gitTry(worktree.repo, 'worktree', 'prune')
  if (gitTry(worktree.repo, 'merge-base', '--is-ancestor', worktree.branch, worktree.base).ok) gitTry(worktree.repo, 'branch', '-D', worktree.branch)
  return { kind: 'removed' }
}
