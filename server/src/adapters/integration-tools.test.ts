import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openrouterAvailableUsd, planWindowsOfCodexRateLimits } from './integration-tools.ts'

test("Codex's rate limits give the Codex limit's windows, or else the account's", () => {
  const account = { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_794_000_000 }, secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: null } }
  assert.deepEqual(planWindowsOfCodexRateLimits({ rateLimits: account }), [
    { windowMinutes: 300, usedFraction: 0.42, resetsAt: 1_794_000_000_000, status: null },
    { windowMinutes: 10_080, usedFraction: 0.07, resetsAt: null, status: null },
  ])
  const byId = { rateLimits: account, rateLimitsByLimitId: { codex: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_794_000_000 }, secondary: null } } }
  assert.deepEqual(planWindowsOfCodexRateLimits(byId), [{ windowMinutes: 300, usedFraction: 0.03, resetsAt: 1_794_000_000_000, status: null }])
  assert.deepEqual(planWindowsOfCodexRateLimits({ rateLimits: { primary: { usedPercent: 5 } } }), [], 'a window of no known length')
})

test('an OpenRouter key may spend the lesser of its limit left and the credits left', () => {
  assert.equal(openrouterAvailableUsd({ limit_remaining: 4 }, { total_credits: 20, total_usage: 12.5 }), 4)
  assert.equal(openrouterAvailableUsd({ limit_remaining: null }, { total_credits: 20, total_usage: 12.5 }), 7.5)
  assert.equal(openrouterAvailableUsd({ limit_remaining: 4 }, undefined), 4)
  assert.equal(openrouterAvailableUsd({}, { total_credits: 10, total_usage: 11 }), 0, 'never below nothing')
  assert.equal(openrouterAvailableUsd(undefined, undefined), null)
})
