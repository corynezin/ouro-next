// Runs tasks: one fresh copy per task, a solver with a fixed time limit, then the patch, the project's gates and the
// change in static health. Judgement comes later, from review.ts; nothing here decides whether a task was done.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import type { Task } from './catalog.ts'
import { runGates, git, trackedSources, type GateName, type GateResult } from './gates.ts'
import { compareHealth, measureTree, type HealthDelta, type StaticReport } from './metrics.ts'
import { runSolver, solverEnv, solverPrompt, type SolverConfig, type Usage } from './solvers.ts'
import { captureChange, prepareAttempt, readJson, writeJson, type ChangeSummary, type Injections } from './workspace.ts'

export interface RunOptions {
  label: string
  runsDir: string
  repo: string
  revision: string
  dependencies: string
  solver: SolverConfig
  timeoutSeconds: number
  gateTimeoutSeconds: number
  workers: number
  injections: Injections
  skipGates?: boolean
  log?: (line: string) => void
}

export interface Manifest {
  format_version: 1
  label: string
  revision: string
  solver: SolverConfig & { version: string | null }
  timeout_seconds: number
  workers: number
  task_ids: string[]
  skipped: Array<{ task_id: string, reason: string }>
  host: { cpus: number, memory_gb: number }
  created_at: string
}

// One attempt's measured outcome, in the same shape as a row of the initial results, plus what Ouro Next adds.
export interface AttemptResult {
  task_id: string
  kind: string
  difficulty: string
  area: string
  status: 'solver_finished' | 'timeout' | 'solver_error' | 'setup_error'
  solver_wall_seconds: number | null
  usage: Usage | null
  solver_started_at: string | null
  solver_finished_at: string | null
  batch: string
  model: { solver: string, model: string | null, effort: string | null, reported: string[] }
  workers: number
  cost_usd: number | null
  turns: number | null
  injected: boolean
  change: ChangeSummary | null
  gates_after: Partial<Record<GateName, Omit<GateResult, 'tail'>>> | null
  health_changes: HealthDelta[]
  error?: string
}

export interface Baseline { revision: string, gates: Record<GateName, GateResult> | null, health: StaticReport }

function solverVersion(solver: SolverConfig): string | null {
  if (solver.solver === 'command') return null
  try { return execFileSync(solver.solver, ['--version'], { encoding: 'utf8' }).trim() } catch { return null }
}

// Gates are heavy (the unit tests take minutes on a small machine): one at a time, whatever the number of workers.
let gateQueue: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = gateQueue.then(work, work)
  gateQueue = next.catch(() => undefined)
  return next
}

export function runDir(options: Pick<RunOptions, 'runsDir' | 'label'>): string {
  return join(options.runsDir, options.label)
}

export function planRun(tasks: readonly Task[], injections: Injections): { attempt: Task[], skipped: Manifest['skipped'] } {
  const attempt: Task[] = []
  const skipped: Manifest['skipped'] = []
  for (const task of tasks) {
    if (task.kind === 'debug' && !injections[task.id]) skipped.push({ task_id: task.id, reason: 'debug task without a private injection: on clean source there is no bug to find' })
    else attempt.push(task)
  }
  return { attempt, skipped }
}

export async function prepareBaseline(options: RunOptions): Promise<Baseline> {
  const dir = runDir(options)
  const path = join(dir, 'baseline.json')
  if (existsSync(path)) return readJson<Baseline>(path)
  const paths = prepareAttempt({ repo: options.repo, revision: options.revision, root: join(dir, 'baseline'), dependencies: options.dependencies })
  options.log?.('baseline: measuring the starting revision')
  const gates = options.skipGates ? null : await serially(() => runGates(paths.source, { timeoutSeconds: options.gateTimeoutSeconds, env: solverEnv(paths) }))
  const baseline: Baseline = { revision: options.revision, gates, health: measureTree(trackedSources(paths.source)) }
  writeJson(path, baseline)
  return baseline
}

export async function runTask(task: Task, options: RunOptions, baseline: Baseline): Promise<AttemptResult> {
  const artifacts = join(runDir(options), 'attempts', task.id)
  const resultPath = join(artifacts, 'result.json')
  if (existsSync(resultPath)) return readJson<AttemptResult>(resultPath)
  // An attempt cut off before it recorded a result starts again from nothing.
  rmSync(artifacts, { recursive: true, force: true })
  mkdirSync(artifacts, { recursive: true })
  const injection = options.injections[task.id]
  const result: AttemptResult = {
    task_id: task.id, kind: task.kind, difficulty: task.difficulty, area: task.area,
    status: 'setup_error', solver_wall_seconds: null, usage: null, solver_started_at: null, solver_finished_at: null,
    batch: options.label,
    model: { solver: options.solver.solver, model: options.solver.model ?? null, effort: options.solver.effort ?? null, reported: [] },
    workers: options.workers, cost_usd: null, turns: null, injected: !!injection,
    change: null, gates_after: null, health_changes: [],
  }
  try {
    const paths = prepareAttempt({ repo: options.repo, revision: options.revision, root: join(artifacts, 'workspace'), dependencies: options.dependencies, ...(injection ? { injection } : {}) })
    const prompt = solverPrompt(task.prompt, options.timeoutSeconds)
    options.log?.(`${task.id}: solving`)
    result.solver_started_at = new Date().toISOString()
    const solved = await runSolver(options.solver, paths, prompt, { timeoutSeconds: options.timeoutSeconds, artifacts })
    result.solver_finished_at = new Date().toISOString()
    Object.assign(result, {
      status: solved.status, solver_wall_seconds: solved.solver_wall_seconds, usage: solved.usage, cost_usd: solved.cost_usd, turns: solved.turns,
    })
    result.model.reported = solved.models
    writeFileSync(join(artifacts, 'final-message.txt'), solved.final_message)
    const { patch, change } = captureChange(paths.source)
    writeFileSync(join(artifacts, 'change.patch'), patch)
    result.change = change
    if (!options.skipGates && change.files > 0) {
      options.log?.(`${task.id}: checking (${change.files} files changed)`)
      const gates = await serially(() => runGates(paths.source, { timeoutSeconds: options.gateTimeoutSeconds, env: solverEnv(paths) }))
      writeJson(join(artifacts, 'gates.json'), gates)
      result.gates_after = Object.fromEntries(Object.entries(gates).map(([name, { tail: _, ...gate }]) => [name, gate]))
    }
    result.health_changes = compareHealth(baseline.health.health, measureTree(trackedSources(paths.source)).health)
      .filter((delta) => delta.change !== 0)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  writeJson(resultPath, result)
  options.log?.(`${task.id}: ${result.status}${result.solver_wall_seconds !== null ? ` in ${result.solver_wall_seconds}s` : ''}${result.error ? ` (${result.error})` : ''}`)
  return result
}

export async function runTasks(tasks: readonly Task[], options: RunOptions): Promise<AttemptResult[]> {
  const dir = runDir(options)
  mkdirSync(dir, { recursive: true })
  const { attempt, skipped } = planRun(tasks, options.injections)
  const manifestPath = join(dir, 'run.json')
  const manifest: Manifest = existsSync(manifestPath) ? readJson<Manifest>(manifestPath) : {
    format_version: 1,
    label: options.label,
    revision: options.revision,
    solver: { ...options.solver, version: solverVersion(options.solver) },
    timeout_seconds: options.timeoutSeconds,
    workers: options.workers,
    task_ids: [],
    skipped: [],
    host: { cpus: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30) },
    created_at: new Date().toISOString(),
  }
  if (manifest.revision !== options.revision) throw new Error(`run ${options.label} is pinned to ${manifest.revision}; start a new label for ${options.revision}`)
  manifest.task_ids = [...new Set([...manifest.task_ids, ...attempt.map((task) => task.id)])]
  manifest.skipped = [...new Map([...manifest.skipped, ...skipped].map((entry) => [entry.task_id, entry])).values()]
    .filter((entry) => !manifest.task_ids.includes(entry.task_id))
  writeJson(manifestPath, manifest)
  const baseline = await prepareBaseline(options)
  const results: AttemptResult[] = []
  const queue = [...attempt]
  await Promise.all(Array.from({ length: Math.max(1, options.workers) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) results.push(await runTask(task, options, baseline))
  }))
  const order = new Map(attempt.map((task, index) => [task.id, index]))
  return results.sort((a, b) => order.get(a.task_id)! - order.get(b.task_id)!)
}

export function resolveRevision(repo: string, revision: string): string {
  return git(repo, 'rev-parse', '--verify', `${revision}^{commit}`).trim()
}
