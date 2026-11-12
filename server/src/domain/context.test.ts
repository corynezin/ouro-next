import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_BLOCK_CHARS, DOCUMENT_TOKENS, IMAGE_TOKENS, contextBlockText, contextDetail, contextRows, emptyTranscript, estimateTokens, feedTranscript, inputTokensOfUsage } from './context.ts'
import type { TranscriptState } from './context.ts'

// The hash is the adapter's to choose; any function that tells messages apart will do here. Every message below is
// written as { role, content }, the order the rebuilt ones have.
const hash = (message: unknown) => JSON.stringify(message)
const usage = (cacheRead: number) => ({ input_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 8, output_tokens: 5 })
const transcriptOf = (entries: unknown[]): TranscriptState => {
  const state = emptyTranscript()
  for (const entry of entries) feedTranscript(state, entry, hash)
  return state
}
const request = (id: string, base: string | null, keep: number, tail: string[]) =>
  ({ type: 'api-request', id, ...(base === null ? {} : { base }), timestamp: '2026-01-01T00:00:00Z', shapeHash: 's', keep, tail, params: { model: 'm' } })
const shape = { type: 'api-request-shape', shapeHash: 's', shape: { system: [{ type: 'text', text: 'be helpful' }], tools: [{ name: 'Bash', description: 'run it' }] } }
const roles = (state: TranscriptState, n: number) => contextDetail(state, n)!.messages.map((message) => (message.kind === 'message' ? message.role : '?'))

const first = { role: 'user', content: [{ type: 'text', text: 'hello there' }] }
const toolCall = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] }

const simple = [
  shape,
  { type: 'api-request-blob', hash: hash(first), message: first },
  request('r0', null, 0, [hash(first)]),
  { type: 'assistant', message: { ...toolCall, id: 'msg_1', usage: usage(100) } },
  { type: 'user', message: result },
  request('r1', 'r0', 1, [hash(toolCall), hash(result)]),
  { type: 'assistant', message: { role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: usage(200) } },
]

test('requests are rebuilt from keep + tail, newest first, with exact usage', () => {
  const state = transcriptOf(simple)
  assert.deepEqual([roles(state, 0), roles(state, 1)], [['user'], ['user', 'assistant', 'user']])
  const { requests, hasOlder } = contextRows(state, null, 10)
  assert.deepEqual(requests.map((row) => [row.n, row.messageCount, row.inputTokens, row.outputTokens]), [[1, 3, 210, 5], [0, 1, 110, 5]])
  assert.equal(hasOlder, false)
})

test('the list pages back from a request, as summaries do', () => {
  const state = transcriptOf(simple)
  assert.deepEqual(contextRows(state, null, 1), { requests: [contextRows(state, null, 10).requests[0]], hasOlder: true })
  assert.deepEqual(contextRows(state, 1, 1).requests.map((row) => row.n), [0])
  assert.equal(contextRows(state, 1, 1).hasOlder, false)
  assert.deepEqual(contextRows(state, 0, 5).requests, [])
})

test('consecutive entries of one role are sent as one message: a tool result and a message that came meanwhile', () => {
  const later = { role: 'user', content: 'and also this' }
  const merged = { role: 'user', content: [...result.content, { type: 'text', text: 'and also this' }] }
  const call = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, ...toolCall.content] }
  const state = transcriptOf([
    shape,
    { type: 'api-request-blob', hash: hash(first), message: first },
    request('r0', null, 0, [hash(first)]),
    { type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [call.content[0]], usage: usage(1) } },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [call.content[1]], usage: usage(1) } },
    { type: 'user', message: result },
    { type: 'attachment' },
    { type: 'user', message: later },
    request('r1', 'r0', 1, [hash(call), hash(merged)]),
  ])
  const detail = contextDetail(state, 1)!
  assert.equal(detail.messages.some((message) => message.kind === 'unresolved'), false)
  assert.deepEqual(detail.messages.map((message) => message.kind === 'message' && message.blocks.map((block) => block.type)), [['text'], ['thinking', 'tool_use'], ['tool_result', 'text']])
})

test("Claude Code's own system messages come from blobs and count as reminders", () => {
  const reminder = { role: 'system', content: [{ type: 'text', text: 'a reminder' }] }
  const state = transcriptOf([shape, { type: 'api-request-blob', hash: hash(first), message: first }, { type: 'api-request-blob', hash: hash(reminder), message: reminder }, request('r0', null, 0, [hash(first), hash(reminder)])])
  assert.deepEqual(roles(state, 0), ['user', 'system'])
  assert.ok(contextDetail(state, 0)!.categories.some((category) => category.name === 'system_reminders'))
})

test("a request keeps the messages of the request named as its base, not merely the one before", () => {
  const side = { role: 'user', content: [{ type: 'text', text: 'a side question' }] }
  const state = transcriptOf([
    ...simple,
    { type: 'api-request-blob', hash: hash(side), message: side },
    request('side', null, 0, [hash(side)]),
    request('r2', 'r1', 3, []),
  ])
  assert.deepEqual(roles(state, 3), ['user', 'assistant', 'user'])
})

test('a message the transcript does not hold, or a base it lacks, shows as unresolved in its place', () => {
  assert.deepEqual(roles(transcriptOf([request('r0', null, 0, ['f'.repeat(64)])]), 0), ['?'])
  assert.deepEqual(roles(transcriptOf([{ type: 'api-request-blob', hash: hash(first), message: first }, request('r5', 'gone', 2, [hash(first)])]), 0), ['?', '?', 'user'])
})

test('a reply stored as one entry per block comes back whole, with its last usage', () => {
  const state = transcriptOf([
    request('r0', null, 0, [hash(first)]),
    { type: 'assistant', message: { role: 'assistant', id: 'msg_9', content: [{ type: 'thinking', thinking: 'hmm' }], usage: usage(1) } },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_9', content: [{ type: 'text', text: 'hi' }], usage: { ...usage(1), output_tokens: 40 } } },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_10', content: [{ type: 'text', text: 'a later reply' }], usage: usage(3) } },
  ])
  assert.deepEqual(contextDetail(state, 0)!.response.map((block) => block.type), ['thinking', 'text'])
  assert.equal(contextRows(state, null, 1).requests[0]!.outputTokens, 40)
})

test('detail categories add up to the reported input total', () => {
  const detail = contextDetail(transcriptOf(simple), 1)!
  assert.equal(detail.exact, true)
  assert.ok(Math.abs(detail.categories.reduce((sum, category) => sum + category.tokens, 0) - 210) <= detail.categories.length)
  const call = detail.messages[1]!
  assert.equal(call.kind === 'message' && call.blocks[0]!.label, 'Bash')
  assert.equal(detail.response[0]!.text, 'done')
  assert.equal(contextDetail(transcriptOf(simple), 2), null)
})

test('a request with no reply yet has no usage, and its counts are estimates', () => {
  const pending = transcriptOf([{ type: 'api-request-blob', hash: hash(first), message: first }, request('r0', null, 0, [hash(first)])])
  assert.equal(contextRows(pending, null, 1).requests[0]!.inputTokens, null)
  assert.equal(contextDetail(pending, 0)!.exact, false)
})

test('an image is counted by a fixed cost, not its base64 length, and shown by its size', () => {
  const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(400_000) } }
  const looked = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'here it is' }, screenshot] }] }
  assert.ok(estimateTokens(screenshot) >= IMAGE_TOKENS && estimateTokens(screenshot) < IMAGE_TOKENS + 50)
  assert.ok(estimateTokens({ type: 'document', source: { type: 'base64', data: 'A'.repeat(1_000_000) } }) < DOCUMENT_TOKENS + 50)
  const state = transcriptOf([
    shape, { type: 'api-request-blob', hash: hash(first), message: first }, request('r0', null, 0, [hash(first)]),
    { type: 'assistant', message: { ...toolCall, id: 'msg_1', usage: usage(1) } },
    { type: 'user', message: looked }, { type: 'user', message: { role: 'user', content: [screenshot] } },
    request('r1', 'r0', 1, [hash(toolCall), hash({ role: 'user', content: [...looked.content, screenshot] })]),
  ])
  const detail = contextDetail(state, 1)!
  const [result, alone] = (detail.messages[2]!.kind === 'message' && detail.messages[2]!.blocks) || []
  assert.equal(result!.text, 'here it is\n[image, 293 KB]')
  assert.equal(alone!.text, '[image, 293 KB]')
  assert.equal(contextBlockText(state, 1, { part: 'message', item: 2, block: 1 }), '[image, 293 KB]')
  assert.ok(detail.categories.some((category) => category.name === 'attachments'))
})

test('a tool result whose content is neither text nor a list is shown, not a failure', () => {
  const odd = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: { type: 'text', text: 'one part' } }, { type: 'tool_result', tool_use_id: 't2', content: 7 }] }
  const state = transcriptOf([{ type: 'api-request-blob', hash: hash(odd), message: odd }, request('r0', null, 0, [hash(odd)])])
  const message = contextDetail(state, 0)!.messages[0]!
  assert.deepEqual(message.kind === 'message' && message.blocks.map((block) => block.text), ['one part', ''])
})

test('malformed entries are passed over', () => {
  const state = transcriptOf([null, 7, 'x', { type: 'user' }, { type: 'user', message: { role: 9, content: 'x' } }, { type: 'api-request', keep: 'x', tail: 'y' }, { type: 'api-request-blob', hash: 3 }])
  assert.equal(state.requests.length, 1)
  assert.deepEqual(contextDetail(state, 0)!.messages, [])
})

test('a block comes back whole by its place, however long', () => {
  const state = transcriptOf(simple)
  assert.equal(contextBlockText(state, 1, { part: 'system', item: 0, block: 0 }), 'be helpful')
  assert.equal(contextBlockText(state, 1, { part: 'message', item: 2, block: 0 }), 'a.txt')
  assert.equal(contextBlockText(state, 1, { part: 'response', item: 0, block: 0 }), 'done')
  assert.equal(contextBlockText(state, 1, { part: 'message', item: 9, block: 0 }), null)
  assert.equal(contextBlockText(state, 1, { part: 'response', item: 0, block: 5 }), null)
  assert.equal(contextBlockText(state, 7, { part: 'system', item: 0, block: 0 }), null)
  const long = { role: 'user', content: 'y'.repeat(50_000) }
  const big = transcriptOf([{ type: 'api-request-blob', hash: hash(long), message: long }, request('r0', null, 0, [hash(long)])])
  assert.equal(contextBlockText(big, 0, { part: 'message', item: 0, block: 0 })!.length, 50_000)
  const shown = contextDetail(big, 0)!.messages[0]!
  const block = shown.kind === 'message' ? shown.blocks[0]! : null
  assert.equal(block?.truncated, true)
  assert.ok(block!.text.startsWith('y'.repeat(CONTEXT_BLOCK_CHARS)) && block!.text.length < CONTEXT_BLOCK_CHARS + 100)
})

test('input tokens are uncached + cache read + cache written', () => {
  assert.equal(inputTokensOfUsage(usage(100)), 110)
  assert.equal(inputTokensOfUsage({ input_tokens: 'x', output_tokens: 4 }), 0)
})
