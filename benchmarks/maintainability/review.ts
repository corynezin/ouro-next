// Judgements. A reviewer (a person, or an agent standing in until a person accepts) reads the change and decides.
// Exit codes, gates and health changes are evidence for the reviewer, never the verdict by themselves.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from './catalog.ts'
import type { AttemptResult } from './run.ts'
import { runSolver, type SolverConfig } from './solvers.ts'
import { attemptPaths, readJson, writeJson } from './workspace.ts'

export const verdicts = ['complete', 'partial', 'failed', 'invalid_task', 'infrastructure_blocked'] as const
export type Verdict = typeof verdicts[number]

// Why an attempt fell short, kept apart so a low score can be read as the code's fault or something else's.
export const attributions = ['code_navigation', 'implementation', 'regression', 'prompt_ambiguity', 'environment', 'budget', 'setup_or_injection'] as const

export interface Review {
  task_id: string
  verdict: Verdict
  reason: string
  attribution: string[]
  reviewer: string
  accepted_by_human: boolean
  reviewed_at: string
}

export function reviewPath(run: string, id: string): string {
  return join(run, 'reviews', `${id}.json`)
}

export function readReview(run: string, id: string): Review | undefined {
  const path = reviewPath(run, id)
  return existsSync(path) ? readJson<Review>(path) : undefined
}

export function recordReview(run: string, review: Omit<Review, 'reviewed_at'>): Review {
  if (!verdicts.includes(review.verdict)) throw new Error(`a verdict is one of ${verdicts.join(', ')}`)
  for (const item of review.attribution) if (!(attributions as readonly string[]).includes(item)) throw new Error(`attribution "${item}" isn't one of ${attributions.join(', ')}`)
  if (!review.reason.trim()) throw new Error('a review needs a reason')
  const recorded = { ...review, reviewed_at: new Date().toISOString() }
  writeJson(reviewPath(run, review.task_id), recorded)
  return recorded
}

// Private acceptance notes, per task: either { "T001": "note" } or the original evaluator's { tasks: [{ id, review }] }.
export function loadRubric(path: string | undefined): Record<string, string> {
  if (!path) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> | { tasks: Array<{ id: string, review?: string }> }
  if (Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return Object.fromEntries((parsed as { tasks: Array<{ id: string, review?: string }> }).tasks.filter((task) => task.review).map((task) => [task.id, task.review!]))
  }
  return parsed as Record<string, string>
}

export function reviewerPrompt(task: Task, result: AttemptResult, note: string | undefined): string {
  const gates = result.gates_after
    ? Object.entries(result.gates_after).map(([name, gate]) => `${name}: ${gate.passed ? 'passed' : gate.timedOut ? 'timed out' : 'failed'}${gate.tests ? ` (${gate.tests.passed}/${gate.tests.total} tests)` : ''}`).join('; ')
    : 'not run'
  return [
    'You are reviewing one attempt at a coding task on the Ouro source in the current directory. Do not change any files.',
    'The attempt\'s change is staged: `git diff --cached HEAD` shows it against the starting point. The full patch is also in ../../change.patch.',
    'Judge it like a careful maintainer: does it do what the request asks, in a way that fits the code, without breaking anything else?',
    'Read the change and the code around it. Run focused checks if useful (single test files, the type check); keep each under two minutes.',
    'The mobile app cannot run here; judge app changes from the source and say so when that limits your verdict.',
    '',
    `Request (${task.kind}, ${task.difficulty}, ${task.area}):`,
    task.prompt,
    ...(note ? ['', 'Acceptance notes from the task author (a guide, not exact requirements):', note] : []),
    ...(result.injected ? ['', 'This is a debugging task: a regression was planted in the starting point. Judge whether the attempt found and fixed the reported symptom.'] : []),
    '',
    `Solver status: ${result.status}${result.solver_wall_seconds !== null ? ` after ${result.solver_wall_seconds}s` : ''}.`,
    `Change: ${result.change ? `${result.change.files} files, +${result.change.addedLines}/-${result.change.deletedLines}, ${result.change.testFiles} test files` : 'none captured'}.`,
    `Project checks after the change: ${gates}.`,
    '',
    'Verdicts: complete (does what was asked, nothing broken), partial (some of it, or with a real defect), failed (not done, wrong, or breaks something),',
    'invalid_task (the request makes no sense for this code), infrastructure_blocked (the attempt could not run properly).',
    `Attribution for anything short of complete, any of: ${attributions.join(', ')}.`,
    'End your answer with exactly one line of JSON and nothing after it:',
    '{"verdict": "...", "reason": "two or three sentences", "attribution": []}',
  ].join('\n')
}

export function parseVerdict(text: string): Pick<Review, 'verdict' | 'reason' | 'attribution'> | undefined {
  const candidates = text.match(/\{[^{}]*"verdict"[^{}]*\}/g) ?? []
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { verdict?: string, reason?: string, attribution?: unknown }
      if (!parsed.verdict || !(verdicts as readonly string[]).includes(parsed.verdict)) continue
      const attribution = Array.isArray(parsed.attribution) ? parsed.attribution.filter((item): item is string => (attributions as readonly string[]).includes(String(item))) : []
      return { verdict: parsed.verdict as Verdict, reason: String(parsed.reason ?? '').trim() || 'No reason given.', attribution }
    } catch { /* try the one before */ }
  }
  return undefined
}

export async function agentReview(run: string, task: Task, reviewer: SolverConfig, options: { note?: string, timeoutSeconds: number }): Promise<Review | { task_id: string, error: string }> {
  const artifacts = join(run, 'attempts', task.id)
  const result = readJson<AttemptResult>(join(artifacts, 'result.json'))
  if (!result.change || result.change.files === 0) {
    return recordReview(run, { task_id: task.id, verdict: result.status === 'setup_error' ? 'infrastructure_blocked' : 'failed',
      reason: result.status === 'setup_error' ? `The attempt could not be set up: ${result.error ?? 'unknown error'}.` : 'The attempt left no change.',
      attribution: result.status === 'timeout' ? ['budget'] : result.status === 'setup_error' ? ['environment'] : [], reviewer: 'rule:no-change', accepted_by_human: false })
  }
  const paths = attemptPaths(join(artifacts, 'workspace'))
  const reviewArtifacts = join(artifacts, 'review')
  mkdirSync(reviewArtifacts, { recursive: true })
  const ran = await runSolver(reviewer, paths, reviewerPrompt(task, result, options.note), { timeoutSeconds: options.timeoutSeconds, artifacts: reviewArtifacts })
  const verdict = parseVerdict(ran.final_message)
  if (!verdict) return { task_id: task.id, error: `the reviewer gave no verdict (${ran.status})` }
  const name = [reviewer.solver, reviewer.model, ran.models.join('+')].filter(Boolean).join(':')
  return recordReview(run, { task_id: task.id, ...verdict, reviewer: `agent:${name}`, accepted_by_human: false })
}

// A person agrees with a recorded judgement (an agent's, usually), which keeps it but marks it accepted.
export function acceptReview(run: string, id: string, by: string): Review {
  const review = readReview(run, id)
  if (!review) throw new Error(`${id} has no review to accept`)
  const accepted = { ...review, accepted_by_human: true, reviewer: review.reviewer.includes(`accepted:${by}`) ? review.reviewer : `${review.reviewer}; accepted:${by}` }
  writeJson(reviewPath(run, id), accepted)
  return accepted
}
