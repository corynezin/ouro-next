// Automatic compaction: an idle agent's large context is compacted while its prompt cache is still warm, so the first turn
// after a long quiet spell doesn't write the whole context again cold. Compacting a warm cache costs a cache read of the
// context plus the summary; the next turn then writes only the smaller context. Pure.
import type { CacheState, PromptCacheLifetime } from '@ouro/contract'

export const PROMPT_CACHE_TTL_MS: Record<PromptCacheLifetime, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** What a provider reports about the context after a turn: the size of its latest request, and how long that is cached. */
export interface ContextReading {
  tokens: number
  cacheTtlMs: number
}

/** An agent's context and prompt cache, as of its latest model request or compaction. */
export interface PromptCacheRecord {
  /** When the cache was last written or read: every request restarts its lifetime. */
  at: number
  ttlMs: number
  /** The context's size: what a cold start has to write again. */
  tokens: number
  /** Compacted since its latest turn. A compacted context isn't compacted again until a turn has grown it. */
  compacted: boolean
}

export function promptCacheAfterTurn(reading: ContextReading, at: number): PromptCacheRecord {
  return { at, ttlMs: reading.cacheTtlMs, tokens: reading.tokens, compacted: false }
}

/** After a compaction, the context is its new size, which nothing has cached yet. */
export function promptCacheAfterCompaction(previous: PromptCacheRecord, tokens: number, at: number): PromptCacheRecord {
  return { at, ttlMs: previous.ttlMs, tokens, compacted: true }
}

export function cacheStateOf(record: PromptCacheRecord): CacheState {
  return { expiresAt: record.at + record.ttlMs, tokens: record.tokens, compacted: record.compacted }
}

/** Smaller contexts cost little to write again; compacting them would mostly lose detail. */
export const COMPACTION_MIN_TOKENS = 60_000
/** With less cache left than this, the compaction's own read would miss it. */
const MIN_CACHE_LEFT_MS = 60_000
/** How close to expiry an agent kept up while idle is compacted. */
const EXPIRY_LEAD_MS = 5 * 60_000

/**
 * - `before_idle_exit`: the agent is about to exit idle; a later message would resume it cold.
 * - `before_cache_expiry`: the agent stays up while idle (an active goal between cycles) and its cache expires soon, with
 *   no turn due before then to keep it warm.
 */
export type CompactionOccasion = { kind: 'before_idle_exit' } | { kind: 'before_cache_expiry'; nextTurnAt: number | null }

/**
 * Whether compacting now saves money. Only a 1 hour cache: a 5 minute one is cold long before an idle exit, and close to
 * expiry after every turn.
 */
export function compactionDue(cache: PromptCacheRecord | null, now: number, occasion: CompactionOccasion): boolean {
  if (cache === null || cache.compacted || cache.tokens < COMPACTION_MIN_TOKENS) return false
  if (cache.ttlMs < PROMPT_CACHE_TTL_MS['1h']) return false
  const expiresAt = cache.at + cache.ttlMs
  const left = expiresAt - now
  if (left < MIN_CACHE_LEFT_MS) return false
  switch (occasion.kind) {
    case 'before_idle_exit': return true
    case 'before_cache_expiry': return left <= EXPIRY_LEAD_MS && !(occasion.nextTurnAt !== null && occasion.nextTurnAt < expiresAt)
  }
}

/** Sent with the compact command: the summary must say where the full history still is. */
export function compactionInstructions(agentName: string): string {
  return 'At the end of the summary, add this note: "Context was compacted. Earlier details (exact messages, tool output) ' +
    `are in my full history: ouro log ${agentName}, or ouro search <words>."`
}
