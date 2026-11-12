import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextCategory, ContextUnavailable } from '@ouro/contract'
import type { ContextDetail, ContextList, ContextRequestRow } from '@ouro/contract'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { CATEGORY_COLORS, CONTEXT_COPY, CONTEXT_FOLLOW_EVERY_MS, ContextReader, Loader, contextFailureText, followDelayMs, percentOf, requestSubtitle, tokensText, usageSummary } from './model.ts'

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

test('every category has a colour and words, and every reason for nothing has words', () => {
  for (const category of ContextCategory.options) assert.ok(CATEGORY_COLORS[category] && CONTEXT_COPY.categories[category])
  for (const reason of ContextUnavailable.options) assert.ok(CONTEXT_COPY.unavailable[reason])
})

test('an older server without these routes is said in plain words', () => {
  assert.equal(contextFailureText({ kind: 'refused', status: 404, error: { code: 'not_found', message: 'no such endpoint: GET /v2/agents/a/context', retryable: false } }), CONTEXT_COPY.serverTooOld)
  assert.equal(contextFailureText({ kind: 'refused', status: 404, error: { code: 'not_found', message: 'no such request', retryable: false } }), 'no such request')
})

test('the list follows activity at most every few seconds', () => {
  assert.equal(followDelayMs(0, 1_000_000), 0)
  assert.equal(followDelayMs(1_000_000, 1_000_000 + 5_000), CONTEXT_FOLLOW_EVERY_MS - 5_000)
})

const row = (n: number, outputTokens: number | null = 1): ContextRequestRow => ({ n, at: 0, model: 'm', messageCount: n + 1, inputTokens: 10, outputTokens })
const page = (ns: number[], hasOlder: boolean, outputTokens: number | null = 1): ContextList => ({ requests: ns.map((n) => row(n, outputTokens)), hasOlder, unavailable: null })
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })

test('the list reader pages older below and follows newer above, without repeating rows', async () => {
  const pages: Record<string, ContextList[]> = { newest: [page([5, 4], true), page([7, 6, 5], true, 9)], 'before:4': [page([3, 2], true)] }
  const asked: string[] = []
  const reader = new ContextReader({
    read: async (before) => { const key = before === null ? 'newest' : `before:${before}`; asked.push(key); return ok(pages[key]!.shift()!) },
    onChange: () => {},
  })
  assert.equal(reader.state.rows, null)
  await reader.follow()
  assert.deepEqual(reader.state.rows!.map((one) => one.n), [5, 4])
  await reader.loadOlder()
  assert.deepEqual(reader.state.rows!.map((one) => one.n), [5, 4, 3, 2])
  assert.equal(reader.state.hasOlder, true)
  await reader.follow()
  assert.deepEqual(reader.state.rows!.map((one) => one.n), [7, 6, 5, 4, 3, 2])
  assert.equal(reader.state.rows![2]!.outputTokens, 9, 'a row read again takes the newer answer')
  assert.equal(reader.state.hasOlder, true)
  assert.deepEqual(asked, ['newest', 'before:4', 'newest'])
})

test('more than a page of new requests starts the list again from the newest', async () => {
  const answers = [page([1, 0], false), page([30, 29], true)]
  const reader = new ContextReader({ read: async () => ok(answers.shift()!), onChange: () => {} })
  await reader.follow()
  await reader.follow()
  assert.deepEqual(reader.state.rows!.map((one) => one.n), [30, 29])
  assert.equal(reader.state.hasOlder, true)
})

test('a failed refresh keeps the list and says why', async () => {
  let fail = false
  const reader = new ContextReader({ read: async () => (fail ? { ok: false, failure: { kind: 'timed_out' } } : ok(page([0], false))), onChange: () => {} })
  await reader.follow()
  fail = true
  await reader.follow()
  assert.deepEqual(reader.state.rows!.map((one) => one.n), [0])
  assert.equal(reader.state.failure, 'request timed out')
  assert.equal(reader.state.loading, false)
})

test('an answer that arrives after the screen closed, or after a newer read, is dropped', async () => {
  let answer: (result: ApiResult<ContextList>) => void = () => {}
  const reader = new ContextReader({ read: () => new Promise((resolve) => { answer = resolve }), onChange: () => {} })
  const pending = reader.follow()
  reader.close()
  answer(ok(page([0], false)))
  await pending
  assert.equal(reader.state.rows, null)

  const answers: ((result: ApiResult<string>) => void)[] = []
  const loader = new Loader<string>({ read: () => new Promise((resolve) => { answers.push(resolve) }), onChange: () => {} })
  const first = loader.load()
  const second = loader.load()
  answers[1]!(ok('newer'))
  await second
  answers[0]!(ok('late'))
  await first
  assert.equal(loader.state.value, 'newer')
  answers.length = 0
  const failed = loader.load()
  answers[0]!({ ok: false, failure: { kind: 'timed_out' } })
  await failed
  assert.deepEqual(loader.state, { value: 'newer', loading: false, failure: 'request timed out' })
})
