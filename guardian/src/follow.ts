// Following a branch: the guardian fetches a branch of the person's remote every couple of minutes and deploys a new head
// through the same build, check, switch and rollback as any deploy. A head that failed here is skipped until a person
// deploys it by hand; one that only started too slowly is tried again later. Only a person sets what is followed.
import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { DeploymentPhase } from './guardian.ts'

const execFileAsync = promisify(execFile)

export interface Following {
  remote: string
  branch: string
}

/** Where a fetched head is kept: the guardian's own ref, so it never moves the person's branches or remote refs. */
const FOLLOWED_REF = 'refs/ouro/following'

/** The last finished deployment of a commit, as the follower needs it. */
export interface FinishedAttempt {
  phase: DeploymentPhase
  endedAt: number
  startedTooSlowly: boolean
}

export type FollowStep =
  | { kind: 'up_to_date' }
  | { kind: 'deploy' }
  /** It failed here: deploying it again would fail again, so it waits for a newer head or a person. */
  | { kind: 'failed_before'; phase: DeploymentPhase }
  /** It went live but didn't start in time, which a busier moment can cause: tried again at `retryAt`. */
  | { kind: 'slow_before'; retryAt: number }

/** What to do about the followed branch's head, given what runs now and how its last attempt here ended. */
export function followStep(head: string, liveCommit: string | null, lastAttempt: FinishedAttempt | null, now: number, slowRetryMs: number): FollowStep {
  if (head === liveCommit) return { kind: 'up_to_date' }
  if (lastAttempt === null) return { kind: 'deploy' }
  switch (lastAttempt.phase) {
    // It ran here once and something else replaced it, or it never got its turn: nothing is known against it.
    case 'live':
    case 'superseded':
      return { kind: 'deploy' }
    case 'rolled_back':
      if (lastAttempt.startedTooSlowly) {
        const retryAt = lastAttempt.endedAt + slowRetryMs
        return now >= retryAt ? { kind: 'deploy' } : { kind: 'slow_before', retryAt }
      }
      return { kind: 'failed_before', phase: lastAttempt.phase }
    default:
      return { kind: 'failed_before', phase: lastAttempt.phase }
  }
}

/** What one check found and did, for `ouro update` and the guardian's status. */
export type FollowCheck =
  | { kind: 'not_following' }
  | { kind: 'busy' }
  | { kind: 'fetch_failed'; following: Following; error: string }
  | ({ following: Following; head: string } & (Exclude<FollowStep, { kind: 'deploy' }> | { kind: 'deploying'; deploymentId: string }))

export function readFollowing(path: string): Following | null {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { following: Following | null }
    return stored.following
  } catch {
    return null
  }
}

export function writeFollowing(path: string, following: Following | null): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ following })}\n`)
  renameSync(temporary, path)
}

export class FollowRefused extends Error {}

async function git(sourceDir: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: sourceDir })
    return stdout.trim()
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    throw new FollowRefused((failure.stderr || failure.message).trim().slice(0, 500))
  }
}

/** From a request: both names to follow a branch, neither to stop. */
export function followingRequested(remote: string | null | undefined, branch: string | null | undefined): Following | null {
  if (!remote && !branch) return null
  if (!remote || !branch) throw new FollowRefused('following needs both a remote and a branch')
  return { remote, branch }
}

/** Names passed to git as arguments: none may read as an option. */
const PLAIN_NAME = /^(?!-)[A-Za-z0-9._/-]{1,100}$/

/** Checks the names and that the branch can be fetched, before anything is stored. */
export async function validateFollowing(sourceDir: string, following: Following): Promise<void> {
  if (!PLAIN_NAME.test(following.remote)) throw new FollowRefused(`${following.remote} isn't a remote name`)
  if (!PLAIN_NAME.test(following.branch)) throw new FollowRefused(`${following.branch} isn't a branch name`)
  await git(sourceDir, 'check-ref-format', '--branch', following.branch).catch(() => {
    throw new FollowRefused(`${following.branch} isn't a branch name`)
  })
  await git(sourceDir, 'remote', 'get-url', following.remote).catch(() => {
    throw new FollowRefused(`the source at ${sourceDir} has no remote named ${following.remote}`)
  })
  await fetchHead(sourceDir, following)
}

/** Fetches the followed branch and answers its head. */
export async function fetchHead(sourceDir: string, following: Following): Promise<string> {
  await git(sourceDir, 'fetch', '--quiet', '--no-tags', following.remote, `+refs/heads/${following.branch}:${FOLLOWED_REF}`)
  return await git(sourceDir, 'rev-parse', '--verify', `${FOLLOWED_REF}^{commit}`)
}
