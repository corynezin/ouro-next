// Taking bases: which one is offered, and taking it. The base is merged beside the live source; a conflict goes to an
// agent started for it, and nothing live changes. The merge goes live through the guardian, which builds, checks and switches to
// it, rolling back if it turns out unhealthy; only then does the person's branch move to it. The ourod that starts a deploy
// is replaced by it, so the update's state is stored and the next ourod follows the deployment to its end.
import type { BaseStatus } from '@ouro/contract'
import {
  besideDirOf, branchHas, changedBetween, commitToDeploy, integratedBase, isMergedBeside, mergeBeside, mergeIntoPersonBranch,
  receivedBase, removeBeside, trackBase, unfinishedMergeIn,
} from '../adapters/base-checkout.ts'
import type { BaseRelease, BaseSource } from '../adapters/base-source.ts'
import { deploymentOutcome } from '../adapters/guardian-client.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { baseUpdateOf, conflictBrief, continueDecision, takeRefusal } from '../domain/base-update.ts'
import type { BaseUpdateRecord } from '../domain/base-update.ts'
import { NotPublished } from './app-publishing.ts'
import type { PublishedApp } from './app-publishing.ts'
import { CommandRefused } from './failure.ts'

/** How often the base source is asked for a newer base. */
const OFFER_CHECK_INTERVAL_MS = 30 * 60_000
const DEPLOYMENT_POLL_MS = 1_000
/** Where the app is in the source: a base that changes it is published to the phone once the server has it. */
const APP_FOLDER = 'apps/mobile'

export interface BaseUpdatesConfig {
  /** The top of the person's copy of the source; null when this machine has none. */
  sourceRoot: string | null
  /** Null: nothing offers this machine bases. */
  baseSource: BaseSource | null
  /** Null: no guardian, so nothing can switch this machine to another release. */
  guardian: GuardianClient | null
  now: () => number
  commit: (body: () => void) => void
  readRecord: () => BaseUpdateRecord
  /** Saves the record and marks the server entity changed; called inside a transaction. */
  saveRecord: (record: BaseUpdateRecord) => void
  /** The offer changed: marks the server entity changed; called inside a transaction. */
  offerChanged: () => void
  /** Publishes the app as committed in the person's source, as `ouro publish` does; null when the server has no app folder. */
  publishApp: (() => Promise<PublishedApp>) | null
  /**
   * Starts an agent of the owner's for work the update needs, and returns its name; null when none could start and the
   * owner was told instead. Called inside a transaction.
   */
  handOff: (work: { name: string; task: string }) => string | null
  log: (event: string, fields: Record<string, unknown>) => void
}

export class BaseUpdates {
  private readonly config: BaseUpdatesConfig
  /** Null: this machine takes no bases. Read from git at start and after each update. */
  private integrated: number | null
  private offered: BaseRelease | null = null
  private lastOfferCheckAt = 0
  private checkingOffer = false

  constructor(config: BaseUpdatesConfig) {
    this.config = config
    this.integrated = config.sourceRoot === null ? null : integratedBase(config.sourceRoot)
  }

  status(): BaseStatus {
    if (this.integrated === null) return { kind: 'not_taking' }
    const offered = this.offered === null ? null : { n: this.offered.n, notes: this.offered.notes, version: this.offered.version }
    return { kind: 'taker', integrated: this.integrated, offered, update: baseUpdateOf(this.config.readRecord()) }
  }

  /** At start: an update this server's predecessor began is followed to its end. */
  resume(): void {
    const record = this.config.readRecord()
    if (record.state === 'deploying') void this.follow(record.n, record.deploymentId, record.commit)
    if (record.state === 'merging') {
      // The merge itself is synchronous, so a restart in it means the server stopped while fetching the base.
      this.config.commit(() => this.config.saveRecord({ state: 'failed', n: record.n, why: 'the server restarted while fetching it; take it again' }))
    }
  }

  /** From the server's tick. */
  tick(): void {
    if (this.integrated === null || this.config.baseSource === null || this.checkingOffer) return
    if (this.config.now() - this.lastOfferCheckAt < OFFER_CHECK_INTERVAL_MS) return
    this.lastOfferCheckAt = this.config.now()
    this.checkingOffer = true
    void this.checkOffer().finally(() => { this.checkingOffer = false })
  }

  private async checkOffer(): Promise<void> {
    let latest: BaseRelease | null
    try {
      latest = await this.config.baseSource!.latest()
      // A copy made from a base has its commit but not its tag: with the tags fetched, it knows the base it is on.
      if (latest !== null && this.config.sourceRoot !== null) {
        await this.config.baseSource!.fetchTagsInto(this.config.sourceRoot)
        this.integrated = integratedBase(this.config.sourceRoot)
      }
    } catch (error) {
      this.config.log('base_offer_check_failed', { error: (error as Error).message })
      return
    }
    const offered = latest !== null && this.integrated !== null && latest.n > this.integrated && !branchHas(this.config.sourceRoot!, latest.commit) ? latest : null
    if (offered?.n === this.offered?.n && offered?.notes === this.offered?.notes && offered?.version === this.offered?.version && offered?.commit === this.offered?.commit) return
    this.offered = offered
    this.config.commit(() => this.config.offerChanged())
  }

  /** The command's synchronous part: refuses, or records the update as begun. The work runs once the command commits. */
  take(n: number): void {
    if (this.integrated === null) throw new CommandRefused('base_not_offered', 'this machine takes no bases')
    const refusal = takeRefusal(this.config.readRecord(), this.offered, n)
    if (refusal !== null) throw new CommandRefused(refusal.code, refusal.message)
    this.config.saveRecord({ state: 'merging', n })
    const offered = this.offered!
    setImmediate(() => void this.failingOnError(n, () => this.merge(offered)))
  }

  /** The command's synchronous part, after a conflict: refuses unless the merge beside is resolved and committed. */
  carryOn(): void {
    const decision = continueDecision(this.config.readRecord(), (n) => unfinishedMergeIn(besideDirOf(this.config.sourceRoot!, n)))
    if (decision.kind === 'refused') throw new CommandRefused(decision.refusal.code, decision.refusal.message)
    const { n } = decision
    this.config.saveRecord({ state: 'merging', n })
    setImmediate(() => void this.failingOnError(n, () => this.deploy(n)))
  }

  private async failingOnError(n: number, step: () => Promise<void>): Promise<void> {
    try {
      await step()
    } catch (error) {
      const why = (error as Error).message.slice(0, 300)
      this.config.log('base_update_failed', { n, why })
      this.config.commit(() => this.config.saveRecord({ state: 'failed', n, why }))
    }
  }

  private async merge(base: BaseRelease): Promise<void> {
    const { n, notes } = base
    const root = this.config.sourceRoot!
    if (receivedBase(root) < n) await this.receive(root, base)
    // A failed attempt leaves its merge beside the live source, resolved and committed, so it is used as it is.
    if (!isMergedBeside(root, n)) {
      removeBeside(root, n)
      const merged = mergeBeside(root, n)
      if (merged.kind === 'conflicted') {
        // One transaction: a conflict recorded with nobody told would wait for ever, refusing every retake.
        this.config.commit(() => {
          const resolver = this.config.handOff({ name: `base-${n}`, task: conflictBrief(n, notes, merged.files, besideDirOf(root, n)) })
          this.config.saveRecord({ state: 'conflict', n, files: merged.files, resolver })
        })
        return
      }
    }
    await this.deploy(n)
  }

  private async receive(root: string, base: BaseRelease): Promise<void> {
    await this.config.baseSource!.fetchTagsInto(root)
    trackBase(root, base.n)
  }

  private async deploy(n: number): Promise<void> {
    const guardian = this.config.guardian
    if (guardian === null) throw new Error('this machine has no guardian to build and switch to it')
    const commit = commitToDeploy(this.config.sourceRoot!, n)
    const deployment = await guardian.deploy(commit)
    this.config.commit(() => this.config.saveRecord({ state: 'deploying', n, deploymentId: deployment.id, commit }))
    await this.follow(n, deployment.id, commit)
  }

  /** Until the deployment ends. If it switches releases, this server stops here and its successor's `resume` follows on. */
  private async follow(n: number, deploymentId: string, commit: string): Promise<void> {
    for (;;) {
      let deployment
      try {
        deployment = await this.config.guardian!.deployment(deploymentId)
      } catch (error) {
        this.config.log('base_deployment_unreadable', { n, error: (error as Error).message })
        await new Promise((done) => setTimeout(done, DEPLOYMENT_POLL_MS))
        continue
      }
      if (deployment === null) {
        return this.config.commit(() => this.config.saveRecord({ state: 'failed', n, why: 'the guardian restarted during the update and lost track of it; take it again if it is still offered' }))
      }
      const outcome = deploymentOutcome(deployment)
      if (outcome.kind === 'live') return this.finish(n, commit)
      if (outcome.kind === 'failed') {
        const why = outcome.changedLive ? `${outcome.why}; it went live, turned out unhealthy, and the last good version is back` : outcome.why
        return this.config.commit(() => this.config.saveRecord({ state: 'failed', n, why }))
      }
      await new Promise((done) => setTimeout(done, DEPLOYMENT_POLL_MS))
    }
  }

  /**
   * Live: the person's branch takes the merge, and if the base changes the app the phone gets it. Publishing is after the
   * deploy and can't undo it: when it fails, an agent is started to fix it and the update still counts as done.
   */
  private async finish(n: number, commit: string): Promise<void> {
    const root = this.config.sourceRoot!
    const merge = mergeIntoPersonBranch(root, commit)
    if (merge.kind === 'not_merged') {
      return this.config.commit(() => this.config.saveRecord({ state: 'failed', n, why: `base ${n} is live, but your source's branch couldn't take it: ${merge.why}. Merge ${besideDirOf(root, n)} by hand` }))
    }
    removeBeside(root, n)
    this.integrated = integratedBase(root)
    if (this.offered !== null && this.offered.n <= (this.integrated ?? 0)) this.offered = null
    const appChanged = changedBetween(root, merge.before, commit, APP_FOLDER)
    this.config.commit(() => this.config.saveRecord({ state: 'idle' }))
    this.config.log('base_update_live', { n, commit })
    if (appChanged) await this.publishApp(n)
  }

  private async publishApp(n: number): Promise<void> {
    const failed = (why: string) => {
      this.config.log('base_update_app_not_published', { n, why })
      this.config.commit(() => this.config.handOff({ name: `base-${n}-publish`, task: `Ouro base ${n} is live on this computer and changes the app, but the app didn't reach the phone: ${why}. Fix that, publish it with \`ouro publish\`, then tell the person in one line whether it worked ("tap the update banner in Ouro to get it"), and finish.` }))
    }
    if (this.config.publishApp === null) return failed('this server has no app folder to publish from')
    try {
      const published = await this.config.publishApp()
      this.config.log('base_update_app_published', { n, updateNumber: published.updateNumber })
    } catch (error) {
      failed(error instanceof NotPublished ? error.message : `publishing failed unexpectedly: ${(error as Error).message}`)
    }
  }
}
