// Solvers: the coding agents a task is handed to. Each one runs non-interactively in the attempt's copy, with the
// task prompt on standard input, and reports its usage in the same shape the initial results used.
import { createWriteStream, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './gates.ts'
import type { AttemptPaths } from './workspace.ts'

// Input includes cached input, as in the initial results; reasoning is part of output. Unknown is null, never zero.
export interface Usage {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number | null
}

export interface SolverConfig {
  solver: 'claude' | 'codex' | 'command'
  model?: string
  effort?: string
  // For `command`: a shell command run in the copy; the prompt is on its input and in $BENCH_PROMPT_FILE.
  command?: string
}

export interface SolverRun {
  status: 'solver_finished' | 'timeout' | 'solver_error'
  exitCode: number | null
  solver_wall_seconds: number
  usage: Usage | null
  cost_usd: number | null
  turns: number | null
  models: string[]
  final_message: string
}

// The fixed frame around every prompt. The prompt itself is passed verbatim after it.
export function solverPrompt(taskPrompt: string, timeoutSeconds: number): string {
  return [
    'You are working on the Ouro source code in the current directory. The request below is your whole task.',
    'Make the change in this directory and leave it uncommitted. Make reasonable choices instead of asking questions: nobody will answer.',
    'Use the project\'s own docs and tests; `npm test` runs the fast checks. Do not install or change dependencies.',
    'Do not deploy, publish, push, start long-lived services, contact people, or touch anything outside this directory.',
    'Do not run the paid live-model tests in journeys/live.',
    `You have at most ${Math.round(timeoutSeconds / 60)} minutes.`,
    '',
    'Request:',
    taskPrompt,
  ].join('\n')
}

// Environment for a solver: none of this session's Ouro or agent variables, temporary files inside the attempt,
// and the attempt's refusing `ouro` first on the path.
export function solverEnv(paths: AttemptPaths, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^(OURO_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CODEX_)/.test(key)) continue
    env[key] = value
  }
  env.TMPDIR = paths.tmp
  env.PATH = `${paths.bin}:${base.PATH ?? ''}`
  return env
}

export function solverCommand(config: SolverConfig, paths: AttemptPaths): { command: string, args: string[] } {
  switch (config.solver) {
    case 'claude':
      return {
        command: 'claude',
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence',
          '--setting-sources', 'project', '--strict-mcp-config',
          ...(config.model ? ['--model', config.model] : []), ...(config.effort ? ['--effort', config.effort] : [])],
      }
    case 'codex':
      return {
        command: 'codex',
        args: ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox',
          '-C', paths.source, ...(config.model ? ['-m', config.model] : []),
          ...(config.effort ? ['-c', `model_reasoning_effort=${config.effort}`] : []), '-'],
      }
    case 'command':
      if (!config.command) throw new Error('the command solver needs --solver-command')
      return { command: 'sh', args: ['-c', config.command] }
  }
}

function jsonLines(output: string): Array<Record<string, unknown>> {
  return output.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return []
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
}

type Parsed = Pick<SolverRun, 'usage' | 'cost_usd' | 'turns' | 'models' | 'final_message'> & { reportedError: boolean }

// Claude Code's stream ends with a `result` event. Its `modelUsage` holds the whole session's totals per model (its
// `usage` is only the last call's); input there leaves out cache reads and writes, so they are added back.
export function parseClaude(output: string): Parsed {
  const events = jsonLines(output)
  const result = events.findLast((event) => event.type === 'result') as {
    total_cost_usd?: number, num_turns?: number, result?: string, is_error?: boolean, modelUsage?: Record<string, Record<string, number>>
  } | undefined
  const perModel = Object.values(result?.modelUsage ?? {})
  const sum = (key: string): number => perModel.reduce((total, usage) => total + (typeof usage[key] === 'number' ? usage[key] : 0), 0)
  const models = new Set<string>(Object.keys(result?.modelUsage ?? {}))
  for (const event of events) {
    const model = (event.message as { model?: string } | undefined)?.model
    if (event.type === 'assistant' && model && model !== '<synthetic>') models.add(model)
  }
  return {
    usage: perModel.length ? {
      input_tokens: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'),
      cached_input_tokens: sum('cacheReadInputTokens'),
      cache_write_input_tokens: sum('cacheCreationInputTokens'),
      output_tokens: sum('outputTokens'),
      reasoning_output_tokens: perModel.some((usage) => typeof usage.thinkingTokens === 'number') ? sum('thinkingTokens') : null,
    } : null,
    cost_usd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    models: [...models].sort(),
    final_message: typeof result?.result === 'string' ? result.result : '',
    reportedError: result?.is_error === true,
  }
}

// Codex reports usage per turn; the attempt's usage is their sum, as in the original harness.
export function parseCodex(output: string): Parsed {
  const events = jsonLines(output)
  const totals: Record<string, number> = {}
  let sawUsage = false
  let finalMessage = ''
  for (const event of events) {
    const usage = event.usage as Record<string, unknown> | undefined
    if (usage) {
      sawUsage = true
      for (const [key, value] of Object.entries(usage)) if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value
    }
    const item = event.item as { type?: string, text?: string } | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') finalMessage = item.text
  }
  return {
    usage: sawUsage ? {
      input_tokens: totals.input_tokens ?? 0,
      cached_input_tokens: totals.cached_input_tokens ?? 0,
      cache_write_input_tokens: 0,
      output_tokens: totals.output_tokens ?? 0,
      reasoning_output_tokens: totals.reasoning_output_tokens ?? null,
    } : null,
    cost_usd: null,
    turns: null,
    models: [],
    final_message: finalMessage,
    reportedError: false,
  }
}

export async function runSolver(config: SolverConfig, paths: AttemptPaths, prompt: string, options: { timeoutSeconds: number, artifacts: string }): Promise<SolverRun> {
  const { command, args } = solverCommand(config, paths)
  const events = createWriteStream(join(options.artifacts, 'events.jsonl'))
  const promptFile = join(options.artifacts, 'solver-prompt.txt')
  writeFileSync(promptFile, prompt)
  const env = { ...solverEnv(paths), BENCH_PROMPT_FILE: promptFile }
  const run = await runProcess(command, args, { cwd: paths.source, env, input: prompt, timeoutSeconds: options.timeoutSeconds, onStdout: (chunk) => events.write(chunk) })
  await new Promise((done) => events.end(done))
  writeFileSync(join(options.artifacts, 'stderr.txt'), run.stderr)
  const parsed = config.solver === 'claude' ? parseClaude(run.stdout) : config.solver === 'codex' ? parseCodex(run.stdout)
    : { usage: null, cost_usd: null, turns: null, models: [], final_message: run.stdout.trim().slice(-4000), reportedError: false }
  return {
    status: run.timedOut ? 'timeout' : run.code === 0 && !parsed.reportedError ? 'solver_finished' : 'solver_error',
    exitCode: run.code,
    solver_wall_seconds: run.seconds,
    usage: parsed.usage,
    cost_usd: parsed.cost_usd,
    turns: parsed.turns,
    models: parsed.models,
    final_message: parsed.final_message,
  }
}
