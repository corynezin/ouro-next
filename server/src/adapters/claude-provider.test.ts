import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classifyClaudeFailure, contextOfUsage, isUnresumableSession, planWindowsOfRateLimit, startClaudeSession } from './claude-provider.ts'
import type { ProviderEvent } from './provider.ts'

test('a safeguards refusal is its own kind, even though it reads as an API error', () => {
  assert.equal(classifyClaudeFailure("API Error: Opus 5.5's safeguards flagged this message as a potential violation of our usage policy. [reasoning_extraction]"), 'model_refused')
  assert.equal(classifyClaudeFailure('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked: this request violates our Usage Policy"}}'), 'model_refused')
})

test('other failures keep their kinds', () => {
  assert.equal(classifyClaudeFailure('API Error: 529 Overloaded'), 'transient')
  assert.equal(classifyClaudeFailure('Credit balance is too low'), 'credits')
  assert.equal(classifyClaudeFailure('Invalid API key · Please run /login'), 'logged_out')
  assert.equal(classifyClaudeFailure("Claude AI usage limit reached|1794250000"), 'usage_limit')
  assert.equal(classifyClaudeFailure('something nobody has seen before'), 'transient')
})

test('a session Claude Code no longer has is recognised from what it prints before exiting', () => {
  assert.equal(isUnresumableSession('No conversation found with session ID: 5f0c2a1e-7d1b-4c55-9a51-3f6e9c1d2b44'), true)
  assert.equal(isUnresumableSession('API Error: 529 Overloaded'), false)
})

test('a request\'s usage gives the prompt size, cached for the lifetime it wrote with, or else the one it was written with', () => {
  const HOUR = 3_600_000
  const wrote1h = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 } }
  assert.deepEqual(contextOfUsage(wrote1h, 300_000), { tokens: 102_010, cacheTtlMs: HOUR })
  const wrote5m = { input_tokens: 10, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 } }
  assert.deepEqual(contextOfUsage(wrote5m, HOUR), { tokens: 510, cacheTtlMs: 300_000 })
  assert.deepEqual(contextOfUsage({ input_tokens: 3, cache_read_input_tokens: 90_000 }, HOUR), { tokens: 90_003, cacheTtlMs: HOUR }, 'a read keeps the lifetime')
  assert.equal(contextOfUsage({ input_tokens: 0, output_tokens: 40 }, HOUR), null)
})

test('a rate-limit event gives the plan windows it carries, as Claude Code writes them', () => {
  // As logged by Claude Code: an event carries only some windows.
  const info = {
    status: 'allowed_warning', resetsAt: 1794186000, rateLimitType: 'seven_day', utilization: 0.95,
    unifiedWindows: { seven_day: { utilization: 0.95, resetsAt: 1794186000, status: 'allowed_warning', surpassedThreshold: 0.75 } },
  }
  assert.deepEqual(planWindowsOfRateLimit(info), [{ windowMinutes: 10_080, usedFraction: 0.95, resetsAt: 1_794_186_000_000, status: 'allowed_warning' }])
  const both = { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1794000000, status: 'allowed' }, seven_day_opus: { utilization: 0.1, resetsAt: 1794000000, status: 'allowed' } } }
  assert.deepEqual(planWindowsOfRateLimit(both), [{ windowMinutes: 300, usedFraction: 0.4, resetsAt: 1_794_000_000_000, status: 'allowed' }], 'windows of other names are left out')
  assert.deepEqual(planWindowsOfRateLimit({ status: 'allowed' }), [])
})

// Stands in for `claude -p` in stream-json: the first message starts a turn and is echoed at once; one written during the
// turn is echoed only when the turn reaches its next boundary, which a message reading "boundary" stands for.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const waiting = []
let inTurn = []
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.message.content === 'boundary') {
    for (const next of waiting.splice(0)) { out({ type: 'user', uuid: next.uuid, isReplay: true, message: next.message }); inTurn.push(next.uuid) }
    out({ type: 'result', is_error: false, user_message_uuids: inTurn, total_cost_usd: 0.01 })
    inTurn = []
  } else if (inTurn.length === 0) {
    out({ type: 'user', uuid: message.uuid, isReplay: true, message: message.message })
    out({ type: 'user', uuid: 'not-one-of-ours', isReplay: true, message: message.message })
    inTurn.push(message.uuid)
  } else {
    waiting.push(message)
  }
})
`

test('a message counts as taken in when Claude Code echoes it into the conversation, not when it is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-fake-claude-'))
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, FAKE_CLAUDE)
    chmodSync(bin, 0o755)
    const events: ProviderEvent[] = []
    let notify = () => {}
    const session = startClaudeSession(
      { model: 'm', folder: dir, resumeProviderSessionId: null, systemPrompt: '', env: { PATH: process.env.PATH ?? '', OURO_CLAUDE_BIN: bin }, stateDir: dir, memoryDir: null, promptCacheTtlMs: null },
      (event) => { events.push(event); notify() },
    )
    const until = (what: (event: ProviderEvent) => boolean) => new Promise<void>((resolve) => {
      notify = () => { if (events.some(what)) resolve() }
      notify()
    })
    const delivery = (attemptId: string) => ({ attemptId, from: 'alice', text: attemptId, modelContent: attemptId })
    const takenIn = () => events.flatMap((event) => (event.type === 'taken_in' ? event.attemptIds : []))

    session.deliver(delivery('a1'))
    await until((event) => event.type === 'taken_in')
    session.deliver(delivery('a2'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(takenIn(), ['a1'], 'written mid-turn, but not taken in yet; an echo of something else is ignored')

    session.deliver(delivery('boundary'))
    await until((event) => event.type === 'turn_result')
    assert.deepEqual(takenIn(), ['a1', 'a2'])
    session.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const REFUSAL = "API Error: Opus 5.5's safeguards flagged this message as a potential violation of our usage policy. [reasoning_extraction]"

/** A fake claude that answers its first message with the refusal as the assistant's text, then `ending`. */
async function refusedTurn(ending: 'generic_error_result' | 'exit_without_result'): Promise<ProviderEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-fake-claude-'))
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', () => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: ${JSON.stringify(REFUSAL)} }] } })
  if (${JSON.stringify(ending)} === 'generic_error_result') out({ type: 'result', subtype: 'success', is_error: true, result: 'Execution error' })
  else process.exit(1)
})
`)
    chmodSync(bin, 0o755)
    const events: ProviderEvent[] = []
    let notify = () => {}
    const session = startClaudeSession(
      { model: 'm', folder: dir, resumeProviderSessionId: null, systemPrompt: '', env: { PATH: process.env.PATH ?? '', OURO_CLAUDE_BIN: bin }, stateDir: dir, memoryDir: null, promptCacheTtlMs: null },
      (event) => { events.push(event); notify() },
    )
    await new Promise<void>((resolve) => {
      notify = () => { if (events.some((event) => event.type === 'turn_failed')) resolve() }
      session.deliver({ attemptId: 'a1', from: 'alice', text: 'hi', modelContent: 'hi' })
    })
    session.stop()
    return events
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a refusal written as the assistant's text is a refusal, whatever the result says, or if claude exits before one", async () => {
  for (const ending of ['generic_error_result', 'exit_without_result'] as const) {
    const failed = (await refusedTurn(ending)).find((event) => event.type === 'turn_failed')
    assert.equal(failed?.type === 'turn_failed' && failed.failure, 'model_refused', ending)
    assert.match(failed?.type === 'turn_failed' ? failed.detail : '', /safeguards flagged/)
  }
})

test("another provider's policy refusal reads as a refusal too", () => {
  assert.equal(classifyClaudeFailure('Invalid prompt: your prompt was flagged as potentially violating our usage policy.'), 'model_refused')
})
