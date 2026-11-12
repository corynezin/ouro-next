import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_TASKS_CAP_MS, decideAgent, defaultAgentPolicy, dueEvent } from './agent.ts'
import type { AgentLifecycle } from './agent.ts'
import { COMPACTION_MIN_TOKENS, PROMPT_CACHE_TTL_MS, compactionDue, compactionPending, promptCacheAfterCompaction, promptCacheAfterTurn } from './compaction.ts'
import type { PromptCacheRecord } from './compaction.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const big = (at: number, ttl: '5m' | '1h' = '1h'): PromptCacheRecord => promptCacheAfterTurn({ tokens: 120_000, cacheTtlMs: PROMPT_CACHE_TTL_MS[ttl] }, at)

test('a large context on a 1 hour cache is compacted shortly before the cache expires, not earlier', () => {
  assert.equal(compactionPending(big(0), 30 * MINUTE), true)
  assert.equal(compactionDue(big(0), 30 * MINUTE, null), false)
  assert.equal(compactionDue(big(0), 50 * MINUTE, null), false)
  assert.equal(compactionDue(big(0), 56 * MINUTE, null), true)
})

test('a small context, a 5 minute cache, a cache nearly gone, and an unknown context are left alone', () => {
  const small = promptCacheAfterTurn({ tokens: COMPACTION_MIN_TOKENS - 1, cacheTtlMs: HOUR }, 0)
  for (const cache of [small, big(0, '5m'), null]) {
    assert.equal(compactionPending(cache, MINUTE), false)
    assert.equal(compactionDue(cache, 56 * MINUTE, null), false)
  }
  assert.equal(compactionPending(big(0), HOUR - 59_000), false)
  assert.equal(compactionDue(big(0), HOUR - 59_000, null), false)
})

test('once compacted, it is not compacted again until a turn has grown it', () => {
  const compacted = promptCacheAfterCompaction(big(0), 200_000, 56 * MINUTE)
  assert.equal(compactionPending(compacted, 57 * MINUTE), false)
  assert.equal(compactionDue(compacted, 57 * MINUTE, null), false)
  assert.equal(compactionDue(promptCacheAfterTurn({ tokens: 90_000, cacheTtlMs: HOUR }, 50 * MINUTE), 106 * MINUTE, null), true)
})

test('a turn due before the cache expires keeps it warm instead', () => {
  assert.equal(compactionDue(big(0), 56 * MINUTE, 58 * MINUTE), false)
  assert.equal(compactionDue(big(0), 56 * MINUTE, 2 * HOUR), true)
})

const idleSince = (since: number): AgentLifecycle => ({ state: { state: 'idle', since, generation: 1 }, instanceGeneration: 1, consecutiveCrashes: 0, consecutiveCreditFailures: 0, ownershipEpoch: 0, consecutiveStalls: 0 })
const facts = (promptCache: PromptCacheRecord | null) => ({ hasQueuedWork: false, activeGoal: false, nextGoalCycleAt: null, promptCache, backgroundTasks: null })

test('an idle agent worth compacting stays up past its idle exit, compacts just before expiry, then exits', () => {
  const policy = defaultAgentPolicy
  const exitAt = policy.idleExitMs!
  for (let at = 0; at < 55 * MINUTE; at += MINUTE) assert.equal(dueEvent(idleSince(0), at, policy, facts(big(0))), null, `nothing at ${at / MINUTE} min`)
  assert.deepEqual(dueEvent(idleSince(0), 56 * MINUTE, policy, facts(big(0))), { type: 'compaction_requested' })
  assert.equal(dueEvent(idleSince(0), 56 * MINUTE, policy, { ...facts(big(0)), hasQueuedWork: true }), null, 'queued messages come first')

  const compacting = decideAgent(idleSince(0), { type: 'compaction_requested' }, 56 * MINUTE, policy)
  assert.ok(compacting.outcome === 'transition')
  const idleAgain = decideAgent(compacting.next, { type: 'compaction_finished', generation: 1 }, 57 * MINUTE, policy)
  assert.ok(idleAgain.outcome === 'transition')
  const compacted = promptCacheAfterCompaction(big(0), 8_000, 57 * MINUTE)
  assert.deepEqual(dueEvent(idleAgain.next, 57 * MINUTE, policy, facts(compacted)), { type: 'idle_timeout_reached' }, 'nothing left to wait for')
  assert.ok(exitAt < 55 * MINUTE)
})

test('a compacted agent still waits for its running background tasks, up to their cap', () => {
  const policy = defaultAgentPolicy
  const compacted = promptCacheAfterCompaction(big(0), 8_000, 57 * MINUTE)
  const running = { ...facts(compacted), backgroundTasks: { generation: 1, running: 1, changedAt: 10 * MINUTE } }
  assert.equal(dueEvent(idleSince(0), 57 * MINUTE, policy, running), null)
  assert.deepEqual(dueEvent(idleSince(0), 10 * MINUTE + BACKGROUND_TASKS_CAP_MS, policy, running), { type: 'idle_timeout_reached' })
  const finished = { ...facts(compacted), backgroundTasks: { generation: 1, running: 0, changedAt: 50 * MINUTE } }
  assert.deepEqual(dueEvent(idleSince(0), 57 * MINUTE, policy, finished), { type: 'idle_timeout_reached' }, 'nothing left to wait for')
})

test('an idle agent not worth compacting exits at its idle exit, as before', () => {
  const policy = defaultAgentPolicy
  const exitAt = policy.idleExitMs!
  const small = promptCacheAfterTurn({ tokens: COMPACTION_MIN_TOKENS - 1, cacheTtlMs: HOUR }, 0)
  for (const cache of [null, small, big(0, '5m')]) {
    assert.equal(dueEvent(idleSince(0), exitAt - 1, policy, facts(cache)), null)
    assert.deepEqual(dueEvent(idleSince(0), exitAt, policy, facts(cache)), { type: 'idle_timeout_reached' })
  }
  assert.deepEqual(dueEvent(idleSince(0), HOUR, policy, facts(big(0))), { type: 'idle_timeout_reached' }, 'its cache already gone')
})

test('relaunches that restart the idle period do not move the compaction past the cache expiry', () => {
  const policy = defaultAgentPolicy
  // The turn ended at 0; relaunches for new releases left it idle again from 42 minutes.
  const relaunched = idleSince(42 * MINUTE)
  assert.equal(dueEvent(relaunched, 50 * MINUTE, policy, facts(big(0))), null)
  assert.deepEqual(dueEvent(relaunched, 56 * MINUTE, policy, facts(big(0))), { type: 'compaction_requested' })
})

test('an agent kept up by its goal is compacted before expiry, and never exits idle', () => {
  const policy = defaultAgentPolicy
  const kept = { ...facts(big(0)), activeGoal: true }
  assert.equal(dueEvent(idleSince(0), 50 * MINUTE, policy, kept), null)
  assert.deepEqual(dueEvent(idleSince(0), 56 * MINUTE, policy, kept), { type: 'compaction_requested' })
  assert.equal(dueEvent(idleSince(0), 57 * MINUTE, policy, { ...kept, promptCache: promptCacheAfterCompaction(big(0), 8_000, 57 * MINUTE) }), null)
})
