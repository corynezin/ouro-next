// Bases on the hub: a publisher puts each one here, and every computer reads them. A base's files are kept as the tar
// they came in, at `<dir>/<n>.tar`, once they are checked to be the tree the publisher named, and as a commit in the
// distribution repository that new computers are made from.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HubBase, PublishBaseRequest, PublishBaseResult, WithdrawBaseResult } from '@ouro/contract'
import type { DistributionRepository } from './distribution.ts'
import { HubRefusal } from './hub.ts'
import type { Account, HubStore } from './store.ts'

const execFileAsync = promisify(execFile)

export interface HubBasesDependencies {
  store: HubStore
  repository: DistributionRepository
  /** Where base files are kept. */
  dir: string
  now: () => number
  /** Set when the hub's computers take their bases from a git repository: the hub then keeps none of its own. */
  baseRepo?: string
}

export class HubBases {
  private readonly deps: HubBasesDependencies
  /** The last publish under way: each numbers its base only once the one before is recorded. */
  private publishing: Promise<unknown> = Promise.resolve()

  constructor(deps: HubBasesDependencies) {
    this.deps = deps
    mkdirSync(deps.dir, { recursive: true })
  }

  /** The base offered: the newest not withdrawn. */
  latest(): HubBase | null {
    return this.deps.store.latestOfferedBase()
  }

  /** The tar of base `n`'s files, withdrawn or not. */
  filesOf(n: number): string {
    if (!this.deps.store.base(n)) throw new HubRefusal('not_found', `There is no base ${n}.`)
    return this.tarOf(n)
  }

  async publish(account: Account, request: PublishBaseRequest): Promise<PublishBaseResult> {
    this.refuseUnlessPublisher(account)
    const scratch = mkdtempSync(join(this.deps.dir, '.publishing-'))
    try {
      const tar = join(scratch, 'files.tar')
      writeFileSync(tar, Buffer.from(request.filesTarBase64, 'base64'))
      const treeHash = await this.treeOfTar(tar, scratch)
      if (treeHash !== request.treeHash) throw new HubRefusal('invalid_request', `These files are the tree ${treeHash}, not ${request.treeHash}.`)
      const publishing = this.publishing.then(() => this.record(account, request, tar))
      this.publishing = publishing.catch(() => undefined)
      return await publishing
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  withdraw(account: Account, n: number): WithdrawBaseResult {
    this.refuseUnlessPublisher(account)
    const { store, now } = this.deps
    if (!store.base(n)) throw new HubRefusal('not_found', `There is no base ${n}.`)
    store.withdrawBase(n, now())
    return { base: store.base(n)! }
  }

  /** The same files as the base offered make nothing new, so a retried publish can't make a second base. */
  private async record(account: Account, request: PublishBaseRequest, tar: string): Promise<PublishBaseResult> {
    const { store, repository, now } = this.deps
    const offered = store.latestOfferedBase()
    if (offered !== null && offered.treeHash === request.treeHash) return { base: offered, alreadyPublished: true }
    const base: HubBase = { n: store.nextBaseNumber(), notes: request.notes, treeHash: request.treeHash }
    // In place before it is recorded, so a recorded base always has its files and its commit.
    await repository.commitOfBase(base.n, base.treeHash)
    renameSync(tar, this.tarOf(base.n))
    store.addBase(base, account.id, now())
    return { base, alreadyPublished: false }
  }

  private refuseUnlessPublisher(account: Account): void {
    if (this.deps.baseRepo !== undefined) throw new HubRefusal('not_publisher', "This hub's computers take their bases from a git repository, so it publishes none; publish there.")
    if (!this.deps.store.isPublisher(account.id)) throw new HubRefusal('not_publisher', 'This account may not publish bases.')
  }

  /** The tree of the files in the tar, as a taker computes it from the same files. */
  private async treeOfTar(tar: string, scratch: string): Promise<string> {
    const files = join(scratch, 'files')
    mkdirSync(files)
    try {
      await execFileAsync('tar', ['-x', '-f', tar, '-C', files])
    } catch {
      throw new HubRefusal('invalid_request', "The base's files are not a readable tar.")
    }
    return await this.deps.repository.treeOf(files, join(scratch, 'index'))
  }

  private tarOf(n: number): string {
    return join(this.deps.dir, `${n}.tar`)
  }
}
