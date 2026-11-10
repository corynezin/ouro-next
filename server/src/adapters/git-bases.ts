// Bases in a git repository's `main` branch: each base is a commit whose tree is the base's files, its message the notes
// and an `Ouro-Base: n` trailer its number. A withdrawal is an empty commit with `Ouro-Base-Withdrawn: n`. Anyone reads a
// public repository over https with no credentials; only the publisher pushes, over ssh with its own key.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BasePublishTarget, BaseSource, PublishedBase } from './base-source.ts'

const execFileAsync = promisify(execFile)

const BRANCH = 'main'
const AUTHOR = { name: 'Ouro Next', email: 'bases@ouro-next.invalid' }

interface BaseCommit extends PublishedBase { commit: string }

/** Every base commit on `main` and every number withdrawn, from a scratch copy of the repository that `close` removes. */
interface History {
  gitDir: string
  /** `main`'s tip and its tree; null while the repository has no `main`. */
  tip: { commit: string; tree: string } | null
  bases: BaseCommit[]
  withdrawn: Set<number>
  close(): void
}

async function git(gitDir: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  const child = execFileAsync('git', ['--git-dir', gitDir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (input !== undefined) child.child.stdin!.end(input)
  try {
    return (await child).stdout
  } catch (error) {
    const { stderr } = error as { stderr?: string }
    throw new Error(`git ${args[0]} failed: ${(stderr ?? (error as Error).message).trim()}`)
  }
}

/** The trailer lines of the message's last paragraph, and the message before it. */
function splitTrailers(message: string): { notes: string; base: number | null; withdrawn: number | null } {
  const paragraphs = message.trim().split(/\n\n/)
  const last = paragraphs[paragraphs.length - 1]!
  const lines = last.split('\n')
  const trailer = (name: string): number | null => {
    const found = lines.map((line) => new RegExp(`^${name}: ([1-9][0-9]*)$`).exec(line)).find((match) => match !== null)
    return found ? Number(found[1]) : null
  }
  const base = trailer('Ouro-Base')
  const withdrawn = trailer('Ouro-Base-Withdrawn')
  if (base === null && withdrawn === null) return { notes: message.trim(), base, withdrawn }
  return { notes: paragraphs.slice(0, -1).join('\n\n').trim(), base, withdrawn }
}

async function readHistory(url: string): Promise<History> {
  const scratch = mkdtempSync(join(tmpdir(), 'ouro-git-bases-'))
  const gitDir = join(scratch, 'repo.git')
  const close = () => rmSync(scratch, { recursive: true, force: true })
  try {
    mkdirSync(gitDir)
    await git(gitDir, ['init', '--quiet', '--bare'])
    const advertised = await git(gitDir, ['ls-remote', url, `refs/heads/${BRANCH}`])
    if (advertised.trim() === '') return { gitDir, tip: null, bases: [], withdrawn: new Set(), close }
    await git(gitDir, ['fetch', '--quiet', url, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`])
    const log = await git(gitDir, ['log', '--format=%H%x00%T%x00%B%x01', BRANCH])
    const bases: BaseCommit[] = []
    const withdrawn = new Set<number>()
    let tip: History['tip'] = null
    for (const entry of log.split('\x01').filter((text) => text.trim() !== '')) {
      const [commit, tree, message] = entry.trim().split('\0') as [string, string, string]
      tip ??= { commit, tree }
      const parsed = splitTrailers(message)
      if (parsed.base !== null) bases.push({ n: parsed.base, notes: parsed.notes, treeHash: tree, commit })
      if (parsed.withdrawn !== null) withdrawn.add(parsed.withdrawn)
    }
    return { gitDir, tip, bases, withdrawn, close }
  } catch (error) {
    close()
    throw error
  }
}

const newestOf = (bases: BaseCommit[]): BaseCommit | null => bases.reduce<BaseCommit | null>((best, base) => best === null || base.n > best.n ? base : best, null)

const publicBase = ({ n, notes, treeHash }: BaseCommit): PublishedBase => ({ n, notes, treeHash })

function latestOffered(history: History): PublishedBase | null {
  const newest = newestOf(history.bases.filter((base) => !history.withdrawn.has(base.n)))
  return newest === null ? null : publicBase(newest)
}

/** Reads bases from the repository at `url`, whatever the transport. */
export function gitBaseSource(url: string): BaseSource {
  return {
    async latest() {
      const history = await readHistory(url)
      try {
        return latestOffered(history)
      } finally {
        history.close()
      }
    },
    async fetch(n, into) {
      const history = await readHistory(url)
      try {
        const base = history.bases.find((candidate) => candidate.n === n)
        if (!base) throw new Error(`base ${n} isn't in ${url}`)
        const index = join(history.gitDir, 'extract-index')
        await git(history.gitDir, ['read-tree', base.commit], { GIT_INDEX_FILE: index })
        await git(history.gitDir, ['checkout-index', '--all'], { GIT_INDEX_FILE: index, GIT_WORK_TREE: into })
      } finally {
        history.close()
      }
    },
  }
}

/**
 * Publishes to `main` of the repository at `pushUrl`, which it reads from too, so a base is numbered from what the
 * repository really holds. A push that another publish beat is refused by git, never forced: the caller tries again.
 */
export function gitBasePublishTarget(pushUrl: string): BasePublishTarget {
  const commitOn = async (history: History, tree: string, message: string): Promise<void> => {
    const identity = {
      GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
    }
    const parents = history.tip ? ['-p', history.tip.commit] : []
    const commit = (await git(history.gitDir, ['commit-tree', tree, ...parents, '-F', '-'], identity, message)).trim()
    await git(history.gitDir, ['push', '--quiet', pushUrl, `${commit}:refs/heads/${BRANCH}`])
  }
  const lastNumber = (history: History) => newestOf(history.bases)?.n ?? 0
  return {
    async latest() {
      const history = await readHistory(pushUrl)
      try {
        return latestOffered(history)
      } finally {
        history.close()
      }
    },
    async publish({ notes, treeHash, treeDir }) {
      const history = await readHistory(pushUrl)
      try {
        const offered = latestOffered(history)
        if (offered !== null && offered.treeHash === treeHash) return { base: offered, alreadyPublished: true }
        // `-f`: the publisher's files are the base whatever ignore rules say, as the tree hash is computed.
        const index = join(history.gitDir, 'publish-index')
        const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: treeDir }
        await git(history.gitDir, ['add', '--all', '--force', '--', '.'], env)
        const tree = (await git(history.gitDir, ['write-tree'], env)).trim()
        if (tree !== treeHash) throw new Error(`the files in ${treeDir} hash to ${tree}, not ${treeHash}`)
        // Numbers only rise, past withdrawn bases too.
        const n = lastNumber(history) + 1
        await commitOn(history, tree, `${notes}\n\nOuro-Base: ${n}\n`)
        return { base: { n, notes, treeHash }, alreadyPublished: false }
      } finally {
        history.close()
      }
    },
    async withdraw(n) {
      const history = await readHistory(pushUrl)
      try {
        const base = history.bases.find((candidate) => candidate.n === n)
        if (!base) return null
        if (!history.withdrawn.has(n)) await commitOn(history, history.tip!.tree, `Withdraw base ${n}\n\nOuro-Base-Withdrawn: ${n}\n`)
        return publicBase(base)
      } finally {
        history.close()
      }
    },
  }
}
