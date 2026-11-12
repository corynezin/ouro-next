import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextDetail } from '../domain/context.ts'
import { transcriptAt, transcriptHashOf } from './transcript-requests.ts'

const first = { role: 'user', content: [{ type: 'text', text: 'héllo' }] }
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`
const request = (id: string, keep: number, tail: string[]) => line({ type: 'api-request', id, timestamp: '2026-01-01T00:00:00Z', keep, tail, params: { model: 'm' } })

test("the hash is Claude Code's: sha256 of the JSON with keys sorted at every depth", () => {
  assert.equal(transcriptHashOf({ role: 'user', content: [{ text: 'a', type: 'text' }] }), transcriptHashOf({ content: [{ type: 'text', text: 'a' }], role: 'user' }))
  assert.match(transcriptHashOf(first), /^[0-9a-f]{64}$/)
})

test('a transcript is read once, then only what was appended; a line still being written waits for its end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'))
  try {
    const path = join(dir, 'session.jsonl')
    assert.equal(await transcriptAt(path), null)
    writeFileSync(path, line({ type: 'api-request-blob', hash: transcriptHashOf(first), message: first }) + request('r0', 0, [transcriptHashOf(first)]))
    const state = await transcriptAt(path)
    assert.equal(state!.requests.length, 1)
    const half = request('r1', 1, [])
    appendFileSync(path, half.slice(0, 10))
    assert.equal((await transcriptAt(path))!.requests.length, 1)
    appendFileSync(path, half.slice(10))
    const grown = await transcriptAt(path)
    assert.equal(grown, state, 'the same reading, carried on')
    assert.equal(grown!.requests.length, 2)
    const message = contextDetail(grown!, 1)!.messages[0]!
    assert.equal(message.kind === 'message' && message.blocks[0]!.text, 'héllo')

    writeFileSync(path, request('again', 0, []))
    const shrunk = await transcriptAt(path)
    assert.notEqual(shrunk, state)
    assert.deepEqual(shrunk!.requests.map((one) => one.id), ['again'])
    const [a, b] = await Promise.all([transcriptAt(path), transcriptAt(path)])
    assert.equal(a, b)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
