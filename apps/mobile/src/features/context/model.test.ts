import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextDetail } from '@ouro/contract'
import { percentOf, requestSubtitle, tokensText, usageSummary } from './model.ts'

test('token counts read short', () => {
  assert.deepEqual([tokensText(null), tokensText(950), tokensText(1234), tokensText(72215)], ['–', '950', '1,234', '72.2k'])
  assert.equal(percentOf(1, 3), 33.3)
  assert.equal(percentOf(1, 0), 0)
})

test('the summary says exact usage, or that it is an estimate', () => {
  const base = { n: 0, at: 0, model: 'm', totalInput: 5000, categories: [], system: [], tools: [], messages: [], response: [] }
  const exact: ContextDetail = { ...base, exact: true, usage: { uncached: 2, cacheRead: 4000, cacheWrite: 998, output: 20, totalInput: 5000 } }
  assert.equal(usageSummary(exact), '5,000 in · 4,000 cached · 998 cache write · 20 out')
  assert.equal(usageSummary({ ...base, exact: false, usage: null }), '~5,000 in (estimate)')
})

test("a request's row says its messages, output and model", () => {
  assert.equal(requestSubtitle({ messageCount: 1, outputTokens: 20, model: 'claude-x' }), '1 message · 20 out · claude-x')
  assert.equal(requestSubtitle({ messageCount: 12, outputTokens: null, model: '' }), '12 messages · – out')
})
