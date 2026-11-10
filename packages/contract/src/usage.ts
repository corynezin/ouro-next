// How much of a subscription's rolling usage limits is used, and roughly by whom.
import { z } from 'zod'

/**
 * One of a plan's rolling windows. Claude's are 300 minutes (5-hour) and 10080 (weekly); ChatGPT's are whatever Codex
 * reports. `usedFraction` may pass 1 when a plan is over its limit. Once `resetsAt` has passed, the window is reset and the
 * reading is stale: show it as 0% until a newer one comes. `resetsAt` null: the provider didn't say.
 */
export const PlanWindow = z.object({
  windowMinutes: z.number().int().positive(),
  usedFraction: z.number().min(0),
  resetsAt: z.number().int().nullable(),
})
export type PlanWindow = z.infer<typeof PlanWindow>

/** A plan's windows as this server last read them. */
export const PlanUsage = z.object({ windows: z.array(PlanWindow), observedAt: z.number().int() })
export type PlanUsage = z.infer<typeof PlanUsage>

/** "5h" for 300 minutes, "7d" for 10080. */
export function windowLabel(windowMinutes: number): string {
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`
  return `${windowMinutes}m`
}
