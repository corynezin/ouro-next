import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudePlanForPeers, goalPlanHold, mergePlanReading, sameLoginCostUsd, sameLoginPlanReading, shareOfWindow, usageLimitLiftsAt, windowStartOf } from './usage.ts'
import type { ObservedPlanWindow, PlanWindowReading } from './usage.ts'
import type { PeerPlanWindow } from '@ouro/contract'

const HOUR = 3_600_000
const fiveHour = (usedFraction: number, resetsAt: number, status: PlanWindowReading['status'] = 'allowed'): PlanWindowReading => ({ windowMinutes: 300, usedFraction, resetsAt, status })
const weekly = (usedFraction: number, resetsAt: number, status: PlanWindowReading['status'] = 'allowed'): PlanWindowReading => ({ windowMinutes: 10_080, usedFraction, resetsAt, status })
const at = (observedAt: number, window: PlanWindowReading): ObservedPlanWindow => ({ ...window, observedAt })
const reading = (...windows: PlanWindowReading[]) => ({ windows: windows.map((window) => at(0, window)), observedAt: 0 })
const told = (observedAt: number, costUsd: number, window: PlanWindowReading): PeerPlanWindow => ({ ...window, resetsAt: window.resetsAt!, observedAt, costUsd })

test('a report replaces the windows it carries and keeps the others, each with when it was read', () => {
  const first = mergePlanReading(null, [weekly(0.2, 100 * HOUR), fiveHour(0.1, 4 * HOUR)], 1)
  const next = mergePlanReading(first, [weekly(0.25, 100 * HOUR)], 2)
  assert.deepEqual(next, { windows: [at(1, fiveHour(0.1, 4 * HOUR)), at(2, weekly(0.25, 100 * HOUR))], observedAt: 2 })
})

test("an agent's share is its part of the window's cost, times how much of the window is used", () => {
  const window = fiveHour(0.4, 5 * HOUR)
  assert.equal(windowStartOf(window, HOUR), 0)
  assert.equal(shareOfWindow(window, 1, 4).usedFraction, 0.1)
  assert.equal(shareOfWindow(window, 0, 0).usedFraction, 0, 'nothing spent here')
  assert.equal(windowStartOf({ windowMinutes: 300, usedFraction: 0.4, resetsAt: null }, 6 * HOUR), HOUR, 'no reset time: the last five hours')
})

test('a computer tells its peers each window it knows with a reset time, and what its agents cost in it', () => {
  const since: number[] = []
  const plan = claudePlanForPeers(reading(fiveHour(0.4, 5 * HOUR), { windowMinutes: 10_080, usedFraction: 0.1, resetsAt: null, status: null }), (start) => { since.push(start); return 2 }, HOUR)
  assert.deepEqual(plan, { windows: [told(0, 2, fiveHour(0.4, 5 * HOUR))] })
  assert.deepEqual(since, [0], 'from the window start')
  assert.deepEqual(claudePlanForPeers(null, () => 1, HOUR), { windows: [] })
})

test("only computers on the same login, whose week resets with ours, add their costs, for the window resetting with ours", () => {
  const ours = [fiveHour(0.4, 5 * HOUR), weekly(0.2, 100 * HOUR)]
  const sameLogin = { windows: [told(0, 3, fiveHour(0.4, 5 * HOUR + 60_000)), told(0, 7, weekly(0.2, 100 * HOUR - 9 * 60_000))] }
  const otherLogin = { windows: [told(0, 50, fiveHour(0.4, 5 * HOUR)), told(0, 50, weekly(0.2, 60 * HOUR))] }
  const staleFiveHours = { windows: [told(0, 11, fiveHour(0.4, 0)), told(0, 1, weekly(0.2, 100 * HOUR))] }
  assert.equal(sameLoginCostUsd(ours[0]!, ours, [sameLogin, otherLogin, staleFiveHours]), 3)
  assert.equal(sameLoginCostUsd(ours[1]!, ours, [sameLogin, otherLogin, staleFiveHours]), 8)
  assert.equal(sameLoginCostUsd(ours[0]!, [ours[0]!], [sameLogin]), 0, 'no weekly window read here: no telling which login')
  assert.equal(sameLoginCostUsd(ours[0]!, ours, [{ windows: [sameLogin.windows[0]!] }]), 0, 'none read there either')
})

test('each window shows as whichever computer on the login read it last', () => {
  const ours = { windows: [at(10, fiveHour(0.4, 5 * HOUR)), at(10, weekly(0.2, 100 * HOUR))], observedAt: 10 }
  const sameLogin = { windows: [told(20, 0, fiveHour(0.5, 5 * HOUR, 'allowed_warning')), told(5, 0, weekly(0.1, 100 * HOUR))] }
  const otherLogin = { windows: [told(30, 0, fiveHour(0.9, 5 * HOUR)), told(30, 0, weekly(0.9, 60 * HOUR))] }
  assert.deepEqual(sameLoginPlanReading(ours, [sameLogin, otherLogin]), {
    windows: [at(20, fiveHour(0.5, 5 * HOUR, 'allowed_warning')), at(10, weekly(0.2, 100 * HOUR))],
    observedAt: 20,
  })
  const onlyWeekly = { windows: [at(10, weekly(0.2, 100 * HOUR))], observedAt: 10 }
  assert.deepEqual(sameLoginPlanReading(onlyWeekly, [sameLogin])?.windows.map((window) => window.windowMinutes), [300, 10_080], 'a window not read here comes from there')
  assert.equal(sameLoginPlanReading(null, [sameLogin]), null, 'nothing read here: no telling which login')
})

test('goal cycles hold at 35% of the week or 50% of five hours, or a warning, until the window resets', () => {
  const now = HOUR
  assert.equal(goalPlanHold(reading(fiveHour(0.49, 4 * HOUR), weekly(0.34, 90 * HOUR)), now), null)
  assert.deepEqual(goalPlanHold(reading(fiveHour(0.5, 4 * HOUR)), now), { kind: 'plan_usage', windowMinutes: 300, usedFraction: 0.5, resetsAt: 4 * HOUR })
  assert.equal(goalPlanHold(reading(fiveHour(0.2, 4 * HOUR, 'allowed_warning')), now)?.windowMinutes, 300)
  assert.equal(goalPlanHold(reading(fiveHour(0.9, 4 * HOUR), weekly(0.4, 90 * HOUR)), now)?.windowMinutes, 10_080, 'the week first')
  assert.equal(goalPlanHold(reading(fiveHour(0.9, HOUR / 2)), now), null, 'a window past its reset is stale')
  assert.equal(goalPlanHold(null, now), null)
})

test('a usage limit lifts when every window refusing has reset', () => {
  const now = HOUR
  assert.equal(usageLimitLiftsAt(reading(fiveHour(1, 3 * HOUR, 'rejected'), weekly(0.5, 90 * HOUR)), now), 3 * HOUR)
  assert.equal(usageLimitLiftsAt(reading(fiveHour(1.02, 3 * HOUR), weekly(1, 90 * HOUR, 'rejected')), now), 90 * HOUR)
  assert.equal(usageLimitLiftsAt(reading(fiveHour(0.3, 3 * HOUR)), now), null, 'no window says why: unknown')
  assert.equal(usageLimitLiftsAt(reading(fiveHour(1, HOUR / 2, 'rejected')), now), null, 'stale')
})
