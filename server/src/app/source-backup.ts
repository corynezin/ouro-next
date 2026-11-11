// Keeping the person's changes to the source safe: a private repository on their GitHub account is the source's `backup`
// remote, and the live version, with the base tags, is pushed to it after each deploy. Nothing here blocks a deploy; a failed
// push is shown, and tried again.
import type { GithubIntegrationState, SourceBackup } from '@ouro/contract'
import { GitHubRefused } from '../adapters/github-api.ts'
import type { GitHubApi } from '../adapters/github-api.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { backedUpHeadOf, backupOf, branchOut, commitsOnNoBase, headOf, pushBranchAndBaseTags, setBackupRemote } from '../adapters/source-backup-git.ts'
import { CommandRefused } from './failure.ts'

const CHECK_INTERVAL_MS = 10_000
const RETRY_AFTER_FAILED_PUSH_MS = 60_000

export interface SourceBackupConfig {
  /** The person's copy of the source; null when there is none. */
  sourceRoot: string | null
  /** This server's name, which tells its backup from another server's of the same person. */
  machineName: string
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
    const repository = backupOf(sourceRoot)
    if (repository !== null) return { state: 'backed_up', repository, behind: this.behind(sourceRoot), lastPushError: this.lastPushError }
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
    if (backupOf(sourceRoot) === null) {
      const token = await this.config.githubToken()
      if (token === null) throw new CommandRefused('github_not_connected', 'connect GitHub first: the private copy is made on your account')
      setBackupRemote(sourceRoot, (await this.createWith(token)).cloneUrl)
      this.refresh()
    }
    await this.pushNow()
  }

  /** `ouro-next`, or that with this server's name where the account has it already. */
  private async createWith(token: string) {
    const names = ['ouro-next', `ouro-next-${nameSlug(this.config.machineName)}`]
    for (const name of names) {
      const made = await this.createOnGitHub(token, name)
      if (made.kind === 'created') return made.repository
    }
    throw new CommandRefused('provider_unreachable', `your GitHub account already has repositories named ${names.join(' and ')}`)
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
      this.lastPushError = pushed.why
      this.lastFailedPushAt = this.config.now()
      this.refresh()
      throw new CommandRefused('push_failed', pushed.why)
    }
    this.lastPushError = null
    this.refresh()
  }
}

/** A server's name as part of a repository name: lowercase letters, digits and single hyphens. */
const nameSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'
