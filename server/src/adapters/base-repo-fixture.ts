// A local bare repository standing in for the public base repository, for tests: servers only read it. A base is a commit
// on `main` whose tree is the base's files, in the history the taker's source shares, tagged with an annotated `base-<n>`.
// Kept beside the code it tests so that it ships with the server source.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const IDENTITY = { GIT_AUTHOR_NAME: 'Ouro Next', GIT_AUTHOR_EMAIL: 'bases@ouro-next.invalid', GIT_COMMITTER_NAME: 'Ouro Next', GIT_COMMITTER_EMAIL: 'bases@ouro-next.invalid' }

export class BaseRepo {
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  get url(): string {
    return `file://${this.dir}`
  }

  async git(args: string[], env: Record<string, string> = {}): Promise<string> {
    return (await execFileAsync('git', ['--git-dir', this.dir, ...args], { env: { ...process.env, ...IDENTITY, ...env } })).stdout.trim()
  }

  /** Makes the repository; `startingFrom` is the commit, in the repository `repo`, that its history grows from. */
  async create(startingFrom?: { repo: string; commit: string }): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    await execFileAsync('git', ['init', '--quiet', '--bare', '--initial-branch=main', this.dir])
    if (startingFrom === undefined) return
    await this.git(['fetch', '--quiet', '--no-tags', startingFrom.repo, startingFrom.commit])
    await this.git(['update-ref', 'refs/heads/main', startingFrom.commit])
  }

  /** Releases base `n`: a commit of the files in `treeDir` on `main`, tagged `base-<n>` with `notes`. */
  async release(n: number, notes: string, treeDir: string): Promise<string> {
    const env = { GIT_INDEX_FILE: join(this.dir, `index-${n}`), GIT_WORK_TREE: treeDir }
    await this.git(['add', '--all', '--force', '--', '.'], env)
    const tree = await this.git(['write-tree'], env)
    const tip = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => null)
    const commit = await this.git(['commit-tree', tree, ...(tip === null ? [] : ['-p', tip]), '-m', `Ouro base ${n}`])
    await this.git(['update-ref', 'refs/heads/main', commit])
    await this.git(['tag', '-a', '-m', notes, `base-${n}`, commit])
    return commit
  }

  /** Withdraws base `n`: an annotated tag `base-<n>-withdrawn`, on the same commit. */
  async withdraw(n: number): Promise<void> {
    await this.git(['tag', '-a', '-m', `base ${n} is withdrawn`, `base-${n}-withdrawn`, `base-${n}^{commit}`])
  }
}
