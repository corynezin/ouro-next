import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { classifyCodexFailure, startCodexSession } from './codex-provider.ts'
import type { ProviderEvent, ProviderSession } from './provider.ts'

let dir: string
let fakeCodex: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ouro-codex-'))
  fakeCodex = join(dir, 'codex')
  writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${resolve(import.meta.dirname, '../../../journeys/fake-codex.ts')}" "$@"\n`)
  chmodSync(fakeCodex, 0o755)
})
after(() => rmSync(dir, { recursive: true, force: true }))

const sessions: ProviderSession[] = []
after(() => { for (const session of sessions) session.stop() })

function start(options: { resume?: string; env?: Record<string, string> } = {}) {
  const events: ProviderEvent[] = []
  const waiters: { until: (event: ProviderEvent) => boolean; resolve: () => void }[] = []
  const session = startCodexSession({
    model: 'gpt-6-luna',
    folder: dir,
    resumeProviderSessionId: options.resume ?? null,
    systemPrompt: 'You are an agent.',
    env: { PATH: process.env.PATH ?? '', OURO_CODEX_BIN: fakeCodex, FAKE_CODEX_RECORD: join(dir, 'threads.jsonl'), ...options.env },
    stateDir: dir,
    memoryDir: null,
    promptCacheTtlMs: null,
  }, (event) => {
    events.push(event)
    for (const waiter of waiters.filter((candidate) => candidate.until(event))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  })
  sessions.push(session)
  const next = (type: ProviderEvent['type']) => new Promise<void>((resolveWait) => {
    if (events.some((event) => event.type === type)) return resolveWait()
    waiters.push({ until: (event) => event.type === type, resolve: resolveWait })
  })
  return { session, events, next }
}

const delivery = (attemptId: string, text: string) => ({ attemptId, from: 'human', text, modelContent: text })

test('failures are classified by what Codex says, a 401 being signed out', () => {
  assert.equal(classifyCodexFailure('unauthorized'), 'logged_out')
  assert.equal(classifyCodexFailure({ responseStreamDisconnected: { httpStatusCode: 401 } }), 'logged_out')
  assert.equal(classifyCodexFailure('usageLimitExceeded'), 'usage_limit')
  assert.equal(classifyCodexFailure({ httpConnectionFailed: { httpStatusCode: 502 } }), 'transient')
  assert.equal(classifyCodexFailure(undefined), 'transient')
})

test('a message starts a turn, one arriving mid-turn joins it, each is taken in as Codex accepts it, and the turn acknowledges both', async () => {
  const { session, events, next } = start()
  session.deliver(delivery('a1', 'first'))
  await next('session_identified')
  session.deliver(delivery('a2', 'second'))
  await next('turn_result')
  const result = events.find((event) => event.type === 'turn_result')
  assert.deepEqual(result, { type: 'turn_result', acknowledgedAttemptIds: ['a1', 'a2'], costUsd: 0, context: null })
  const takenIn = events.flatMap((event, index) => event.type === 'taken_in' ? [{ attemptIds: event.attemptIds, index }] : [])
  assert.deepEqual(takenIn.map((event) => event.attemptIds), [['a1'], ['a2']], 'the first at turn/start, the second at turn/steer')
  assert.ok(takenIn.every((event) => event.index < events.indexOf(result!)), 'before the turn ends')
  assert.ok(events.some((event) => event.type === 'text' && event.text === 'fake codex heard: first | second'))
  assert.ok(events.some((event) => event.type === 'tool_use' && event.toolName === 'Bash'))
  assert.ok(events.some((event) => event.type === 'thinking'))
  const opened = readFileSync(join(dir, 'threads.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, string> })
  const thread = opened.at(-1)!
  assert.equal(thread.method, 'thread/start')
  assert.equal(thread.params.model, 'gpt-6-luna')
  assert.equal(thread.params.approvalPolicy, 'never')
  assert.match(thread.params.developerInstructions!, /^You are an agent\.\n\nYou run on OpenAI Codex/)
})

test('a resumed thread is named at once; compaction finishes as compaction', async () => {
  const { session, events, next } = start({ resume: 'thread-earlier' })
  await next('session_identified')
  assert.deepEqual(events[0], { type: 'session_identified', providerSessionId: 'thread-earlier' })
  session.compact('keep the plan')
  await next('compaction_finished')
  assert.ok(!events.some((event) => event.type === 'turn_result'))
})

test('a turn refused for want of a sign-in fails as signed out', async () => {
  const marker = join(dir, 'unauthorized')
  writeFileSync(marker, '')
  const { session, events, next } = start({ env: { FAKE_CODEX_UNAUTHORIZED: marker } })
  session.deliver(delivery('b1', 'hello'))
  await next('turn_failed')
  const failed = events.find((event) => event.type === 'turn_failed')
  assert.equal(failed?.type === 'turn_failed' && failed.failure, 'logged_out')
})

test('stopping ends the app-server, and the session says it exited', async () => {
  const { session, next } = start()
  session.stop()
  await next('exited')
})
