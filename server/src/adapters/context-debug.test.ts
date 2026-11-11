import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXT_BLOCK_CHARS, contextBlockText, contextDetail, contextRows, rebuildRequests, requestsOfTranscript } from './context-debug.ts'

// The transcript hashes messages with their keys sorted, at every depth.
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)])) : value
const hash = (message: unknown) => createHash('sha256').update(JSON.stringify(sorted(message))).digest('hex')
const usage = (cacheRead: number) => ({ input_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 8, output_tokens: 5 })

const first = { role: 'user', content: [{ type: 'text', text: 'hello there' }] }
const toolCall = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] }
const line = (entry: unknown) => JSON.stringify(entry)
const request = (keep: number, tail: string[]) => ({ type: 'api-request', timestamp: '2026-01-01T00:00:00Z', shapeHash: 's', keep, tail, params: { model: 'm' } })

const transcript = [
  { type: 'api-request-shape', shapeHash: 's', shape: { system: [{ type: 'text', text: 'be helpful' }], tools: [{ name: 'Bash', description: 'run it' }] } },
  { type: 'api-request-blob', hash: hash(first), message: first },
  request(0, [hash(first)]),
  { type: 'assistant', message: { ...toolCall, id: 'msg_1', usage: usage(100) } },
  { type: 'user', message: result },
  request(1, [hash(toolCall), hash(result)]),
  { type: 'assistant', message: { role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: usage(200) } },
].map(line).join('\n')

test('requests are rebuilt from keep + tail, with exact usage', () => {
  const rebuilt = rebuildRequests(transcript)
  assert.deepEqual(rebuilt.map((r) => r.messages.map((m) => m.role)), [['user'], ['user', 'assistant', 'user']])
  assert.deepEqual(contextRows(rebuilt).map((r) => r.inputTokens), [110, 210])
  assert.equal(rebuilt[1]!.messages.every((m) => m.source !== 'unresolved'), true)
})

test('detail categories add up to the reported input total', () => {
  const detail = contextDetail(rebuildRequests(transcript)[1]!, 1)
  assert.equal(detail.exact, true)
  assert.ok(Math.abs(detail.categories.reduce((a, c) => a + c.tokens, 0) - 210) <= detail.categories.length)
  assert.equal(detail.messages[1]!.blocks[0]!.label, 'Bash')
  assert.equal(detail.response[0]!.text, 'done')
})

test('a message the transcript does not hold shows as unresolved', () => {
  const lost = [line(request(0, ['f'.repeat(64)]))].join('\n')
  assert.equal(rebuildRequests(lost)[0]!.messages[0]!.source, 'unresolved')
})

test('a reply stored as one entry per block comes back whole, with its last usage', () => {
  const split = [
    line(request(0, [hash(first)])),
    line({ type: 'assistant', message: { role: 'assistant', id: 'msg_9', content: [{ type: 'thinking', thinking: 'hmm' }], usage: usage(1) } }),
    line({ type: 'assistant', message: { role: 'assistant', id: 'msg_9', content: [{ type: 'text', text: 'hi' }], usage: { ...usage(1), output_tokens: 40 } } }),
    line({ type: 'assistant', message: { role: 'assistant', id: 'msg_10', content: [{ type: 'text', text: 'a later reply' }], usage: usage(3) } }),
  ].join('\n')
  const [only] = rebuildRequests(split)
  assert.deepEqual(only!.response.map((block) => block.type), ['thinking', 'text'])
  assert.equal(contextRows([only!])[0]!.outputTokens, 40)
})

test('a request with no reply yet has no usage, and its counts are estimates', () => {
  const pending = rebuildRequests(line(request(0, [hash(first)])) + '\n' + line({ type: 'api-request-blob', hash: hash(first), message: first }))
  assert.equal(contextRows(pending)[0]!.inputTokens, null)
  assert.equal(contextDetail(pending[0]!, 0).exact, false)
})

test('a block comes back whole by its place, however long', () => {
  const rebuilt = rebuildRequests(transcript)[1]!
  assert.equal(contextBlockText(rebuilt, { part: 'system', item: 0, block: 0 }), 'be helpful')
  assert.equal(contextBlockText(rebuilt, { part: 'message', item: 2, block: 0 }), 'a.txt')
  assert.equal(contextBlockText(rebuilt, { part: 'response', item: 0, block: 0 }), 'done')
  assert.equal(contextBlockText(rebuilt, { part: 'message', item: 9, block: 0 }), null)
  assert.equal(contextBlockText(rebuilt, { part: 'response', item: 0, block: 5 }), null)
  const long = { ...rebuilt, messages: [{ role: 'user', source: 'blob' as const, content: [{ type: 'text', text: 'y'.repeat(50_000) }] }] }
  assert.equal(contextBlockText(long, { part: 'message', item: 0, block: 0 })!.length, 50_000)
  const shown = contextDetail(long, 0).messages[0]!.blocks[0]!
  assert.equal(shown.truncated, true)
  assert.ok(shown.text.startsWith('y'.repeat(CONTEXT_BLOCK_CHARS)) && shown.text.length < CONTEXT_BLOCK_CHARS + 100)
})

test('a transcript file is read again only when it changes, and a missing one is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-debug-'))
  try {
    const path = join(dir, 'session.jsonl')
    assert.equal(requestsOfTranscript(path), null)
    writeFileSync(path, transcript)
    const once = requestsOfTranscript(path)
    assert.equal(once!.length, 2)
    assert.equal(requestsOfTranscript(path), once)
    appendFileSync(path, '\n' + line(request(3, [])))
    assert.equal(requestsOfTranscript(path)!.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
