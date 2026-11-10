import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalRecord } from './journal.ts'
import {
  buildSummaryDigest, DEFAULT_SUMMARY_POLICY, fitLine, NO_SUMMARY_PROGRESS, noteSummarizableActivity, parseSummaryAnswer, startSummary, summaryDue,
  summaryFailed, summarySucceeded, UnusableSummary,
} from './summary.ts'

const policy = DEFAULT_SUMMARY_POLICY
const MIN = 60_000
const tool = (at: number): JournalRecord => ({ kind: 'tool_use', at, generation: 1, toolName: 'Bash', input: 'npm test' })
const words = (at: number, text: string): JournalRecord => ({ kind: 'text', at, generation: 1, text })

test('only a tool call, or enough of its own words, is worth a summary', () => {
  const chatty = noteSummarizableActivity(NO_SUMMARY_PROGRESS, words(1000, 'ok'), policy)
  assert.equal(chatty.pendingSince, null)
  assert.equal(summaryDue(chatty, 'turn_finished', 2000, policy), false)
  assert.equal(summaryDue(chatty, 'agent_done', 2000, policy), false, 'not even on done: nothing to say')
  const wordy = noteSummarizableActivity(chatty, words(1500, 'x'.repeat(300)), policy)
  assert.equal(wordy.pendingSince, 1500)
  const busy = noteSummarizableActivity(NO_SUMMARY_PROGRESS, tool(1000), policy)
  assert.equal(busy.pendingSince, 1000)
  assert.equal(noteSummarizableActivity(busy, tool(9000), policy).pendingSince, 1000, 'the oldest pending activity counts')
})

test('at most one per interval, a long turn gets one once its activity has waited an interval, done always', () => {
  const pending = noteSummarizableActivity(NO_SUMMARY_PROGRESS, tool(0), policy)
  assert.equal(summaryDue(pending, 'turn_finished', 1000, policy), true)
  assert.equal(summaryDue(pending, 'periodic', 4 * MIN, policy), false)
  assert.equal(summaryDue(pending, 'periodic', 5 * MIN, policy), true)

  const started = startSummary(pending, 1000)
  const again = noteSummarizableActivity(summarySucceeded(started, 500), tool(2000), policy)
  assert.equal(summaryDue(again, 'turn_finished', 3 * MIN, policy), false)
  assert.equal(summaryDue(again, 'agent_done', 3 * MIN, policy), true)
  assert.equal(summaryDue(again, 'turn_finished', 1000 + 5 * MIN, policy), true)
})

test('a failure keeps its activity pending and backs off, doubling up to an hour', () => {
  const pending = noteSummarizableActivity(NO_SUMMARY_PROGRESS, tool(0), policy)
  const started = startSummary(pending, 0)
  assert.equal(started.pendingSince, null)
  const failed = summaryFailed(started, pending, 10, 'no answer')
  assert.equal(failed.pendingSince, 0)
  assert.equal(failed.consecutiveFailures, 1)
  assert.deepEqual(failed.lastFailure, { at: 10, message: 'no answer' })
  assert.equal(summaryDue(failed, 'turn_finished', 10 + 9 * MIN, policy), false)
  assert.equal(summaryDue(failed, 'turn_finished', 10 + 10 * MIN, policy), true)
  let many = failed
  for (let index = 0; index < 6; index++) many = summaryFailed(startSummary(many, 0), many, 10, 'again')
  assert.equal(summaryDue(many, 'turn_finished', 10 + 59 * MIN, policy), false)
  assert.equal(summaryDue(many, 'turn_finished', 10 + 60 * MIN, policy), true)
  assert.equal(summaryDue(many, 'agent_done', 20, policy), true, 'done does not wait out a backoff')

  const recovered = summarySucceeded(many, 4096)
  assert.equal(recovered.lastFailure, null)
  assert.equal(recovered.consecutiveFailures, 0)
  assert.equal(recovered.coveredThroughCursor, 4096)
})

test('answers: the JSON is found, the line fits one row, unusable answers are refused', () => {
  const parsed = parseSummaryAnswer('Sure! {"line": "Fixing the flaky restart-time journey by measuring server work", "details": ["a", "", "b", "c", "d", "e"]}', policy)
  assert.ok(parsed.line.length <= 50, parsed.line)
  assert.ok(parsed.line.endsWith('…'))
  assert.deepEqual(parsed.details, ['a', 'b', 'c', 'd'])
  assert.throws(() => parseSummaryAnswer('I cannot help', policy), UnusableSummary)
  assert.throws(() => parseSummaryAnswer('{"details": []}', policy), UnusableSummary)
  assert.throws(() => parseSummaryAnswer('{"line": ', policy), UnusableSummary)
  assert.equal(fitLine('short   line', 50), 'short line')
})

test('the digest keeps the start and the newest part of a long transcript', () => {
  const records: JournalRecord[] = Array.from({ length: 2000 }, (_, index) => ({ kind: 'tool_use', at: index, generation: 1, toolName: 'Bash', input: `step ${index} ${'x'.repeat(40)}` }))
  const digest = buildSummaryDigest({ agentName: 'a', task: 'the task', previousLine: 'earlier', records })
  assert.ok(digest.length < 30_000)
  assert.match(digest, /Its task: the task/)
  assert.match(digest, /Previous summary: earlier/)
  assert.match(digest, /step 0 /)
  assert.match(digest, /step 1999 /)
  assert.match(digest, /lines left out/)
})
