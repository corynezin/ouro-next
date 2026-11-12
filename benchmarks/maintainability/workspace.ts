// An attempt's workspace: a fresh copy of one source revision with a single starting commit and no history,
// the benchmark itself left out, an optional private regression folded in, and the base checkout's installed packages.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { git } from './gates.ts'
import { isTestPath } from './metrics.ts'

// A regression for a debugging task. Kept outside this repository: the prompts are public, the causes must not be.
export interface Injection { edits: Array<{ path: string, find: string, replace: string }> }
export type Injections = Record<string, Injection>

export function loadInjections(path: string | undefined): Injections {
  if (!path) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Injections
  for (const [id, injection] of Object.entries(parsed)) {
    if (!/^T\d{3}$/.test(id) || !Array.isArray(injection.edits) || !injection.edits.length) throw new Error(`injection ${id} needs a task id and at least one edit`)
  }
  return parsed
}

export function applyInjection(root: string, injection: Injection): void {
  for (const edit of injection.edits) {
    const path = join(root, edit.path)
    const text = readFileSync(path, 'utf8')
    const at = text.indexOf(edit.find)
    if (at < 0 || text.indexOf(edit.find, at + 1) >= 0) throw new Error(`injection edit for ${edit.path} must match exactly once`)
    const { atime, mtime } = statSync(path)
    writeFileSync(path, text.slice(0, at) + edit.replace + text.slice(at + edit.find.length))
    // Keep the old timestamps so the changed file doesn't stand out.
    utimesSync(path, atime, mtime)
  }
}

export interface AttemptPaths { root: string, source: string, bin: string, tmp: string }

// `tmp` is a link to a short directory in the system's: tests make Unix sockets there, and a socket path over
// about 100 characters can't be listened on, which deep run folders would otherwise reach.
export function attemptPaths(root: string): AttemptPaths {
  const link = join(root, 'tmp')
  return { root, source: join(root, 'src'), bin: join(root, 'bin'), tmp: existsSync(link) ? realpathSync(link) : link }
}

// Gives the copy the base checkout's installed packages, except the workspace links (@ouro/*), which must point at the
// copy's own packages, or its checks would test the base checkout's code instead.
export function linkDependencies(source: string, base: string): void {
  const baseModules = join(base, 'node_modules')
  if (!existsSync(baseModules)) throw new Error(`${base} has no node_modules: run npm ci there first`)
  const modules = join(source, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const entry of readdirSync(baseModules)) {
    if (entry === '@ouro') continue
    symlinkSync(join(baseModules, entry), join(modules, entry))
  }
  const workspaceLinks = join(baseModules, '@ouro')
  if (existsSync(workspaceLinks)) {
    mkdirSync(join(modules, '@ouro'))
    for (const entry of readdirSync(workspaceLinks)) {
      const link = join(workspaceLinks, entry)
      const target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : undefined
      if (!target || target.startsWith('/')) throw new Error(`${link} should be a relative workspace link`)
      symlinkSync(target, join(modules, '@ouro', entry))
    }
  }
  // Workspaces with their own packages, such as the app's own TypeScript.
  for (const nested of ['apps/mobile', 'server', 'guardian', 'hub', 'tools', 'packages/contract']) {
    const from = join(base, nested, 'node_modules')
    if (existsSync(from) && existsSync(join(source, nested))) symlinkSync(resolve(from), join(source, nested, 'node_modules'))
  }
}

const commitEnv = {
  GIT_AUTHOR_NAME: 'Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@localhost', GIT_COMMITTER_NAME: 'Benchmark',
  GIT_COMMITTER_EMAIL: 'benchmark@localhost', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

export function prepareAttempt(options: { repo: string, revision: string, root: string, dependencies: string, injection?: Injection }): AttemptPaths {
  if (existsSync(join(options.root, 'src'))) throw new Error(`${options.root} already has a copy`)
  for (const dir of ['src', 'bin']) mkdirSync(join(options.root, dir), { recursive: true })
  symlinkSync(mkdtempSync(join(tmpdir(), 'ob-')), join(options.root, 'tmp'))
  const paths = attemptPaths(options.root)
  const archive = execFileSync('git', ['archive', '--format=tar', options.revision, '--', '.', ':(exclude)benchmarks'],
    { cwd: options.repo, maxBuffer: 1024 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', paths.source], { input: archive })
  if (options.injection) applyInjection(paths.source, options.injection)
  git(paths.source, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(paths.source, '.git/info/exclude'), 'node_modules\n')
  git(paths.source, 'add', '-A')
  execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', 'Starting point'], { cwd: paths.source, env: { ...process.env, ...commitEnv } })
  linkDependencies(paths.source, options.dependencies)
  // Solvers work on a copy, not on this computer's Ouro: its CLI answers with a refusal inside an attempt.
  const shim = join(paths.bin, 'ouro')
  writeFileSync(shim, '#!/bin/sh\necho "ouro is not available inside a benchmark attempt" >&2\nexit 1\n')
  chmodSync(shim, 0o755)
  return paths
}

export interface ChangeSummary {
  files: number
  testFiles: number
  addedLines: number
  deletedLines: number
  paths: string[]
}

// Stages everything the solver left (new files too) and returns the patch against the starting commit.
export function captureChange(source: string): { patch: string, change: ChangeSummary } {
  git(source, 'add', '-A')
  const patch = git(source, 'diff', '--cached', '--binary', 'HEAD')
  const rows = git(source, 'diff', '--cached', '--numstat', 'HEAD').trim().split('\n').filter(Boolean).map((line) => {
    const [added, deleted, ...path] = line.split('\t')
    return { added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted), path: path.join('\t') }
  })
  return {
    patch,
    change: {
      files: rows.length,
      testFiles: rows.filter((row) => isTestPath(row.path)).length,
      addedLines: rows.reduce((sum, row) => sum + row.added, 0),
      deletedLines: rows.reduce((sum, row) => sum + row.deleted, 0),
      paths: rows.map((row) => row.path),
    },
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
