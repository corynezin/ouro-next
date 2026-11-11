// The person's copy of the source and its private backup on GitHub. The backup is the git remote `backup`; that remote is the
// only record that there is one. Its tracking branch, which a push updates, says what was pushed.
import { execFile } from 'node:child_process'
import { git, gitTry, refExists } from './git.ts'

export const BACKUP_REMOTE = 'backup'
const PUSH_TIMEOUT_MS = 5 * 60_000
const BASE_BRANCH = 'ouro-base'

/** `owner/name` of the backup when its remote is on GitHub; the remote's URL otherwise. */
export function backupOf(root: string): string | null {
  const url = gitTry(root, 'remote', 'get-url', BACKUP_REMOTE)
  if (!url.ok) return null
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url.output)?.[1] ?? url.output
}

export function setBackupRemote(root: string, url: string): void {
  if (gitTry(root, 'remote', 'get-url', BACKUP_REMOTE).ok) git(root, 'remote', 'set-url', BACKUP_REMOTE, url)
  else git(root, 'remote', 'add', BACKUP_REMOTE, url)
}

/**
 * The commits on the branch out that no base has: not in any `base-<n>` tag's history or in `ouro-base`'s, merges not
 * counted. What a base update wouldn't bring back. Null when this copy takes no bases.
 */
export function commitsOnNoBase(root: string): number | null {
  if (!refExists(root, `refs/heads/${BASE_BRANCH}`)) return null
  return Number(git(root, 'rev-list', '--no-merges', '--count', 'HEAD', '--not', '--tags=base-*', `refs/heads/${BASE_BRANCH}`))
}

export const branchOut = (root: string): string | null => {
  const branch = gitTry(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  return branch.ok && branch.output !== 'HEAD' ? branch.output : null
}

export const headOf = (root: string, ref: string): string | null => {
  const found = gitTry(root, 'rev-parse', '--verify', '--quiet', ref)
  return found.ok ? found.output : null
}

/** The commit the backup's copy of `branch` is at, as of the last push. */
export const backedUpHeadOf = (root: string, branch: string): string | null => headOf(root, `refs/remotes/${BACKUP_REMOTE}/${branch}`)

export type Push = { kind: 'pushed' } | { kind: 'failed'; why: string }

/**
 * Pushes `branch` and every base tag to the backup, never forcing and all or nothing: a base tag the backup has differently is refused, not
 * moved. An https remote asks `gh` for the token, so it appears in no URL, argument or log.
 */
export function pushBranchAndBaseTags(root: string, branch: string): Promise<Push> {
  return new Promise((resolve) => {
    const args = ['-C', root, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--atomic', BACKUP_REMOTE, `refs/heads/${branch}:refs/heads/${branch}`, 'refs/tags/base-*:refs/tags/base-*']
    execFile('git', args, { timeout: PUSH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (error, _stdout, stderr) => {
      resolve(error === null ? { kind: 'pushed' } : { kind: 'failed', why: stderr.trim().split('\n').slice(-3).join('\n') || error.message })
    })
  })
}
