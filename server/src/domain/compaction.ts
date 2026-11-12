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
/** How close to expiry an idle agent is compacted. */
const EXPIRY_LEAD_MS = 5 * 60_000

/**
 * Whether the context will be worth compacting before its cache expires: large, not yet compacted, on a 1 hour cache with
 * enough of it left. A 5 minute cache is cold long before an idle agent would compact it.
 */
export function compactionPending(cache: PromptCacheRecord | null, now: number): boolean {
  if (cache === null || cache.compacted || cache.tokens < COMPACTION_MIN_TOKENS) return false
  if (cache.ttlMs < PROMPT_CACHE_TTL_MS['1h']) return false
  return cache.at + cache.ttlMs - now >= MIN_CACHE_LEFT_MS
}

/**
 * Whether to compact now: shortly before the cache expires, with no turn due before then to keep it warm. Not earlier: a
 * message before then finds the whole context still cached, and compacting would only have lost detail.
 */
export function compactionDue(cache: PromptCacheRecord | null, now: number, nextTurnAt: number | null): boolean {
  if (cache === null || !compactionPending(cache, now)) return false
  const expiresAt = cache.at + cache.ttlMs
  return expiresAt - now <= EXPIRY_LEAD_MS && !(nextTurnAt !== null && nextTurnAt < expiresAt)
}

/** Sent with the compact command: the summary must say where the full history still is. */
export function compactionInstructions(agentName: string): string {
  return 'At the end of the summary, add this note: "Context was compacted. Earlier details (exact messages, tool output) ' +
    `are in my full history: ouro log ${agentName}, or ouro search <words>."`
}
