// Publishing bases: the publisher machine makes its source's branch the next base, for every taker to merge. Only the
// commit that is live here, proven by the guardian's offline checks, switch and confirmation, is published; what ships is
// cut from it by its distribution rule, scanned for internal documents and private names, and checked once more as it
// ships. The target numbers it. Publishing the same files again makes no new base, so a retried publish is harmless.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportPersonBranch, integratedBase, treeHashOf } from '../adapters/base-checkout.ts'
import { PublishingRefused } from '../adapters/base-source.ts'
import type { BasePublishTarget, PublishedBase } from '../adapters/base-source.ts'
import { copyWhatShips, forbiddenContent, readDistributionRule, readPrivateNames, runChecks } from '../adapters/distribution.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { CommandRefused } from './failure.ts'

export interface BasePublisher {
  /** The top of the person's copy of the source; null when this machine has none. */
  sourceRoot: string | null
  /** Null: this machine publishes no bases. */
  target: BasePublishTarget | null
  /** What says which commit is live, and confirmed, here. */
  guardian: GuardianClient | null
  /** The publisher's private names, one to a line; outside the source, since they mustn't ship. */
  privateNamesFile: string | null
}

const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

/** The target's own word that this machine doesn't publish, as the command's refusal. */
async function refusedAsNotPublisher<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof PublishingRefused) throw new CommandRefused('not_base_publisher', error.message)
    throw error
  }
}

export async function publishBase(publisher: BasePublisher, notes: string): Promise<{ base: PublishedBase; alreadyPublished: boolean }> {
  const { sourceRoot, target, guardian, privateNamesFile } = publisher
  if (sourceRoot === null) throw new CommandRefused('not_base_publisher', 'this machine has no copy of the source to publish')
  if (target === null) throw new CommandRefused('not_base_publisher', 'this machine has nowhere to publish bases to')
  // A taker's branch is bases merged with the person's own changes: publishing it would hand those to everyone.
  if (integratedBase(sourceRoot) !== null) throw new CommandRefused('not_base_publisher', 'this machine takes bases, so it doesn\'t publish them')
  if (guardian === null) throw new CommandRefused('not_base_publisher', 'this machine has no guardian to say which version is live')
  if (privateNamesFile === null) throw new CommandRefused('not_base_publisher', 'this machine has no list of private names to scan bases for (OURO_PRIVATE_NAMES_FILE)')

  const branchDir = folder('ouro-publish-branch-')
  const shipsDir = folder('ouro-publish-ships-')
  try {
    const exported = exportPersonBranch(sourceRoot, branchDir)
    if (exported.kind === 'uncommitted') {
      throw new CommandRefused('base_source_uncommitted', `commit or discard the changes in ${sourceRoot} first: ${exported.files.join(', ')}`)
    }
    const live = await guardian.confirmedLiveCommit()
    if (live !== exported.commit) {
      const instead = live === null ? 'no version is confirmed live here now' : `${live.slice(0, 8)} is`
      throw new CommandRefused('base_not_live', `${exported.commit.slice(0, 8)} isn't the version live here (${instead}): deploy it first with ouro deploy`)
    }

    const reading = readDistributionRule(branchDir)
    if (reading.kind === 'unusable') throw new CommandRefused('distribution_rule_unusable', reading.why)
    const { rule } = reading
    const missing = copyWhatShips(branchDir, rule, shipsDir)
    if (missing.length > 0) throw new CommandRefused('distribution_rule_unusable', `the distribution rule ships what the source doesn't have: ${missing.join(', ')}`)
    const forbidden = forbiddenContent(shipsDir, rule, readPrivateNames(privateNamesFile))
    if (forbidden.length > 0) throw new CommandRefused('base_private_content', `this would ship what must stay private:\n${forbidden.slice(0, 20).join('\n')}${forbidden.length > 20 ? `\nand ${forbidden.length - 20} more` : ''}`)

    const treeHash = treeHashOf(sourceRoot, shipsDir)
    // These files passed their checks when they were published.
    const newest = await target.latest()
    if (newest !== null && newest.treeHash === treeHash) return { base: newest, alreadyPublished: true }
    const checks = await runChecks(shipsDir, rule, sourceRoot)
    if (checks.kind === 'failed') throw new CommandRefused('base_checks_failed', `${checks.check} failed on what would ship:\n${checks.output}`)
    return await refusedAsNotPublisher(target.publish({ notes, treeHash, treeDir: shipsDir }))
  } finally {
    rmSync(branchDir, { recursive: true, force: true })
    rmSync(shipsDir, { recursive: true, force: true })
  }
}

export async function withdrawBase(publisher: BasePublisher, n: number): Promise<PublishedBase> {
  if (publisher.target === null) throw new CommandRefused('not_base_publisher', 'this machine has nowhere it publishes bases to')
  const withdrawn = await refusedAsNotPublisher(publisher.target.withdraw(n))
  if (withdrawn === null) throw new CommandRefused('not_found', `there is no base ${n}`)
  return withdrawn
}
