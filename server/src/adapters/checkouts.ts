// What git says about an agent's folder, and git's three-way merge of a text. Runs `git`, briefly and synchronously.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CheckoutIdentity } from '../domain/memory.ts'

const GIT_TIMEOUT_MS = 10_000

function git(cwd: string, ...args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).toString().trim()
    return output === '' ? null : output
  } catch {
    return null
  }
}

/** Null: not in a git checkout. */
export function checkoutIdentityOf(folder: string): CheckoutIdentity | null {
  if (git(folder, 'rev-parse', '--is-inside-work-tree') !== 'true') return null
  return {
    originUrl: git(folder, 'config', '--get', 'remote.origin.url'),
    rootCommit: git(folder, 'rev-list', '--max-parents=0', 'HEAD')?.split('\n').pop() ?? null,
  }
}

/** The main checkout a worktree belongs to; the folder itself for a main checkout. */
export function mainCheckoutOf(folder: string): string | null {
  const common = git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return common !== null && basename(common) === '.git' ? dirname(common) : null
}

/** `ours` and `theirs`, both edited from `base`, merged; null when the edits overlap. */
export function mergeThreeWay(ours: string, base: string, theirs: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-merge-'))
  try {
    writeFileSync(join(dir, 'ours'), ours)
    writeFileSync(join(dir, 'base'), base)
    writeFileSync(join(dir, 'theirs'), theirs)
    // Exits with the number of conflicts, so any failure is "doesn't merge".
    return execFileSync('git', ['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).toString()
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
