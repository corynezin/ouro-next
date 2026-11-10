// How often the watchdog may restart the server: durable, so a guardian restart can't reset it. If the record can't be
// read, the answer is no. A wrong "no" leaves a person to step in; a wrong "yes" can turn an outage into a restart loop.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface RestartLimits {
  perFifteenMinutes: number
  perHour: number
}

export const defaultRestartLimits: RestartLimits = { perFifteenMinutes: 1, perHour: 3 }

const FIFTEEN_MINUTES_MS = 15 * 60_000
const HOUR_MS = 60 * 60_000

export type BudgetAnswer = { allowed: true } | { allowed: false; why: string }

export function evaluateBudget(restartTimes: readonly number[], now: number, limits: RestartLimits): BudgetAnswer {
  const inLastFifteen = restartTimes.filter((time) => now - time < FIFTEEN_MINUTES_MS).length
  if (inLastFifteen >= limits.perFifteenMinutes) return { allowed: false, why: `${inLastFifteen} restart(s) in the last 15 minutes` }
  const inLastHour = restartTimes.filter((time) => now - time < HOUR_MS).length
  if (inLastHour >= limits.perHour) return { allowed: false, why: `${inLastHour} restarts in the last hour` }
  return { allowed: true }
}

export class RestartBudget {
  private readonly path: string
  private readonly limits: RestartLimits

  constructor(path: string, limits: RestartLimits = defaultRestartLimits) {
    this.path = path
    this.limits = limits
  }

  private read(): { readable: true; times: number[] } | { readable: false; why: string } {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { readable: true, times: [] }
      return { readable: false, why: (error as Error).message }
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed) || !parsed.every((time) => typeof time === 'number')) return { readable: false, why: 'the record is not a list of times' }
      return { readable: true, times: parsed as number[] }
    } catch (error) {
      return { readable: false, why: (error as Error).message }
    }
  }

  /** Spends one restart if the budget allows it. */
  trySpend(now: number): BudgetAnswer {
    const record = this.read()
    if (!record.readable) return { allowed: false, why: `the restart budget is unreadable: ${record.why}` }
    const answer = evaluateBudget(record.times, now, this.limits)
    if (!answer.allowed) return answer
    const kept = record.times.filter((time) => now - time < HOUR_MS)
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify([...kept, now]))
    renameSync(temporary, this.path)
    return answer
  }
}
