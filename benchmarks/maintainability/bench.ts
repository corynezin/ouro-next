// The benchmark's command line. `node benchmarks/maintainability/bench.ts help` lists the commands.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { benchmarkDir, loadCatalog, parseIds, selectTasks } from './catalog.ts'
import { gateScripts, runGates, trackedSources } from './gates.ts'
import { compareHealth, measureTree, type StaticHealth } from './metrics.ts'
import { acceptReview, agentReview, attributions, loadRubric, readReview, recordReview, verdicts, type Verdict } from './review.ts'
import { resolveRevision, runDir, runTasks } from './run.ts'
import { compareWithInitial, healthTable, loadRun, report, summarize, type InitialRow } from './summarize.ts'
import type { SolverConfig } from './solvers.ts'
import { loadInjections, prepareAttempt, readJson, writeJson } from './workspace.ts'

const repoRoot = resolve(benchmarkDir, '../..')
const defaultRunsDir = process.env.OURO_BENCH_RUNS ?? join(homedir(), 'ouro-bench-runs')

const usage = `Ouro Next maintainability benchmark

  health [--rev REV] [--gates] [--out FILE]      static health of the working tree, or of a commit; --gates also runs the project's checks
  health-compare BEFORE.json AFTER.json          indicator by indicator, which way each moved
  run --label L [selection] [solver] [options]   attempt tasks, one fresh copy each
  review --label L [--ids ...] [--rubric FILE]   agent review of attempts that have none yet
  record --label L --id T001 --verdict V --reason "..." [--attribution a,b] [--by NAME]
  accept --label L --ids T001,... --by NAME      a person accepts the recorded judgements
  summarize --label L[,L2...] [--out DIR]        results.json and REPORT.md, compared with the original baseline
  list [selection]                               the selected tasks

selection: --ids T001,T010-T020  --kind feature,change,debug  --difficulty easy,medium,hard  --every N  --limit N
solver:    --solver claude|codex|command  --model M  --effort E  --solver-command "sh command"
options:   --rev REV (default HEAD)  --timeout 1200  --gate-timeout 900  --workers 1  --injections FILE  --skip-gates
           --runs DIR (default $OURO_BENCH_RUNS or ~/ouro-bench-runs)  --deps DIR (a checkout with node_modules; default this one)
verdicts:  ${verdicts.join(', ')}
attribution: ${attributions.join(', ')}`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string' }, ids: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' }, difficulty: { type: 'string' },
    every: { type: 'string' }, limit: { type: 'string' }, solver: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'solver-command': { type: 'string' }, rev: { type: 'string' }, timeout: { type: 'string' }, 'gate-timeout': { type: 'string' },
    workers: { type: 'string' }, injections: { type: 'string' }, 'skip-gates': { type: 'boolean' }, runs: { type: 'string' }, deps: { type: 'string' },
    gates: { type: 'boolean' }, out: { type: 'string' }, rubric: { type: 'string' }, verdict: { type: 'string' }, reason: { type: 'string' },
    attribution: { type: 'string' }, by: { type: 'string' },
  },
})

const list = (value: string | undefined): string[] => value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []
const number = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`"${value}" should be a positive number`)
  return parsed
}
const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`--${name} is needed`)
  return value
}
const runsDir = resolve(values.runs ?? defaultRunsDir)

function selection() {
  const catalog = loadCatalog()
  const tasks = selectTasks(catalog, {
    ids: values.ids ? parseIds(values.ids) : [], kinds: list(values.kind), difficulties: list(values.difficulty),
    ...(values.every ? { every: number(values.every, 1) } : {}), ...(values.limit ? { limit: number(values.limit, 100) } : {}),
  })
  return { catalog, tasks }
}

function solverConfig(): SolverConfig {
  const solver = (values.solver ?? 'claude') as SolverConfig['solver']
  if (!['claude', 'codex', 'command'].includes(solver)) throw new Error('--solver is claude, codex or command')
  return { solver, ...(values.model ? { model: values.model } : {}), ...(values.effort ? { effort: values.effort } : {}),
    ...(values['solver-command'] ? { command: values['solver-command'] } : {}) }
}

async function health(): Promise<void> {
  let root = repoRoot
  let cleanup: (() => void) | undefined
  let revision = 'working tree'
  if (values.rev) {
    revision = resolveRevision(repoRoot, values.rev)
    const scratch = mkdtempSync(join(tmpdir(), 'ouro-health-'))
    root = prepareAttempt({ repo: repoRoot, revision, root: scratch, dependencies: values.deps ? resolve(values.deps) : repoRoot }).source
    cleanup = () => rmSync(scratch, { recursive: true, force: true })
  }
  try {
    const started = performance.now()
    const measured = measureTree(trackedSources(root))
    const gates = values.gates ? await runGates(root, { timeoutSeconds: number(values['gate-timeout'], 900) }) : null
    const result = { format_version: 1, revision, measured_at: new Date().toISOString(), seconds: Math.round(performance.now() - started) / 1000, gates, ...measured }
    if (values.out) writeJson(resolve(values.out), result)
    console.log(healthTable(measured.health))
    if (gates) for (const name of gateScripts) console.log(`${name}: ${gates[name].passed ? 'passed' : 'FAILED'} in ${gates[name].seconds}s${gates[name].tests ? ` (${gates[name].tests!.passed}/${gates[name].tests!.total} tests)` : ''}`)
    console.log(`\nMost complex: ${measured.worst.complexFunctions.slice(0, 5).map((fn) => `${fn.path}:${fn.line} ${fn.name} (${fn.complexity})`).join(', ')}`)
    console.log(`Largest files: ${measured.worst.largeFiles.slice(0, 5).map((file) => `${file.path} (${file.codeLines})`).join(', ')}`)
    if (values.out) console.log(`\nWrote ${values.out}`)
  } finally {
    cleanup?.()
  }
}

function healthCompare(): void {
  const [before, after] = positionals.slice(1)
  if (!before || !after) throw new Error('health-compare needs two reports')
  const read = (path: string): StaticHealth => readJson<{ health: StaticHealth }>(path).health
  console.log(healthTable(read(after), read(before)))
  const deltas = compareHealth(read(before), read(after))
  const worse = deltas.filter((delta) => delta.verdict === 'worse')
  console.log(`\n${deltas.filter((delta) => delta.verdict === 'better').length} better, ${worse.length} worse${worse.length ? `: ${worse.map((delta) => delta.indicator).join(', ')}` : ''}`)
  process.exitCode = worse.length ? 1 : 0
}

async function run(): Promise<void> {
  const label = required(values.label, 'label')
  if (!/^[\w.-]+$/.test(label)) throw new Error('a label is letters, digits, dots, dashes and underscores')
  const { tasks } = selection()
  if (!tasks.length) throw new Error('the selection has no tasks')
  const timeoutSeconds = number(values.timeout, 1200)
  const results = await runTasks(tasks, {
    label, runsDir, repo: repoRoot, revision: resolveRevision(repoRoot, values.rev ?? 'HEAD'),
    dependencies: values.deps ? resolve(values.deps) : repoRoot, solver: solverConfig(), timeoutSeconds,
    gateTimeoutSeconds: number(values['gate-timeout'], 900), workers: number(values.workers, 1),
    injections: loadInjections(values.injections), skipGates: values['skip-gates'] ?? false,
    log: (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  })
  const manifest = readJson<{ skipped: Array<{ task_id: string }> }>(join(runDir({ runsDir, label }), 'run.json'))
  console.log(`\n${results.length} attempted, ${manifest.skipped.length} skipped. Next: review --label ${label}`)
}

async function review(): Promise<void> {
  const label = required(values.label, 'label')
  const dir = runDir({ runsDir, label })
  const { catalog } = selection()
  const ids = values.ids ? new Set(parseIds(values.ids)) : undefined
  const rubric = loadRubric(values.rubric)
  const reviewer: SolverConfig = { ...solverConfig(), solver: values.solver === 'codex' ? 'codex' : 'claude' }
  const pending = loadRun(dir).rows.filter((row) => (!ids || ids.has(row.task_id)) && !readReview(dir, row.task_id))
  for (const row of pending) {
    const task = catalog.find((entry) => entry.id === row.task_id)!
    console.log(`${task.id}: reviewing`)
    const outcome = await agentReview(dir, task, reviewer, { ...(rubric[task.id] ? { note: rubric[task.id] } : {}), timeoutSeconds: number(values.timeout, 900) })
    console.log('error' in outcome ? `${task.id}: ${outcome.error}` : `${task.id}: ${outcome.verdict}: ${outcome.reason}`)
  }
  if (!pending.length) console.log('Every selected attempt already has a review.')
}

function record(): void {
  const label = required(values.label, 'label')
  const id = required(values.id, 'id')
  const dir = runDir({ runsDir, label })
  if (!existsSync(join(dir, 'attempts', id, 'result.json'))) throw new Error(`${label} has no attempt at ${id}`)
  const by = values.by ?? 'human'
  const recorded = recordReview(dir, { task_id: id, verdict: required(values.verdict, 'verdict') as Verdict, reason: required(values.reason, 'reason'),
    attribution: list(values.attribution), reviewer: `human:${by}`, accepted_by_human: true })
  console.log(`${id}: ${recorded.verdict}`)
}

function accept(): void {
  const dir = runDir({ runsDir, label: required(values.label, 'label') })
  for (const id of parseIds(required(values.ids, 'ids'))) console.log(`${id}: accepted ${acceptReview(dir, id, required(values.by, 'by')).verdict}`)
}

function summarizeRuns(): void {
  const labels = list(required(values.label, 'label'))
  const runs = labels.map((label) => loadRun(runDir({ runsDir, label })))
  const summary = summarize(runs, loadCatalog().length)
  const initial = readJson<{ rows: InitialRow[] }>(join(benchmarkDir, 'initial-results.json'))
  const comparison = compareWithInitial(summary, initial.rows)
  const out = resolve(values.out ?? runDir({ runsDir, label: labels.at(-1)! }))
  writeJson(join(out, 'results.json'), { ...summary, comparison_with_initial: comparison })
  writeFileSync(join(out, 'REPORT.md'), report(summary, comparison))
  console.log(report(summary, comparison))
  console.log(`Wrote ${join(out, 'results.json')} and REPORT.md`)
}

function listTasks(): void {
  for (const task of selection().tasks) console.log(`${task.id}  ${task.kind.padEnd(7)} ${task.difficulty.padEnd(6)} ${task.area.padEnd(28)} ${task.prompt}`)
}

const commands: Record<string, () => void | Promise<void>> = {
  health, 'health-compare': healthCompare, run, review, record, accept, summarize: summarizeRuns, list: listTasks,
  help: () => console.log(usage),
}

const command = commands[positionals[0] ?? 'help']
if (!command) {
  console.error(usage)
  process.exitCode = 2
} else {
  try {
    await command()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
