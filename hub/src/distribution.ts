// The commits computers are made from, in a bare repository of the hub's own. Each is a root commit of Ouro's files
// with an `Ouro-Base: <n>` trailer, as a taker commits a base to its `ouro-base` branch, so a computer starts on its
// `ouro-base` with the base it was made from, and later bases merge on top. Before the first base, computers are made
// from the configured distribution's files as base 0.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HubBase } from '@ouro/contract'

const execFileAsync = promisify(execFile)

/** The branch a computer's copy of the source keeps the bases on, as the server's base updates read it. */
export const BASE_BRANCH = 'ouro-base'
const BASE_TRAILER = 'Ouro-Base'
const OURO_IDENTITY = ['-c', 'user.name=Ouro', '-c', 'user.email=ouro@localhost']
/** As update-ref's old value: the ref must not exist yet. */
const NO_COMMIT = '0'.repeat(40)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

/** Where computers come from before the first base: a git repository of Ouro, and the branch or tag to take. */
export interface ConfiguredDistribution {
  source: string
  reference: string
}

export class DistributionRepository {
  readonly gitDir: string
  private readonly beforeBases: ConfiguredDistribution

  constructor(gitDir: string, beforeBases: ConfiguredDistribution) {
    this.gitDir = gitDir
    this.beforeBases = beforeBases
    if (!existsSync(join(gitDir, 'HEAD'))) {
      mkdirSync(gitDir, { recursive: true })
      execFileSync('git', ['init', '--quiet', '--bare', gitDir], { env: GIT_ENV, stdio: ['ignore', 'ignore', 'pipe'] })
    }
  }

  /**
   * The git tree of the files in `dir`, exactly as they are: every file added, ignore rules aside, into an index of its
   * own, as a taker computes a base's tree. Its objects are kept here.
   */
  async treeOf(dir: string, indexFile: string): Promise<string> {
    const env = { ...GIT_ENV, GIT_INDEX_FILE: indexFile }
    await execFileAsync('git', ['--git-dir', this.gitDir, '--work-tree', dir, 'add', '-A', '-f', '.'], { cwd: dir, env })
    return (await execFileAsync('git', ['--git-dir', this.gitDir, 'write-tree'], { env })).stdout.trim()
  }

  /** Base `n`'s commit, made once from its tree. */
  async commitOfBase(n: number, tree: string): Promise<string> {
    return await this.rootCommit(`refs/bases/${n}`, tree, `Ouro base ${n}`, n)
  }

  /** What a computer asked for now is made from: the base offered, or before the first, the configured distribution. */
  async startingCommit(offered: HubBase | null): Promise<string> {
    return offered ? await this.git('rev-parse', '--verify', `refs/bases/${offered.n}^{commit}`) : await this.commitBeforeBases()
  }

  /**
   * What a computer asked for now is made from when the bases live in the git repository at `baseRepo`: its newest base
   * commit not withdrawn, kept as it is (the files, notes and `Ouro-Base: n` trailer a taker reads). The hub's own bases
   * play no part. Before the repository's first base, the configured distribution as base 0. An unreachable repository
   * is an error, never a quiet start on the wrong base.
   */
  async startingCommitFromBaseRepo(baseRepo: string): Promise<string> {
    const advertised = await this.git('ls-remote', baseRepo, 'refs/heads/main')
    if (advertised === '') return await this.commitBeforeBases()
    await this.git('fetch', '--quiet', '--no-tags', baseRepo, '+refs/heads/main:refs/base-repo/main')
    const log = await this.git('log', '--format=%H%x00%B%x01', 'refs/base-repo/main')
    const withdrawn = new Set<number>()
    let newest: { n: number; commit: string } | null = null
    // The log runs newest first, so a base's withdrawal is read before the base.
    for (const entry of log.split('\x01').filter((text) => text.trim() !== '')) {
      const [commit, message] = entry.trim().split('\0') as [string, string]
      const trailerLines = message.trim().split(/\n\n/).at(-1)!.split('\n')
      const numberOf = (name: string) => {
        const found = trailerLines.map((line) => new RegExp(`^${name}: ([1-9][0-9]*)$`).exec(line)).find((match) => match !== null)
        return found ? Number(found[1]) : null
      }
      const withdrawnNumber = numberOf('Ouro-Base-Withdrawn')
      if (withdrawnNumber !== null) withdrawn.add(withdrawnNumber)
      const n = numberOf(BASE_TRAILER)
      if (n !== null && (newest === null || n > newest.n) && !withdrawn.has(n)) newest = { n, commit }
    }
    if (newest === null) return await this.commitBeforeBases()
    // Kept by a ref of its own, as a computer was promised it.
    await this.git('update-ref', `refs/repo-bases/${newest.commit}`, newest.commit)
    return newest.commit
  }

  /** The configured distribution's files as they are now, as base 0. */
  private async commitBeforeBases(): Promise<string> {
    const { source, reference } = this.beforeBases
    await this.git('fetch', '--quiet', '--no-tags', source, `+${reference}:refs/distribution/configured`)
    const configured = await this.git('rev-parse', '--verify', 'refs/distribution/configured^{commit}')
    return await this.rootCommit(`refs/before-bases/${configured}`, await this.git('rev-parse', `${configured}^{tree}`), `Ouro before the first base, from ${configured.slice(0, 12)}`, 0)
  }

  /** The commit at `ref`, made there first if it isn't yet. */
  private async rootCommit(ref: string, tree: string, title: string, n: number): Promise<string> {
    const existing = await this.git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).catch(() => null)
    if (existing) return existing
    const commit = await this.git(...OURO_IDENTITY, 'commit-tree', tree, '-m', title, '-m', `${BASE_TRAILER}: ${n}`)
    // Only if nobody made it meanwhile: the commit a computer was promised must stay referenced.
    const made = await this.git('update-ref', ref, commit, NO_COMMIT).then(() => true, () => false)
    return made ? commit : await this.git('rev-parse', '--verify', `${ref}^{commit}`)
  }

  private async git(...args: string[]): Promise<string> {
    return (await execFileAsync('git', ['--git-dir', this.gitDir, ...args], { env: GIT_ENV })).stdout.trim()
  }
}
