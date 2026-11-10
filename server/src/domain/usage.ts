// Plan usage: how much of a subscription's rolling windows is used, each agent's estimated share, and when goal cycles
// and held agents wait for a window to reset. Pure.
import type { GoalWait, PeerClaudePlan, PlanUsage, PlanWindow } from '@ouro/contract'

/** The subscriptions with usage windows: Claude's plan, and ChatGPT's. */
export type PlanAccount = 'claude' | 'chatgpt'

export const FIVE_HOUR_MINUTES = 300
export const WEEKLY_MINUTES = 10_080

/** Claude's word on a window; Codex gives none. */
export type PlanLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

/** A window as a provider reported it. */
export interface PlanWindowReading extends PlanWindow {
  status: PlanLimitStatus | null
}

/** A window as last read, and when: a report may carry only some windows, so each has its own time. */
export interface ObservedPlanWindow extends PlanWindowReading {
  observedAt: number
}

/** `observedAt`: when the plan was last read, whatever windows that read carried. */
export interface PlanReading {
  windows: ObservedPlanWindow[]
  observedAt: number
}

function byLength(a: PlanWindow, b: PlanWindow): number {
  return a.windowMinutes - b.windowMinutes
}

/** A report may carry only some windows: those it has replace the same windows, the rest stay as last read. */
export function mergePlanReading(previous: PlanReading | null, windows: PlanWindowReading[], at: number): PlanReading {
  const reported = new Set(windows.map((window) => window.windowMinutes))
  const kept = (previous?.windows ?? []).filter((window) => !reported.has(window.windowMinutes))
  const merged = [...kept, ...windows.map((window) => ({ ...window, observedAt: at }))].sort(byLength)
  return { windows: merged, observedAt: at }
}

export function planUsageOf(reading: PlanReading): PlanUsage {
  return { windows: reading.windows.map(({ windowMinutes, usedFraction, resetsAt }) => ({ windowMinutes, usedFraction, resetsAt })), observedAt: reading.observedAt }
}

/** No window is longer than this, so older turn costs fall in none. */
export const LONGEST_WINDOW_MS = WEEKLY_MINUTES * 60_000

/**
 * Where the costs split over a window begin: its length before its reset, or, when the provider gave no reset time, its
 * length before now, the stretch a rolling window covers.
 */
export function windowStartOf(window: PlanWindow, now: number): number {
  const end = window.resetsAt ?? now
  return end - window.windowMinutes * 60_000
}

/** The agent's share of a window: its cost inside the window over everyone's here, times how much of it is used. */
export function shareOfWindow(window: PlanWindow, agentCostUsd: number, allAgentsCostUsd: number): PlanWindow {
  const usedFraction = allAgentsCostUsd > 0 ? (agentCostUsd / allAgentsCostUsd) * window.usedFraction : 0
  return { windowMinutes: window.windowMinutes, usedFraction, resetsAt: window.resetsAt }
}

/** Two readings of the same account's window reset at the same time, give or take how long apart they were read. */
export const SAME_LOGIN_RESET_SKEW_MS = 10 * 60_000

function resetTogether(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= SAME_LOGIN_RESET_SKEW_MS
}

/** Claude's plan as this machine knows it, with what its agents cost in each window with a reset time, for its peers on
 * the same login. */
export function claudePlanForPeers(reading: PlanReading | null, costSince: (since: number) => number, now: number): PeerClaudePlan {
  const windows = (reading?.windows ?? []).flatMap((window) => window.resetsAt === null ? [] : [{
    windowMinutes: window.windowMinutes,
    usedFraction: window.usedFraction,
    resetsAt: window.resetsAt,
    status: window.status,
    observedAt: window.observedAt,
    costUsd: costSince(windowStartOf(window, now)),
  }])
  return { windows }
}

const weeklyResetOf = (windows: PlanWindow[]) => windows.find((window) => window.windowMinutes === WEEKLY_MINUTES)?.resetsAt ?? null

/**
 * The computers on the same login as these windows: the weekly reset is per account, so a computer whose weekly window
 * resets when ours does reads the same plan.
 */
function sameLogin(ourWindows: PlanWindow[], peers: PeerClaudePlan[]): PeerClaudePlan[] {
  const ourWeeklyReset = weeklyResetOf(ourWindows)
  return peers.filter((peer) => resetTogether(weeklyResetOf(peer.windows), ourWeeklyReset))
}

/** The plan as the computers on its login know it: each window as whichever of them read it last. */
export function sameLoginPlanReading(ours: PlanReading | null, peers: PeerClaudePlan[]): PlanReading | null {
  if (ours === null) return null
  const newest = new Map(ours.windows.map((window) => [window.windowMinutes, window]))
  for (const peer of sameLogin(ours.windows, peers)) {
    for (const { costUsd: _cost, ...window } of peer.windows) {
      const known = newest.get(window.windowMinutes)
      if (!known || known.observedAt < window.observedAt) newest.set(window.windowMinutes, window)
    }
  }
  const windows = [...newest.values()].sort(byLength)
  return { windows, observedAt: Math.max(ours.observedAt, ...windows.map((window) => window.observedAt)) }
}

/**
 * What agents on other computers cost inside this window of the plan, counting only computers on the same login. Without
 * them every computer would split the whole plan among its own agents, and shares added up across computers would pass the
 * plan's use. A computer's cost counts for the window of the same length resetting with ours; once ours resets, its
 * costs from before don't.
 */
export function sameLoginCostUsd(window: PlanWindow, ourWindows: PlanWindow[], peers: PeerClaudePlan[]): number {
  let costUsd = 0
  for (const peer of sameLogin(ourWindows, peers)) {
    const same = peer.windows.find((candidate) => candidate.windowMinutes === window.windowMinutes && resetTogether(candidate.resetsAt, window.resetsAt))
    costUsd += same?.costUsd ?? 0
  }
  return costUsd
}

/** Past its reset time, a reading describes a window that is over. */
function current(window: PlanWindowReading, now: number): window is PlanWindowReading & { resetsAt: number } {
  return window.resetsAt !== null && window.resetsAt > now
}

/** What goal cycles may use of each window; above it, the rest is kept for people's messages. */
export const GOAL_CYCLE_MAX_FRACTION: ReadonlyMap<number, number> = new Map([[WEEKLY_MINUTES, 0.35], [FIVE_HOUR_MINUTES, 0.5]])

/** Why a goal's cycles wait for the plan, if they do. The weekly window is the scarcer, so it is named first. */
export function goalPlanHold(reading: PlanReading | null, now: number): Extract<GoalWait, { kind: 'plan_usage' }> | null {
  for (const [windowMinutes, maxFraction] of GOAL_CYCLE_MAX_FRACTION) {
    const window = reading?.windows.find((candidate) => candidate.windowMinutes === windowMinutes)
    if (!window || !current(window, now)) continue
    // Claude warns on the 5-hour window before it is full: the warning holds cycles too.
    const warned = windowMinutes === FIVE_HOUR_MINUTES && window.status !== null && window.status !== 'allowed'
    if (window.usedFraction >= maxFraction || warned) return { kind: 'plan_usage', windowMinutes, usedFraction: window.usedFraction, resetsAt: window.resetsAt }
  }
  return null
}

/** When a plan that refused a turn lets agents run again: once every window it is refusing on has reset. */
export function usageLimitLiftsAt(reading: PlanReading | null, now: number): number | null {
  const refusingResets = (reading?.windows ?? [])
    .filter((window) => window.status === 'rejected' || window.usedFraction >= 1)
    .flatMap((window) => current(window, now) ? [window.resetsAt] : [])
  return refusingResets.length === 0 ? null : Math.max(...refusingResets)
}
