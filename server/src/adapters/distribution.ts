// What a base is made of: the publisher's branch, cut down to what ships by `distribution.json` at its top, which doesn't
// ship itself. Before it is published it must hold no internal document and none of the publisher's private names, and it
// must pass the rule's checks, run on a copy of exactly those files.
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

export const DISTRIBUTION_RULE_FILE = 'distribution.json'
const CHECK_TIMEOUT_MS = 20 * 60_000
/** A lockfile's integrity hashes are random letters, which a short name can turn up in by chance. */
const LOCKFILE_INTEGRITY_LINE = /^\s*"integrity":/

export interface DistributionRule {
  /** The files and folders that ship, from the top of the source. */
  ships: string[]
  /** Names of internal documents: a file or folder with one of these names anywhere in what ships stops the publish. */
  internal: string[]
  /** Installed folders, such as node_modules, that the checks use from the publisher's source, since nothing installs them. */
  dependencies: string[]
  /** Shell commands, run in turn at the top of a copy of what ships; each must succeed. */
  checks: string[]
}

export type RuleReading = { kind: 'read'; rule: DistributionRule } | { kind: 'unusable'; why: string }

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')

/** The rule at the top of the exported branch. */
export function readDistributionRule(branchDir: string): RuleReading {
  const path = join(branchDir, DISTRIBUTION_RULE_FILE)
  if (!existsSync(path)) return { kind: 'unusable', why: `the source has no ${DISTRIBUTION_RULE_FILE} saying what ships` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { kind: 'unusable', why: `${DISTRIBUTION_RULE_FILE} isn't JSON: ${(error as Error).message}` }
  }
  const { ships, internal, dependencies, checks } = (parsed ?? {}) as Record<string, unknown>
  const needs = (field: string): RuleReading => ({ kind: 'unusable', why: `${DISTRIBUTION_RULE_FILE} needs "${field}", a list of strings` })
  if (!isStringList(ships)) return needs('ships')
  if (!isStringList(internal)) return needs('internal')
  if (!isStringList(dependencies)) return needs('dependencies')
  if (!isStringList(checks)) return needs('checks')
  const rule: DistributionRule = { ships, internal, dependencies, checks }
  const outside = [...rule.ships, ...rule.dependencies].find((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
  if (outside !== undefined) return { kind: 'unusable', why: `${DISTRIBUTION_RULE_FILE} names "${outside}", outside the source` }
  return { kind: 'read', rule }
}

/** Copies what ships from the exported branch into the empty folder `into`. Returns what the rule names that isn't there. */
export function copyWhatShips(branchDir: string, rule: DistributionRule, into: string): string[] {
  const missing: string[] = []
  for (const entry of rule.ships) {
    const from = join(branchDir, entry)
    if (!existsSync(from)) {
      missing.push(entry)
      continue
    }
    mkdirSync(dirname(join(into, entry)), { recursive: true })
    cpSync(from, join(into, entry), { recursive: true, verbatimSymlinks: true })
  }
  return missing
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return entry.isFile() ? [path] : []
  })
}

/** What in `dir` must not ship: internal documents by name, and private names in paths and file contents, as `path:line: text`. */
export function forbiddenContent(dir: string, rule: DistributionRule, privateNames: string[]): string[] {
  const names = privateNames.map((name) => name.toLowerCase())
  const named = (text: string) => names.some((name) => text.toLowerCase().includes(name))
  const found: string[] = []
  for (const file of filesUnder(dir)) {
    const path = relative(dir, file)
    const internal = path.split('/').find((segment) => rule.internal.includes(segment))
    if (internal !== undefined) found.push(`${path}: an internal document (${internal})`)
    if (named(path)) found.push(`${path}: a private name in its path`)
    const lockfile = path.endsWith('package-lock.json')
    readFileSync(file).toString('latin1').split('\n').forEach((line, index) => {
      if (lockfile && LOCKFILE_INTEGRITY_LINE.test(line)) return
      if (named(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return found
}

/** The publisher's private names: one to a line in its own file, never in the source. */
export const readPrivateNames = (file: string): string[] => readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)

export type ChecksOutcome = { kind: 'passed' } | { kind: 'failed'; check: string; output: string }

/**
 * Runs the rule's checks on a copy of what ships, so they can't change the files that are published. Dependencies are
 * linked from the publisher's source.
 */
export async function runChecks(distributionDir: string, rule: DistributionRule, sourceRoot: string): Promise<ChecksOutcome> {
  const checkDir = mkdtempSync(join(tmpdir(), 'ouro-base-checks-'))
  try {
    cpSync(distributionDir, checkDir, { recursive: true, verbatimSymlinks: true })
    for (const dependency of rule.dependencies) {
      if (!existsSync(join(sourceRoot, dependency)) || existsSync(join(checkDir, dependency))) continue
      mkdirSync(dirname(join(checkDir, dependency)), { recursive: true })
      symlinkSync(join(sourceRoot, dependency), join(checkDir, dependency))
    }
    for (const check of rule.checks) {
      const failure = await runCheck(check, checkDir)
      if (failure !== null) return { kind: 'failed', check, output: failure }
    }
    return { kind: 'passed' }
  } finally {
    rmSync(checkDir, { recursive: true, force: true })
  }
}

/** The tail of the check's output if it fails, else null. */
function runCheck(command: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(error === null ? null : (`${stdout}${stderr}`.trim() || error.message).slice(-3000))
    })
  })
}
