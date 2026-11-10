// The port for the cheap model that writes summaries, and its two adapters. It is a single question and answer: no
// session, no tools, no project settings, so the summarizer can't act as the agent or wake anyone.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SummarizeRequest {
  model: string
  instructions: string
  digest: string
}

export interface SummarizeAnswer {
  text: string
  costUsd: number
}

/** A failed attempt can still have cost something, and that counts. */
export class SummarizeFailed extends Error {
  readonly costUsd: number
  constructor(message: string, costUsd: number) {
    super(message)
    this.costUsd = costUsd
  }
}

export type Summarize = (request: SummarizeRequest) => Promise<SummarizeAnswer>

/** In a digest, this line makes the stand-in fail, for tests of failure and backoff. */
export const STAND_IN_SUMMARY_FAILURE = 'standin-summary: fail'

/** Free and deterministic: the line names the first tool step it was shown, the details the latest four. */
export const standInSummarize: Summarize = async ({ digest }) => {
  if (digest.includes(STAND_IN_SUMMARY_FAILURE)) throw new SummarizeFailed('the stand-in summarizer was told to fail', 0)
  const steps = digest.split('\n').filter((line) => line.includes(' ▸ ')).map((line) => line.split(' ▸ ')[1]!)
  return { text: JSON.stringify({ line: `stand-in: ${steps[0] ?? 'talked'}`, details: steps.slice(-4) }), costUsd: 0 }
}

const CLAUDE_TIMEOUT_MS = 90_000

export function claudeSummarize(claudeBin: string, env: Record<string, string>): Summarize {
  return ({ model, instructions, digest }) => new Promise((resolve, reject) => {
    // An empty folder: no CLAUDE.md or project settings reach the summarizer.
    const cwd = mkdtempSync(join(tmpdir(), 'ouro-summary-'))
    const args = ['-p', '--model', model, '--no-session-persistence', '--output-format', 'json', '--tools', '', '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt', instructions]
    const child = spawn(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    const finish = () => {
      clearTimeout(timer)
      rmSync(cwd, { recursive: true, force: true })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new SummarizeFailed(`no answer within ${CLAUDE_TIMEOUT_MS / 1000} s`, 0))
    }, CLAUDE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      finish()
      reject(new SummarizeFailed(error.message, 0))
    })
    child.on('close', (code) => {
      finish()
      let result: { result?: unknown; total_cost_usd?: unknown; is_error?: unknown }
      try {
        result = JSON.parse(output) as typeof result
      } catch {
        reject(new SummarizeFailed(`claude exited ${code}: ${(errors || output).trim().slice(0, 200)}`, 0))
        return
      }
      const costUsd = Number(result.total_cost_usd) || 0
      if (result.is_error === true || code !== 0) {
        reject(new SummarizeFailed(`claude: ${String(result.result ?? errors).trim().slice(0, 200)}`, costUsd))
        return
      }
      resolve({ text: String(result.result ?? ''), costUsd })
    })
    child.stdin.end(digest)
  })
}
