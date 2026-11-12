// Turns runs into results: the same aggregates as initial-results.json (judgements, effort and usage by kind, difficulty
// and outcome), plus the quality evidence Ouro Next adds, and a paired comparison with the original baseline.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Baseline, Manifest, AttemptResult } from './run.ts'
import { readReview, type Review, type Verdict } from './review.ts'
import { indicators, percentile, round, type StaticHealth } from './metrics.ts'
import { readJson } from './workspace.ts'

export interface Row extends AttemptResult {
  judgement: Verdict | null
  reason: string | null
  attribution: string[]
  reviewer: string | null
  accepted_by_human: boolean
}

export interface InitialRow {
  task_id: string
  kind: string
  difficulty: string
  status: string
  solver_wall_seconds: number
  usage: { input_tokens: number, cached_input_tokens: number, output_tokens: number } | null
  judgement: string
}

interface UsageLike { usage: { input_tokens: number, cached_input_tokens: number, output_tokens: number, cache_write_input_tokens?: number, reasoning_output_tokens?: number | null } | null }
type Measured = UsageLike & { task_id: string, solver_wall_seconds: number | null, judgement: string | null }

export function loadRun(dir: string): { manifest: Manifest, baseline: Baseline | undefined, rows: Row[] } {
  const manifest = readJson<Manifest>(join(dir, 'run.json'))
  const baselinePath = join(dir, 'baseline.json')
  const attempts = join(dir, 'attempts')
  const rows = (existsSync(attempts) ? readdirSync(attempts) : []).sort()
    .filter((id) => existsSync(join(attempts, id, 'result.json')))
    .map((id) => {
      const result = readJson<AttemptResult>(join(attempts, id, 'result.json'))
      const review: Review | undefined = readReview(dir, id)
      return {
        ...result,
        judgement: review?.verdict ?? null,
        reason: review?.reason ?? null,
        attribution: review?.attribution ?? [],
        reviewer: review?.reviewer ?? null,
        accepted_by_human: review?.accepted_by_human ?? false,
      }
    })
  return { manifest, baseline: existsSync(baselinePath) ? readJson<Baseline>(baselinePath) : undefined, rows }
}

function countBy<T>(items: readonly T[], key: (item: T) => string | null): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const value = key(item)
    if (value !== null) counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const item of items) (groups[key(item)] ??= []).push(item)
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)))
}

// Totals over the attempts that reported usage; the ones that didn't are listed, not counted as zero.
export function usageTotals(rows: readonly Measured[]) {
  const reported = rows.filter((row) => row.usage)
  const sum = (key: 'input_tokens' | 'cached_input_tokens' | 'output_tokens'): number => reported.reduce((total, row) => total + row.usage![key], 0)
  return {
    usage_reported_attempts: reported.length,
    usage_missing_ids: rows.filter((row) => !row.usage).map((row) => row.task_id),
    input_tokens: sum('input_tokens'),
    cached_input_tokens: sum('cached_input_tokens'),
    output_tokens: sum('output_tokens'),
  }
}

export function effort(rows: readonly Measured[]) {
  const seconds = rows.map((row) => row.solver_wall_seconds).filter((value): value is number => value !== null)
  const totals = usageTotals(rows)
  return {
    attempts: rows.length,
    complete: rows.filter((row) => row.judgement === 'complete').length,
    usage_reported_attempts: totals.usage_reported_attempts,
    usage_missing_ids: totals.usage_missing_ids,
    median_seconds: percentile(seconds, 0.5),
    solver_wall_seconds: round(seconds.reduce((a, b) => a + b, 0)),
    input_tokens: totals.input_tokens,
    cached_input_tokens: totals.cached_input_tokens,
    output_tokens: totals.output_tokens,
  }
}

// The headline: complete counts 1, partial counts half, over judged attempts that were valid tasks run properly.
export function score(rows: readonly { judgement: string | null }[]): { scored: number, complete_rate: number | null, weighted: number | null } {
  const scored = rows.filter((row) => row.judgement === 'complete' || row.judgement === 'partial' || row.judgement === 'failed')
  if (!scored.length) return { scored: 0, complete_rate: null, weighted: null }
  const complete = scored.filter((row) => row.judgement === 'complete').length
  const partial = scored.filter((row) => row.judgement === 'partial').length
  return { scored: scored.length, complete_rate: round(complete / scored.length), weighted: round((complete + partial / 2) / scored.length) }
}

export function quality(rows: readonly Row[], baselines: readonly (Baseline | undefined)[]) {
  const changed = rows.filter((row) => row.change && row.change.files > 0)
  const gated = changed.filter((row) => row.gates_after)
  const green = gated.filter((row) => Object.values(row.gates_after!).every((gate) => gate.passed))
  const worse = (row: Row): string[] => row.health_changes.filter((delta) => delta.verdict === 'worse').map((delta) => delta.indicator)
  const worsened: Record<string, number> = {}
  for (const row of changed) for (const indicator of worse(row)) worsened[indicator] = (worsened[indicator] ?? 0) + 1
  return {
    baseline_gates_passed: baselines.every((baseline) => baseline?.gates && Object.values(baseline.gates).every((gate) => gate.passed)),
    attempts_with_change: changed.length,
    attempts_without_change: rows.length - changed.length,
    gates_checked: gated.length,
    gates_green_after: green.length,
    gates_green_rate: gated.length ? round(green.length / gated.length) : null,
    changes_with_tests: changed.filter((row) => row.change!.testFiles > 0).length,
    median_files_changed: percentile(changed.map((row) => row.change!.files), 0.5),
    median_lines_changed: percentile(changed.map((row) => row.change!.addedLines + row.change!.deletedLines), 0.5),
    attempts_worsening_health: changed.filter((row) => worse(row).length > 0).length,
    worsened_indicators: Object.fromEntries(Object.entries(worsened).sort(([, a], [, b]) => b - a)),
  }
}

export function summarize(runs: ReturnType<typeof loadRun>[], catalogSize: number) {
  const latest = new Map<string, Row>()
  for (const run of runs) for (const row of run.rows) latest.set(row.task_id, row)
  const rows = [...latest.values()].sort((a, b) => a.task_id.localeCompare(b.task_id))
  const judged = rows.filter((row) => row.judgement)
  const seconds = rows.map((row) => row.solver_wall_seconds).filter((value): value is number => value !== null)
  const totals = usageTotals(rows)
  const knownCost = rows.filter((row) => row.cost_usd !== null)
  const skipped = runs.flatMap((run) => run.manifest.skipped).filter((entry) => !latest.has(entry.task_id))
  return {
    format_version: 1,
    benchmark: 'Ouro Next maintainability',
    revisions: [...new Set(runs.map((run) => run.manifest.revision))],
    catalog_size: catalogSize,
    attempted: rows.length,
    skipped: [...new Map(skipped.map((entry) => [entry.task_id, entry])).values()],
    reviewed: judged.length,
    accepted_by_human: judged.filter((row) => row.accepted_by_human).length,
    unreviewed_ids: rows.filter((row) => !row.judgement).map((row) => row.task_id),
    judgement_basis: judged.every((row) => row.accepted_by_human) ? 'Accepted by a person.' : 'Includes agent reviews not yet accepted by a person.',
    score: score(rows),
    judgements: countBy(rows, (row) => row.judgement),
    by_kind: Object.fromEntries(Object.entries(groupBy(rows, (row) => row.kind)).map(([key, list]) => [key, countBy(list, (row) => row.judgement)])),
    by_difficulty: Object.fromEntries(Object.entries(groupBy(rows, (row) => row.difficulty)).map(([key, list]) => [key, countBy(list, (row) => row.judgement)])),
    effort_by_kind: Object.fromEntries(Object.entries(groupBy(rows, (row) => row.kind)).map(([key, list]) => [key, effort(list)])),
    effort_by_difficulty: Object.fromEntries(Object.entries(groupBy(rows, (row) => row.difficulty)).map(([key, list]) => [key, effort(list)])),
    effort_by_judgement: Object.fromEntries(Object.entries(groupBy(judged, (row) => row.judgement!)).map(([key, list]) => [key, effort(list)])),
    solver_wall_seconds: round(seconds.reduce((a, b) => a + b, 0)),
    median_solver_seconds: percentile(seconds, 0.5),
    usage: { input_tokens: totals.input_tokens, cached_input_tokens: totals.cached_input_tokens, output_tokens: totals.output_tokens },
    usage_reported_attempts: totals.usage_reported_attempts,
    usage_missing_ids: totals.usage_missing_ids,
    cost_usd: knownCost.length ? { total: round(knownCost.reduce((sum, row) => sum + row.cost_usd!, 0), 4), reported_attempts: knownCost.length } : null,
    quality: quality(rows, runs.map((run) => run.baseline)),
    baseline_health: runs.at(-1)?.baseline?.health.health ?? null,
    batches: runs.map((run) => ({
      label: run.manifest.label,
      revision: run.manifest.revision,
      solver: run.manifest.solver,
      workers: run.manifest.workers,
      timeout_seconds: run.manifest.timeout_seconds,
      finished: run.rows.length,
      judgements: countBy(run.rows, (row) => row.judgement),
    })),
    rows,
  }
}

export type Summary = ReturnType<typeof summarize>

// The same tasks on both sides only. Models, solvers and code all differ, so this describes, it doesn't rank.
export function compareWithInitial(summary: Pick<Summary, 'rows'>, initialRows: readonly InitialRow[]) {
  const initial = new Map(initialRows.map((row) => [row.task_id, row]))
  const pairs = summary.rows.filter((row) => row.judgement && initial.has(row.task_id)).map((row) => ({ now: row, then: initial.get(row.task_id)! }))
  const side = (list: Measured[]) => ({ ...score(list), ...effort(list) })
  const transitions: Record<string, number> = {}
  for (const { now, then } of pairs) transitions[`${then.judgement}->${now.judgement}`] = (transitions[`${then.judgement}->${now.judgement}`] ?? 0) + 1
  return {
    paired_tasks: pairs.length,
    initial: side(pairs.map(({ then }) => then)),
    current: side(pairs.map(({ now }) => now)),
    transitions: Object.fromEntries(Object.entries(transitions).sort()),
  }
}

const fmt = (value: number | null | undefined, places = 1): string => value === null || value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(places)
const pct = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(0)}%`

export function healthTable(health: StaticHealth, before?: StaticHealth): string {
  const lines = before ? ['| Indicator | Better | Before | After | Change |', '|---|---|---:|---:|---:|'] : ['| Indicator | Better | Value |', '|---|---|---:|']
  for (const key of Object.keys(indicators) as Array<keyof StaticHealth>) {
    const direction = indicators[key] === 'context' ? '' : indicators[key]
    if (!before) lines.push(`| ${key} | ${direction} | ${fmt(health[key], 3)} |`)
    else {
      const change = round(health[key] - before[key], 4)
      const mark = indicators[key] === 'context' || change === 0 ? '' : (change < 0) === (indicators[key] === 'lower') ? ' ✓' : ' ✗'
      lines.push(`| ${key} | ${direction} | ${fmt(before[key], 3)} | ${fmt(health[key], 3)} | ${change > 0 ? '+' : ''}${fmt(change, 3)}${mark} |`)
    }
  }
  return lines.join('\n')
}

export function report(summary: Summary, comparison?: ReturnType<typeof compareWithInitial>): string {
  const q = summary.quality
  const lines = [
    `# ${summary.benchmark}: results`,
    '',
    `Revision${summary.revisions.length > 1 ? 's' : ''}: ${summary.revisions.map((rev) => `\`${rev.slice(0, 12)}\``).join(', ')}. ${summary.judgement_basis}`,
    '',
    `**Score ${pct(summary.score.weighted)}** (complete 1, partial ½, over ${summary.score.scored} judged tasks); complete rate ${pct(summary.score.complete_rate)}.`,
    `${summary.attempted} attempted, ${summary.reviewed} reviewed (${summary.accepted_by_human} accepted by a person), ${summary.skipped.length} skipped.`,
    `Judgements: ${Object.entries(summary.judgements).map(([key, count]) => `${count} ${key}`).join(', ') || 'none yet'}.`,
    '',
    '## Effort',
    '',
    `Solver time ${fmt(summary.solver_wall_seconds)} s summed, median ${fmt(summary.median_solver_seconds)} s. Usage from ${summary.usage_reported_attempts}/${summary.attempted} attempts:`,
    `${summary.usage.input_tokens.toLocaleString('en-US')} input (${summary.usage.cached_input_tokens.toLocaleString('en-US')} cached), ${summary.usage.output_tokens.toLocaleString('en-US')} output.`
    + (summary.cost_usd ? ` Reported cost $${summary.cost_usd.total.toFixed(2)} over ${summary.cost_usd.reported_attempts} attempts.` : ''),
    '',
    '| Group | Attempts | Complete | Median s | Output tokens |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries({ ...prefix('kind', summary.effort_by_kind), ...prefix('difficulty', summary.effort_by_difficulty) })
      .map(([key, value]) => `| ${key} | ${value.attempts} | ${value.complete} | ${fmt(value.median_seconds)} | ${value.output_tokens.toLocaleString('en-US')} |`),
    '',
    '## Quality of the changes',
    '',
    `Baseline gates ${q.baseline_gates_passed ? 'all passed' : 'did not all pass, so gate failures after a change are not all the change\'s'}.`,
    `${q.attempts_with_change} attempts changed code (${q.attempts_without_change} left none). Gates green after the change: ${q.gates_green_after}/${q.gates_checked} (${pct(q.gates_green_rate)}).`,
    `${q.changes_with_tests} changes touched tests. Median change: ${fmt(q.median_files_changed)} files, ${fmt(q.median_lines_changed)} lines.`,
    `${q.attempts_worsening_health} changes made a static health indicator worse${Object.keys(q.worsened_indicators).length ? `: ${Object.entries(q.worsened_indicators).map(([key, count]) => `${key} ${count}`).join(', ')}` : ''}.`,
  ]
  if (summary.baseline_health) lines.push('', '## Static health of the starting revision', '', healthTable(summary.baseline_health))
  if (comparison && comparison.paired_tasks) {
    lines.push('', '## Against the original baseline', '',
      `On the ${comparison.paired_tasks} tasks judged in both: original score ${pct(comparison.initial.weighted)} (complete ${pct(comparison.initial.complete_rate)}), median ${fmt(comparison.initial.median_seconds)} s;`
      + ` now ${pct(comparison.current.weighted)} (complete ${pct(comparison.current.complete_rate)}), median ${fmt(comparison.current.median_seconds)} s.`,
      `Transitions: ${Object.entries(comparison.transitions).map(([key, count]) => `${key} ${count}`).join(', ')}.`,
      'Solvers, models, reviewers and code all differ between the two, so this is description, not a ranking.')
  }
  const failures = summary.rows.filter((row) => row.judgement && row.judgement !== 'complete')
  if (failures.length) {
    lines.push('', '## Short of complete', '', '| Task | Kind | Judgement | Attribution | Reason |', '|---|---|---|---|---|',
      ...failures.map((row) => `| ${row.task_id} | ${row.kind} | ${row.judgement} | ${row.attribution.join(', ')} | ${(row.reason ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`))
  }
  return `${lines.join('\n')}\n`
}

function prefix<T>(label: string, groups: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [`${label}: ${key}`, value]))
}
