// Bases in a git repository: base n is the commit the annotated tag `base-<n>` points to, its notes the tag's message. An
// annotated tag `base-<n>-withdrawn` offers it no more. Servers only read: `ls-remote` and fetches of tags over git,
// with no API and so no rate limit, and a public repository needs no credentials. Lightweight tags aren't releases.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { versionOf } from './base-source.ts'
import type { BaseRelease, BaseSource } from './base-source.ts'

const execFileAsync = promisify(execFile)

/** The refs a repository advertises for base tags, as git names them. */
const BASE_TAGS = 'refs/tags/base-*'
const BASE_TAG = /^refs\/tags\/base-([1-9][0-9]*)$/
const WITHDRAWN_TAG = /^refs\/tags\/base-([1-9][0-9]*)-withdrawn$/

async function git(args: string[], options: { gitDir?: string; cwd?: string } = {}): Promise<string> {
  const prefix = options.gitDir ? ['--git-dir', options.gitDir] : options.cwd ? ['-C', options.cwd] : []
  try {
    return (await execFileAsync('git', [...prefix, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 })).stdout
  } catch (error) {
    const { stderr } = error as { stderr?: string }
    throw new Error(`git ${args[0]} failed: ${(stderr ?? (error as Error).message).trim()}`)
  }
}

/** What `ls-remote` says about the tags: the commit each annotated base tag points to, and which are withdrawn. */
async function advertisedBases(url: string): Promise<{ commits: Map<number, string>; withdrawn: Set<number> }> {
  const commits = new Map<number, string>()
  const withdrawn = new Set<number>()
  const objects = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const line of (await git(['ls-remote', '--tags', url, BASE_TAGS])).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t') as [string, string]
    if (ref.endsWith('^{}')) peeled.set(ref.slice(0, -3), sha)
    else objects.set(ref, sha)
  }
  // A tag with no peeled line is lightweight: only annotated tags are releases and withdrawals.
  for (const ref of objects.keys()) {
    const commit = peeled.get(ref)
    if (commit === undefined) continue
    const base = BASE_TAG.exec(ref)
    if (base) commits.set(Number(base[1]), commit)
    const withdrawal = WITHDRAWN_TAG.exec(ref)
    if (withdrawal) withdrawn.add(Number(withdrawal[1]))
  }
  return { commits, withdrawn }
}

/** The message of tag `base-<n>` and the version in its server/package.json, read from a scratch copy that holds only that tag. */
async function notesOf(url: string, n: number): Promise<{ notes: string; version: string | null }> {
  const scratch = mkdtempSync(join(tmpdir(), 'ouro-git-bases-'))
  const gitDir = join(scratch, 'repo.git')
  try {
    mkdirSync(gitDir)
    await git(['init', '--quiet', '--bare'], { gitDir })
    await git(['fetch', '--quiet', '--no-tags', '--depth=1', url, `+refs/tags/base-${n}:refs/tags/base-${n}`], { gitDir })
    const notes = (await git(['for-each-ref', '--format=%(contents)', `refs/tags/base-${n}`], { gitDir })).trim()
    const packageJson = await git(['show', `refs/tags/base-${n}:server/package.json`], { gitDir }).catch(() => '')
    return { notes, version: versionOf(packageJson) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Reads bases from the repository at `url`, whatever the transport. */
export function gitBaseSource(url: string): BaseSource {
  return {
    async latest() {
      const { commits, withdrawn } = await advertisedBases(url)
      const offered = [...commits.keys()].filter((n) => !withdrawn.has(n))
      if (offered.length === 0) return null
      const n = Math.max(...offered)
      return { n, ...await notesOf(url, n), commit: commits.get(n)! } satisfies BaseRelease
    },
    async fetchTagsInto(root) {
      // Not forced: a base tag that moved is refused, never quietly replaced.
      await git(['fetch', '--quiet', '--no-tags', url, `${BASE_TAGS}:${BASE_TAGS}`], { cwd: root })
    },
  }
}
