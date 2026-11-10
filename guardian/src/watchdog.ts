// What a failed health check means. A server is starting until its cold-start grace ends; only after that does an
// outage begin, so a server that is merely slow to start never spends (or is refused) a restart.

export type FailedCheckVerdict =
  /** Within its cold-start grace: not down. */
  | { kind: 'starting' }
  /** Down, but not yet for long enough to act. */
  | { kind: 'outage'; outageMs: number }
  /** Down for the sustained-outage time: act. */
  | { kind: 'sustained_outage'; outageMs: number }

export interface WatchdogClock {
  /** When the running server was started. */
  startedAt: number
  /** When it last answered a health check, if it has. */
  lastHealthyAt: number | null
}

export function judgeFailedCheck(clock: WatchdogClock, now: number, timing: { coldStartGraceMs: number; sustainedOutageMs: number }): FailedCheckVerdict {
  const graceEndsAt = clock.startedAt + timing.coldStartGraceMs
  if (now < graceEndsAt) return { kind: 'starting' }
  const outageSince = Math.max(graceEndsAt, clock.lastHealthyAt ?? graceEndsAt)
  const outageMs = now - outageSince
  return outageMs < timing.sustainedOutageMs ? { kind: 'outage', outageMs } : { kind: 'sustained_outage', outageMs }
}
