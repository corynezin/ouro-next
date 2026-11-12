// The project's own checks, run as gates: an import-direction lint, the type check and the unit tests.
// Also the file listing and process helpers that the health report and the task runner share.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceFile } from './metrics.ts'

export interface ProcessResult { code: number | null, signal: string | null, timedOut: boolean, seconds: number, stdout: string, stderr: string }

// Runs a command in its own process group, so a timeout stops everything it started, not just the shell.
export function runProcess(command: string, args: readonly string[], options: {
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutSeconds: number
  graceSeconds?: number
  onStdout?: (chunk: string) => void
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const signalGroup = (signal: NodeJS.Signals): void => {
      try { process.kill(-child.pid!, signal) } catch { /* already gone */ }
    }
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      killer = setTimeout(() => signalGroup('SIGKILL'), (options.graceSeconds ?? 8) * 1000)
    }, options.timeoutSeconds * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (killer) clearTimeout(killer)
      // Anything the command left running in its group goes with it.
      signalGroup('SIGKILL')
      resolve({ code, signal, timedOut, seconds: Math.round(performance.now() - started) / 1000, stdout, stderr })
    })
    child.stdin.on('error', () => { /* the command need not read its input */ })
    child.stdin.end(options.input ?? '')
  })
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

// The TypeScript the project tracks, without the benchmark itself, declaration files or installed packages.
export function trackedSources(root: string): SourceFile[] {
  return git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0')
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !path.startsWith('benchmarks/') && !path.includes('node_modules/'))
    .sort()
    .flatMap((path) => {
      try { return [{ path, text: readFileSync(join(root, path), 'utf8') }] } catch { return [] }
    })
}

export const gateScripts = ['lint:imports', 'typecheck', 'test:unit'] as const
export type GateName = typeof gateScripts[number]

export interface GateResult {
  passed: boolean
  timedOut: boolean
  seconds: number
  tests?: { total: number, passed: number, failed: number, skipped: number }
  // The last lines of output, enough to see why a gate failed without keeping whole logs in results.
  tail: string
}

export function parseTestCounts(output: string): GateResult['tests'] | undefined {
  const count = (label: string): number | undefined => {
    const match = new RegExp(`^[ℹ#] ${label} (\\d+)$`, 'm').exec(output)
    return match ? Number(match[1]) : undefined
  }
  const total = count('tests')
  if (total === undefined) return undefined
  return { total, passed: count('pass') ?? 0, failed: count('fail') ?? 0, skipped: (count('skipped') ?? 0) + (count('todo') ?? 0) }
}

export function tail(text: string, lines = 30): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

export async function runGates(cwd: string, options: { timeoutSeconds: number, env?: NodeJS.ProcessEnv, only?: readonly GateName[] }): Promise<Record<GateName, GateResult>> {
  const results = {} as Record<GateName, GateResult>
  for (const script of options.only ?? gateScripts) {
    const run = await runProcess('npm', ['run', '--silent', script], { cwd, env: options.env, timeoutSeconds: options.timeoutSeconds })
    const output = `${run.stdout}\n${run.stderr}`
    const tests = script === 'test:unit' ? parseTestCounts(run.stdout) : undefined
    results[script] = { passed: run.code === 0 && !run.timedOut, timedOut: run.timedOut, seconds: run.seconds, ...(tests ? { tests } : {}), tail: tail(output) }
  }
  return results
}
