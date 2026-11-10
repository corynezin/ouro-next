import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideAgent, defaultAgentPolicy, dueEvent } from './agent.ts'
import type { AgentLifecycle } from './agent.ts'
import { COMPACTION_MIN_TOKENS, PROMPT_CACHE_TTL_MS, compactionDue, promptCacheAfterCompaction, promptCacheAfterTurn } from './compaction.ts'
import type { PromptCacheRecord } from './compaction.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const big = (at: number, ttl: '5m' | '1h' = '1h'): PromptCacheRecord => promptCacheAfterTurn({ tokens: 120_000, cacheTtlMs: PROMPT_CACHE_TTL_MS[ttl] }, at)
const exiting = { kind: 'before_idle_exit' } as const

test('a large context on a warm 1 hour cache is compacted before idle exit', () => {
  assert.equal(compactionDue(big(0), 30 * MINUTE, exiting), true)
})

test('a small context, a 5 minute cache, a cache nearly gone, and an unknown context are left alone', () => {
  assert.equal(compactionDue(promptCacheAfterTurn({ tokens: COMPACTION_MIN_TOKENS - 1, cacheTtlMs: HOUR }, 0), 30 * MINUTE, exiting), false)
  assert.equal(compactionDue(big(0, '5m'), 4 * MINUTE, exiting), false)
  assert.equal(compactionDue(big(0), HOUR - 59_000, exiting), false)
  assert.equal(compactionDue(null, 30 * MINUTE, exiting), false)
})

test('once compacted, it is not compacted again until a turn has grown it', () => {
  const compacted = promptCacheAfterCompaction(big(0), 200_000, 30 * MINUTE)
  assert.equal(compactionDue(compacted, 40 * MINUTE, exiting), false)
  assert.equal(compactionDue(promptCacheAfterTurn({ tokens: 90_000, cacheTtlMs: HOUR }, 50 * MINUTE), 60 * MINUTE, exiting), true)
})

test('an agent kept up while idle is compacted shortly before its cache expires, unless a turn comes first', () => {
  const cache = big(0)
  assert.equal(compactionDue(cache, 50 * MINUTE, { kind: 'before_cache_expiry', nextTurnAt: null }), false, 'not yet')
  assert.equal(compactionDue(cache, 56 * MINUTE, { kind: 'before_cache_expiry', nextTurnAt: null }), true)
  assert.equal(compactionDue(cache, 56 * MINUTE, { kind: 'before_cache_expiry', nextTurnAt: 58 * MINUTE }), false, 'the goal cycle keeps it warm')
  assert.equal(compactionDue(cache, 56 * MINUTE, { kind: 'before_cache_expiry', nextTurnAt: 2 * HOUR }), true)
})

const idleSince = (since: number): AgentLifecycle => ({ state: { state: 'idle', since, generation: 1 }, instanceGeneration: 1, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: 0, consecutiveStalls: 0 })
const facts = (promptCache: PromptCacheRecord | null) => ({ hasQueuedWork: false, activeGoal: false, nextGoalCycleAt: null, promptCache })

test('at idle exit, a context worth compacting is compacted instead; compacted, it exits after the next idle period', () => {
  const policy = defaultAgentPolicy
  const exitAt = policy.idleExitMs!
  assert.deepEqual(dueEvent(idleSince(0), exitAt, policy, facts(big(0))), { type: 'compaction_requested' })
  assert.deepEqual(dueEvent(idleSince(0), exitAt, policy, facts(null)), { type: 'idle_timeout_reached' })
  assert.equal(dueEvent(idleSince(0), exitAt, policy, { ...facts(big(0)), hasQueuedWork: true }), null, 'queued messages come first')

  const compacting = decideAgent(idleSince(0), { type: 'compaction_requested' }, exitAt, policy)
  assert.equal(compacting.outcome, 'transition')
  const idleAgain = compacting.outcome === 'transition' ? decideAgent(compacting.next, { type: 'compaction_finished', generation: 1 }, exitAt + MINUTE, policy) : compacting
  assert.ok(idleAgain.outcome === 'transition')
  const compacted = promptCacheAfterCompaction(big(0), 8_000, exitAt + MINUTE)
  assert.equal(dueEvent(idleAgain.next, exitAt + MINUTE + exitAt - 1, policy, facts(compacted)), null)
  assert.deepEqual(dueEvent(idleAgain.next, exitAt + MINUTE + exitAt, policy, facts(compacted)), { type: 'idle_timeout_reached' })
})

test('an agent kept up by its goal is compacted before expiry, and never exits idle', () => {
  const policy = defaultAgentPolicy
  const kept = { ...facts(big(0)), activeGoal: true }
  assert.equal(dueEvent(idleSince(0), 50 * MINUTE, policy, kept), null)
  assert.deepEqual(dueEvent(idleSince(0), 56 * MINUTE, policy, kept), { type: 'compaction_requested' })
})
