import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { joinCatalog, loadCatalog, parseIds, selectTasks } from './catalog.ts'
import { parseTestCounts, runProcess } from './gates.ts'
import { compareHealth, componentOf, duplication, importCycles, isTestPath, measureFile, measureTree } from './metrics.ts'
import { parseVerdict, loadRubric } from './review.ts'
import { planRun, runTasks } from './run.ts'
import { parseClaude, parseCodex, solverEnv } from './solvers.ts'
import { compareWithInitial, loadRun, report, score, summarize, type InitialRow } from './summarize.ts'
import { applyInjection, attemptPaths, captureChange } from './workspace.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'ouro-bench-test-'))

test('the catalog joins all 100 prompts to their labels, and selections narrow it', () => {
  const catalog = loadCatalog()
  assert.equal(catalog.length, 100)
  assert.equal(new Set(catalog.map((task) => task.id)).size, 100)
  assert.deepEqual([...new Set(catalog.map((task) => task.kind))].sort(), ['change', 'debug', 'feature'])
  assert.equal(catalog.filter((task) => task.kind === 'debug').length, 30)
  assert.deepEqual(parseIds('T001,T008-T010'), ['T001', 'T008', 'T009', 'T010'])
  assert.throws(() => parseIds('T010-T008'), /backwards/)
  assert.throws(() => parseIds('7'), /isn't a task id/)
  assert.deepEqual(selectTasks(catalog, { kinds: ['feature'], difficulties: ['easy'], limit: 2 }).map((task) => task.id), ['T001', 'T002'])
  assert.equal(selectTasks(catalog, { every: 10 }).length, 10)
  assert.throws(() => selectTasks(catalog, { ids: ['T999'] }), /no task T999/)
  assert.throws(() => joinCatalog([{ id: 'T001', prompt: 'a' }], []), /no kind/)
  assert.throws(() => joinCatalog([{ id: 'T001', prompt: 'a' }, { id: 'T001', prompt: 'b' }], [{ task_id: 'T001', kind: 'change', difficulty: 'easy', area: 'x' }]), /twice/)
})

test('debug tasks wait for a private injection; the others run on clean source', () => {
  const tasks = loadCatalog().filter((task) => ['T001', 'T071', 'T072'].includes(task.id))
  const plan = planRun(tasks, { T072: { edits: [{ path: 'a', find: 'b', replace: 'c' }] } })
  assert.deepEqual(plan.attempt.map((task) => task.id), ['T001', 'T072'])
  assert.deepEqual(plan.skipped.map((entry) => entry.task_id), ['T071'])
})

test('a function counts its own branches, not those of functions inside it', () => {
  const file = measureFile({ path: 'server/src/domain/a.ts', text: [
    'export function pick(a: number, b?: string): string {',
    '  if (a > 1 && b) return b',
    '  const inner = (x: number) => x > 0 ? 1 : 2',
    '  for (const c of [1]) { try { inner(c) } catch { return "e" } }',
    '  return b ?? "z"',
    '}',
    'const value = undefined as unknown as any',
    'const forced = value!',
    '// TODO: tidy',
  ].join('\n') })
  const pick = file.functions.find((fn) => fn.name === 'pick')!
  assert.equal(pick.complexity, 1 + 1 + 1 + 1 + 1 + 1) // if, &&, for, catch, ??
  assert.equal(file.functions.find((fn) => fn.name === 'inner')!.complexity, 2)
  assert.equal(pick.lines, 6)
  assert.equal(file.anyTypes, 1)
  assert.equal(file.doubleCasts, 1)
  assert.equal(file.nonNullAssertions, 1)
  assert.equal(file.markers, 1)
  assert.equal(file.component, 'server/domain')
})

test('files are placed in components and tests are told apart', () => {
  assert.equal(componentOf('apps/mobile/src/features/chat/Chat.tsx'), 'mobile/features')
  assert.equal(componentOf('packages/contract/src/index.ts'), 'packages/contract')
  assert.equal(componentOf('hub/src/main.ts'), 'hub')
  assert.ok(isTestPath('server/src/app/core.test.ts'))
  assert.ok(isTestPath('journeys/chat.journey.ts'))
  assert.ok(!isTestPath('server/src/app/core.ts'))
})

test('repeated runs of lines count as duplication, and import cycles are found', () => {
  const block = Array.from({ length: 8 }, (_, index) => `  total += values[${index}] * weight`).join('\n')
  const result = duplication([{ path: 'a.ts', text: block }, { path: 'b.ts', text: `${block}\nconst other = 1` }, { path: 'c.ts', text: 'const lonely = 2' }])
  assert.equal(result.duplicatedLines, 16)
  assert.equal(result.lines, 18)
  const cycles = importCycles([
    measureFile({ path: 'x/a.ts', text: "import { b } from './b.ts'" }),
    measureFile({ path: 'x/b.ts', text: "export { a } from './a.ts'" }),
    measureFile({ path: 'x/c.ts', text: "import { a } from './a.ts'" }),
  ])
  assert.deepEqual(cycles, [['x/a.ts', 'x/b.ts']])
})

test('health comparisons know which way is better', () => {
  const before = measureTree([{ path: 'a.ts', text: 'export const f = (a: number) => a' }, { path: 'a.test.ts', text: 'f(1)' }]).health
  const after = { ...before, anyTypes: before.anyTypes + 2, testToSourceRatio: before.testToSourceRatio + 1, sourceCodeLines: 99 }
  const deltas = Object.fromEntries(compareHealth(before, after).map((delta) => [delta.indicator, delta.verdict]))
  assert.equal(deltas.anyTypes, 'worse')
  assert.equal(deltas.testToSourceRatio, 'better')
  assert.equal(deltas.sourceCodeLines, 'context')
  assert.equal(deltas.markers, 'same')
})

test('solver output becomes usage in the initial results\' shape, and unknown stays null', () => {
  const claude = [
    '{"type":"system"}',
    '{"type":"assistant","message":{"model":"claude-x","content":[]}}',
    '{"type":"result","is_error":false,"num_turns":4,"total_cost_usd":0.5,"result":"Done.","usage":{"input_tokens":1,"output_tokens":1},'
      + '"modelUsage":{"claude-x":{"inputTokens":6,"outputTokens":5,"cacheReadInputTokens":60,"cacheCreationInputTokens":10,"thinkingTokens":1},'
      + '"claude-y":{"inputTokens":4,"outputTokens":2,"cacheReadInputTokens":40,"cacheCreationInputTokens":10,"thinkingTokens":0}}}',
  ].join('\n')
  const parsed = parseClaude(claude)
  assert.deepEqual(parsed.usage, { input_tokens: 130, cached_input_tokens: 100, cache_write_input_tokens: 20, output_tokens: 7, reasoning_output_tokens: 1 })
  assert.equal(parsed.cost_usd, 0.5)
  assert.deepEqual(parsed.models, ['claude-x', 'claude-y'])
  assert.equal(parseClaude('{"type":"system"}\nnot json').usage, null)
  const codex = parseCodex([
    '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":40,"output_tokens":5,"reasoning_output_tokens":2}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"All done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
  ].join('\n'))
  assert.deepEqual(codex.usage, { input_tokens: 60, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 2 })
  assert.equal(codex.final_message, 'All done')
})

test('a solver sees none of this session\'s Ouro or agent variables', () => {
  const env = solverEnv(attemptPaths('/runs/a'), { PATH: '/usr/bin', HOME: '/h', OURO_SOCKET: 's', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_API_KEY: 'k' })
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'PATH', 'TMPDIR'])
  assert.equal(env.PATH, '/runs/a/bin:/usr/bin')
})

test('test counts come from the node test runner\'s summary', () => {
  assert.deepEqual(parseTestCounts('ok\nℹ tests 12\nℹ pass 10\nℹ fail 1\nℹ skipped 1\nℹ todo 0\n'), { total: 12, passed: 10, failed: 1, skipped: 1 })
  assert.equal(parseTestCounts('no summary'), undefined)
})

test('a timed-out process is stopped with everything it started', async () => {
  const run = await runProcess('sh', ['-c', 'sleep 30 & sleep 30'], { cwd: tmpdir(), timeoutSeconds: 0.3, graceSeconds: 0.2 })
  assert.equal(run.timedOut, true)
  assert.ok(run.seconds < 5)
})

test('an injection must match exactly once, and keeps the file\'s timestamps', () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, 'a.ts'), 'if (a <= b) x()\nif (c) y()\n')
    const before = execFileSync('stat', ['-c', '%Y', join(dir, 'a.ts')], { encoding: 'utf8' })
    applyInjection(dir, { edits: [{ path: 'a.ts', find: 'a <= b', replace: 'a < b' }] })
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'if (a < b) x()\nif (c) y()\n')
    assert.equal(execFileSync('stat', ['-c', '%Y', join(dir, 'a.ts')], { encoding: 'utf8' }), before)
    assert.throws(() => applyInjection(dir, { edits: [{ path: 'a.ts', find: 'if', replace: 'when' }] }), /exactly once/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reviewer\'s verdict is the last JSON line naming one; private notes load in either shape', () => {
  const text = 'I looked.\n{"verdict": "maybe"}\nFinally:\n{"verdict": "partial", "reason": "Half of it.", "attribution": ["implementation", "made-up"]}'
  assert.deepEqual(parseVerdict(text), { verdict: 'partial', reason: 'Half of it.', attribution: ['implementation'] })
  assert.equal(parseVerdict('no verdict here'), undefined)
  const dir = scratch()
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ tasks: [{ id: 'T001', review: 'Filters by name.' }, { id: 'T002' }] }))
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ T003: 'Counts characters.' }))
    assert.deepEqual(loadRubric(join(dir, 'a.json')), { T001: 'Filters by name.' })
    assert.deepEqual(loadRubric(join(dir, 'b.json')), { T003: 'Counts characters.' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the score counts partial as half and leaves out tasks that could not be judged fairly', () => {
  assert.deepEqual(score([{ judgement: 'complete' }, { judgement: 'partial' }, { judgement: 'failed' }, { judgement: 'invalid_task' }, { judgement: null }]),
    { scored: 3, complete_rate: 0.333, weighted: 0.5 })
  assert.deepEqual(score([]), { scored: 0, complete_rate: null, weighted: null })
})

test('the initial results summarize to their own published totals', () => {
  const initial = JSON.parse(readFileSync(join(import.meta.dirname, 'initial-results.json'), 'utf8')) as { rows: InitialRow[], judgements: Record<string, number> }
  const comparison = compareWithInitial({ rows: initial.rows.map((row) => ({ ...row })) as never }, initial.rows)
  assert.equal(comparison.paired_tasks, 100)
  assert.equal(comparison.initial.complete, initial.judgements.complete)
  assert.equal(comparison.initial.solver_wall_seconds, 18230.359)
  assert.equal(comparison.initial.median_seconds, 153.417)
  assert.deepEqual(comparison.initial.usage_missing_ids, ['T092'])
  assert.equal(comparison.initial.output_tokens, 581518)
  assert.equal(comparison.transitions['complete->complete'], 64)
})

// A whole run end to end with a scripted solver on a tiny repository: copy, solve, capture, measure, review, summarize.
test('a run copies the source without history or the benchmark, captures the change and summarizes', async () => {
  const dir = scratch()
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'benchmarks/maintainability'), { recursive: true })
    mkdirSync(join(repo, 'node_modules/@ouro'), { recursive: true })
    mkdirSync(join(repo, 'node_modules/left-pad'))
    symlinkSync('../../src', join(repo, 'node_modules/@ouro/src'))
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(repo, 'benchmarks/maintainability/secret.json'), '{}')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one'], { cwd: repo })
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const tasks = loadCatalog().filter((task) => task.id === 'T001' || task.id === 'T071')
    const solver = {
      solver: 'command' as const,
      command: 'test ! -e benchmarks && test "$(git log --oneline | wc -l)" = 1 && test -z "$OURO_SOCKET" && ! ouro list 2>/dev/null'
        + ' && grep -q "Archived screen" "$BENCH_PROMPT_FILE" && printf "export const b = (x?: number) => x ?? 2\\n" > src/b.test.ts && echo "export const a = 2" > src/a.ts',
    }
    const runs = join(dir, 'runs')
    const options = { label: 'smoke', runsDir: runs, repo, revision, dependencies: repo, solver, timeoutSeconds: 30, gateTimeoutSeconds: 30, workers: 2, injections: {}, skipGates: true }
    process.env.OURO_SOCKET = 'should-not-leak'
    const results = await runTasks(tasks, options)
    delete process.env.OURO_SOCKET
    assert.equal(results.length, 1)
    const [result] = results
    assert.equal(result!.status, 'solver_finished', result!.error)
    assert.deepEqual(result!.change, { files: 2, testFiles: 1, addedLines: 2, deletedLines: 1, paths: ['src/a.ts', 'src/b.test.ts'] })
    assert.ok(readFileSync(join(runs, 'smoke/attempts/T001/change.patch'), 'utf8').includes('+export const a = 2'))
    assert.ok(result!.health_changes.some((delta) => delta.indicator === 'testFiles'))
    // Its own copy of the workspace links, and the shared packages from the base.
    const workspace = join(runs, 'smoke/attempts/T001/workspace/src')
    assert.equal(execFileSync('readlink', [join(workspace, 'node_modules/@ouro/src')], { encoding: 'utf8' }).trim(), '../../src')
    assert.equal(execFileSync('readlink', [join(workspace, 'node_modules/left-pad')], { encoding: 'utf8' }).trim(), join(repo, 'node_modules/left-pad'))
    // A second run with the same label resumes rather than repeating the attempt.
    assert.deepEqual(await runTasks(tasks, options), results)
    mkdirSync(join(runs, 'smoke/reviews'))
    writeFileSync(join(runs, 'smoke/reviews/T001.json'), JSON.stringify({ task_id: 'T001', verdict: 'complete', reason: 'ok', attribution: [], reviewer: 'human:t', accepted_by_human: true }))
    const summary = summarize([loadRun(join(runs, 'smoke'))], 100)
    assert.equal(summary.attempted, 1)
    assert.deepEqual(summary.skipped.map((entry) => entry.task_id), ['T071'])
    assert.deepEqual(summary.judgements, { complete: 1 })
    assert.equal(summary.score.weighted, 1)
    assert.equal(summary.quality.changes_with_tests, 1)
    assert.match(report(summary), /Score 100%/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
