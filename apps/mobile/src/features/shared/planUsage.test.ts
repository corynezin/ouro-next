import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlanUsage } from '@ouro/contract'
import { agentUsageText, claudePlanRows, isClaudeOnPlan, openRouterSpentUsd, planUsageLine, planWindowRows } from './planUsage.ts'

const NOW = Date.UTC(2026, 10, 10, 12)
const HOUR = 3_600_000
const claude: PlanUsage = {
  windows: [
    { windowMinutes: 10_080, usedFraction: 0.634, resetsAt: NOW + 50 * HOUR },
    { windowMinutes: 300, usedFraction: 0.42, resetsAt: NOW - HOUR },
  ],
  observedAt: NOW - 2 * HOUR,
}

test('Settings lists the windows shortest first, a reset one at 0% with no reset time', () => {
  const rows = planWindowRows(claude, NOW)
  assert.deepEqual(rows.map((row) => row.label), ['5-hour', 'Weekly'])
  assert.equal(rows[0]!.valueText, '0%')
  assert.match(rows[1]!.valueText, /^63% \(resets .+\)$/)
  assert.deepEqual(planWindowRows({ windows: [{ windowMinutes: 60, usedFraction: 1.2, resetsAt: null }], observedAt: NOW }, NOW), [{ key: 60, label: '1h', valueText: '120%' }])
})

test("the list's line gives each read plan's longest window", () => {
  assert.equal(planUsageLine({ claude: null, chatgpt: null }, false, null, NOW), null)
  assert.equal(planUsageLine({ claude, chatgpt: null }, false, null, NOW), 'Claude: 63%')
  const chatgpt: PlanUsage = { windows: [{ windowMinutes: 300, usedFraction: 0.12, resetsAt: null }], observedAt: NOW }
  assert.equal(planUsageLine({ claude, chatgpt }, false, null, NOW), 'Claude: 63% · ChatGPT: 12%')
  assert.equal(planUsageLine({ claude, chatgpt }, false, 1.2, NOW), 'Claude: 63% · ChatGPT: 12% · OpenRouter: $1.20')
  assert.equal(planUsageLine({ claude: null, chatgpt: null }, false, 0, NOW), 'OpenRouter: $0.00', 'what OpenRouter says, even nothing spent yet')
})

test("an agent's usage is its share of the plan, or dollars off it or before the plan is read", () => {
  const share = [{ windowMinutes: 10_080, usedFraction: 0.01, resetsAt: null }, { windowMinutes: 300, usedFraction: 0.0004, resetsAt: null }]
  assert.equal(agentUsageText({ planShare: share, costUsd: 3 }), '~<0.1% of 5h · ~1% of 7d')
  assert.equal(agentUsageText({ planShare: [], costUsd: 3 }), '$3.00')
  assert.equal(agentUsageText({ planShare: null, costUsd: 0 }), null)
})

test("OpenRouter's part: what OpenRouter says the key spent, else the OpenRouter agents' own estimate, else none (AG-10)", () => {
  const models = [{ id: 'or/x', label: 'X', provider: 'openrouter', available: true }, { id: 'opus', label: 'Opus', provider: 'anthropic', available: true }] as const
  const agents = [{ model: 'or/x', costUsd: 0.5 }, { model: 'or/x', costUsd: 0.25 }, { model: 'opus', costUsd: 9 }]
  assert.equal(openRouterSpentUsd({ status: 'configured', spentUsd: 3, availableUsd: 7 }, agents, models), 3)
  assert.equal(openRouterSpentUsd({ status: 'configured', spentUsd: null, availableUsd: null }, agents, models), 0.75, 'OpenRouter did not answer')
  assert.equal(openRouterSpentUsd(null, agents, models), 0.75)
  assert.equal(openRouterSpentUsd({ status: 'not_configured' }, [{ model: 'opus', costUsd: 9 }], models), null, 'a subscription cost is not OpenRouter spend')
})

test("before Claude's first turn on a plan, Settings and the list's line say there is no reading yet; an API key has no plan", () => {
  const onPlan = isClaudeOnPlan({ status: 'signed_in', account: { method: 'plan', email: null } })
  assert.equal(onPlan, true)
  assert.equal(isClaudeOnPlan({ status: 'signed_in', account: { method: 'api_key' } }), false)
  assert.equal(isClaudeOnPlan({ status: 'signed_out' }), false)
  assert.equal(isClaudeOnPlan(null), false)
  assert.deepEqual(claudePlanRows(null, true, NOW), [{ key: 0, label: 'Usage', valueText: 'No reading yet' }])
  assert.equal(claudePlanRows(null, false, NOW), null, 'no section without a plan')
  assert.deepEqual(claudePlanRows(claude, false, NOW), planWindowRows(claude, NOW), 'a reading shows, whatever the sign-in says now')
  assert.equal(planUsageLine({ claude: null, chatgpt: null }, true, null, NOW), 'Claude: no reading yet')
  assert.equal(planUsageLine({ claude: null, chatgpt: null }, true, 1.2, NOW), 'Claude: no reading yet · OpenRouter: $1.20')
  assert.equal(planUsageLine({ claude, chatgpt: null }, true, null, NOW), 'Claude: 63%')
})
