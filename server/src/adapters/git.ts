// Running `git` synchronously: local operations on one repository, short next to a turn.
import { spawnSync } from 'node:child_process'

const GIT_TIMEOUT_MS = 60_000

export function gitTry(cwd: string, ...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim() }
}

export function git(cwd: string, ...args: string[]): string {
  const result = gitTry(cwd, ...args)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${lastLines(result.output)}`)
  return result.output
}

export const lastLines = (output: string): string => output.split('\n').slice(-6).join('\n')

export const refExists = (repo: string, ref: string): boolean => gitTry(repo, 'rev-parse', '--verify', '--quiet', ref).ok
