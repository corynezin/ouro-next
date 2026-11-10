// Where bases come from and go to. The hub serves them (hub-bases.ts): a publisher machine puts each one there, and every
// other machine reads them. A folder stands in for the hub in tests and some journeys.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A base as it was published. `treeHash` is the git tree of its files: it depends only on their content, so it names
 * the same base on every machine, whatever the commits around it.
 */
export interface PublishedBase {
  n: number
  notes: string
  treeHash: string
}

export interface BaseSource {
  /** The newest base not withdrawn, or null before the first. */
  latest(): Promise<PublishedBase | null>
  /**
   * Puts base `n`'s files into the empty folder `into`. The taker checks them against the base's `treeHash`. A withdrawn
   * base's files are still there, so an update already under way can finish.
   */
  fetch(n: number, into: string): Promise<void>
}

/** The target won't take this machine's bases: the hub doesn't count its account as a publisher's. */
export class PublishingRefused extends Error {}

export interface BasePublishTarget {
  latest(): Promise<PublishedBase | null>
  /**
   * Publishes the files in `treeDir` as the next base, numbered by the target. The same files as the newest base publish
   * nothing, so a retried publish can't make a second base. Throws `PublishingRefused` when this machine may not publish.
   */
  publish(base: { notes: string; treeHash: string; treeDir: string }): Promise<{ base: PublishedBase; alreadyPublished: boolean }>
  /**
   * Stops offering base `n`, for good; a later base fixes what was wrong with it. Null: there is no base `n`. Throws
   * `PublishingRefused` like `publish`.
   */
  withdraw(n: number): Promise<PublishedBase | null>
}

/**
 * A folder of bases: `<n>/tree/` holds base n's files, and `<n>/tree-hash` and `<n>/notes.txt` the rest. `<n>/withdrawn`
 * is there once it is withdrawn.
 */
export function folderBases(dir: string): BaseSource & BasePublishTarget {
  const baseDir = (n: number) => join(dir, String(n))
  const complete = (n: number) => existsSync(join(baseDir(n), 'notes.txt'))
  const read = (n: number): PublishedBase => ({
    n,
    notes: readFileSync(join(baseDir(n), 'notes.txt'), 'utf8').trim(),
    treeHash: readFileSync(join(baseDir(n), 'tree-hash'), 'utf8').trim(),
  })
  const withdrawn = (n: number) => existsSync(join(baseDir(n), 'withdrawn'))
  const numbers = () => existsSync(dir) ? readdirSync(dir).filter((name) => /^[1-9][0-9]*$/.test(name)).map(Number).filter(complete) : []
  const latest = async (): Promise<PublishedBase | null> => {
    const offered = numbers().filter((n) => !withdrawn(n))
    return offered.length === 0 ? null : read(Math.max(...offered))
  }
  return {
    latest,
    async fetch(n, into) {
      if (!complete(n)) throw new Error(`base ${n} isn't in ${dir}`)
      cpSync(join(baseDir(n), 'tree'), into, { recursive: true })
    },
    async publish({ notes, treeHash, treeDir }) {
      const newest = await latest()
      if (newest !== null && newest.treeHash === treeHash) return { base: newest, alreadyPublished: true }
      // Past withdrawn bases too: numbers only rise.
      const n = Math.max(0, ...numbers()) + 1
      // Written aside and moved into place, so a half-copied base is never there to read.
      const writing = join(dir, `.${n}.writing`)
      rmSync(writing, { recursive: true, force: true })
      mkdirSync(writing, { recursive: true })
      cpSync(treeDir, join(writing, 'tree'), { recursive: true })
      writeFileSync(join(writing, 'tree-hash'), `${treeHash}\n`)
      writeFileSync(join(writing, 'notes.txt'), `${notes}\n`)
      renameSync(writing, baseDir(n))
      return { base: read(n), alreadyPublished: false }
    },
    async withdraw(n) {
      if (!complete(n)) return null
      writeFileSync(join(baseDir(n), 'withdrawn'), '')
      return read(n)
    },
  }
}
