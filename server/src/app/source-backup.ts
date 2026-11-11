// Keeping the person's changes to the source safe: a private repository on their GitHub account is the source's `backup`
// remote, and the live version, with the base tags, is pushed to it after each deploy. Nothing here blocks a deploy; a failed
// push is shown, and tried again.
import type { GithubIntegrationState, SourceBackup } from '@ouro/contract'
import { GitHubRefused } from '../adapters/github-api.ts'
import type { GitHubApi } from '../adapters/github-api.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { backedUpHeadOf, backupOf, branchOut, commitsOnNoBase, headOf, pushBranchAndBaseTags, pushedAtOf, recordPushedAt, setBackupRemote } from '../adapters/source-backup-git.ts'
import { CommandRefused } from './failure.ts'

const CHECK_INTERVAL_MS = 10_000
const RETRY_AFTER_FAILED_PUSH_MS = 60_000
/** What the person is told of a failed push; git's own output goes to the log. */
const PUSH_FAILED_REASON = "GitHub didn't accept the push. It is tried again every minute."
const MAX_PRIVATE_NAME_NUMBER = 20

export interface SourceBackupConfig {
  /** The person's copy of the source; null when there is none. */
  sourceRoot: string | null
  /** The name of the public base repository on GitHub, whose name the private copy's must never be. */
  baseRepositoryName: string
  /** Waits between the tries of the first push to a repository just made, which GitHub can refuse for a few seconds. */
  firstPushRetryDelaysMs: number[]
  api: GitHubApi
  /** The connected GitHub account's token; null when not connected. */
  githubToken: () => Promise<string | null>
  githubState: () => GithubIntegrationState['status'] | null
  guardian: GuardianClient | null
  now: () => number
  /** The backup status changed: the server entity is out of date. */
  changed: () => void
  log: (event: string, fields: Record<string, unknown>) => void
}

export class SourceBackupKeeper {
  private readonly config: SourceBackupConfig
  private known: SourceBackup = { state: 'not_applicable' }
  private lastPushError: string | null = null
  private lastCheckAt = -Infinity
  private lastFailedPushAt = -Infinity
  private working: Promise<void> | null = null
  private makingPrivateCopy = false

  constructor(config: SourceBackupConfig) {
    this.config = config
    this.refresh()
  }

  /** As of the last refresh, so a snapshot runs no git. */
  status(): SourceBackup {
    return this.known
  }

  /** Reads the source: local git only. */
  refresh(): void {
    const status = this.read()
    if (JSON.stringify(status) === JSON.stringify(this.known)) return
    this.known = status
    this.config.changed()
  }

  private read(): SourceBackup {
    const { sourceRoot } = this.config
    if (sourceRoot === null) return { state: 'not_applicable' }
    if (this.makingPrivateCopy) return { state: 'making_private_copy' }
    const repository = backupOf(sourceRoot)
    if (repository !== null) return { state: 'backed_up', repository, lastPushedAt: pushedAtOf(sourceRoot), behind: this.behind(sourceRoot), lastPushError: this.lastPushError }
    const own = commitsOnNoBase(sourceRoot)
    if (own === null) return { state: 'not_applicable' }
    if (own === 0) return { state: 'nothing_to_back_up' }
    return { state: 'not_backed_up', github: this.config.githubState() === 'connected' ? 'connected' : 'not_connected' }
  }

  private behind(root: string): boolean {
    const branch = branchOut(root)
    return branch !== null && headOf(root, `refs/heads/${branch}`) !== backedUpHeadOf(root, branch)
  }

  /** From the server's tick: after a deploy, the live version is pushed. One push at a time, and a failed one waits before the next. */
  tick(): void {
    const now = this.config.now()
    if (this.working || now - this.lastCheckAt < CHECK_INTERVAL_MS) return
    this.lastCheckAt = now
    this.refresh()
    if (this.known.state !== 'backed_up' || !this.known.behind || now - this.lastFailedPushAt < RETRY_AFTER_FAILED_PUSH_MS) return
    this.working = this.pushLiveVersion()
      .catch((error: Error) => this.config.log('source_push_failed', { error: error.message }))
      .finally(() => { this.working = null })
  }

  /** Only a version the guardian has confirmed live is pushed: work in progress and a deploy not yet confirmed stay local. */
  private async pushLiveVersion(): Promise<void> {
    const { sourceRoot, guardian } = this.config
    if (sourceRoot === null || guardian === null) return
    const branch = branchOut(sourceRoot)
    if (branch === null) return
    const live = await guardian.confirmedLiveCommit()
    if (live === null || live !== headOf(sourceRoot, `refs/heads/${branch}`)) return
    await this.push(sourceRoot, branch).catch((error: CommandRefused) => this.config.log('source_push_failed', { error: error.message }))
  }

  /** Makes the private repository for the connected account and pushes to it. Doing it again finds the backup. */
  async create(): Promise<void> {
    const { sourceRoot } = this.config
    if (sourceRoot === null || commitsOnNoBase(sourceRoot) === null) throw new CommandRefused('source_backup_not_applicable', 'this machine has no copy of the source that takes bases')
    if (this.makingPrivateCopy) throw new CommandRefused('source_backup_in_progress', 'a private copy is already being made')
    if (backupOf(sourceRoot) === null) {
      this.makingPrivateCopy = true
      this.refresh()
      try {
        await this.makePrivateCopy(sourceRoot)
      } finally {
        this.makingPrivateCopy = false
        this.refresh()
      }
      return
    }
    await this.pushNow()
  }

  private async makePrivateCopy(sourceRoot: string): Promise<void> {
    const token = await this.config.githubToken()
    if (token === null) throw new CommandRefused('github_not_connected', 'connect GitHub first: the private copy is made on your account')
    setBackupRemote(sourceRoot, (await this.createWith(token)).cloneUrl)
    await this.pushNewRepository()
  }

  /** A repository GitHub just made can refuse pushes for a few seconds, so the first one is tried again before it counts as failed. */
  private async pushNewRepository(): Promise<void> {
    for (const delay of this.config.firstPushRetryDelaysMs) {
      try {
        return await this.pushNow()
      } catch (error) {
        if (!(error instanceof CommandRefused && error.code === 'push_failed')) throw error
        await new Promise((done) => setTimeout(done, delay))
      }
    }
    await this.pushNow()
  }

  /** `<base repository>-private`, then `-private-2` and so on, the first the account doesn't have. Never the base repository's own name. */
  private async createWith(token: string) {
    const names = [`${this.config.baseRepositoryName}-private`, ...Array.from({ length: MAX_PRIVATE_NAME_NUMBER - 1 }, (_, i) => `${this.config.baseRepositoryName}-private-${i + 2}`)]
    for (const name of names) {
      const made = await this.createOnGitHub(token, name)
      if (made.kind === 'created') return made.repository
    }
    throw new CommandRefused('provider_unreachable', `your GitHub account already has repositories named ${names[0]} to ${names.at(-1)}`)
  }

  private async createOnGitHub(token: string, name: string) {
    try {
      return await this.config.api.createPrivateRepository(token, name)
    } catch (error) {
      if (error instanceof GitHubRefused) throw new CommandRefused('provider_unreachable', error.message)
      throw error
    }
  }

  /** Pushes the source's branch and base tags to the backup now, whatever is live. */
  async pushNow(): Promise<void> {
    const { sourceRoot } = this.config
    if (sourceRoot === null || backupOf(sourceRoot) === null) throw new CommandRefused('no_source_backup', 'there is no backup yet: back the source up first')
    const branch = branchOut(sourceRoot)
    if (branch === null) throw new CommandRefused('push_failed', `${sourceRoot} has no branch out to push`)
    await this.push(sourceRoot, branch)
  }

  private async push(root: string, branch: string): Promise<void> {
    const pushed = await pushBranchAndBaseTags(root, branch)
    if (pushed.kind === 'failed') {
      this.config.log('source_push_refused', { gitOutput: pushed.gitOutput })
      this.lastPushError = PUSH_FAILED_REASON
      this.lastFailedPushAt = this.config.now()
      this.refresh()
      throw new CommandRefused('push_failed', PUSH_FAILED_REASON)
    }
    this.lastPushError = null
    recordPushedAt(root, this.config.now())
    this.refresh()
  }
}
