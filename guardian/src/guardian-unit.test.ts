import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { evaluateBudget, RestartBudget } from './budget.ts'
import { followingRequested, FollowRefused, followStep } from './follow.ts'
import { chatsToSample, compareHistoryPage } from './probe.ts'
import { schemaRefusal } from './schema-gate.ts'
import { judgeFailedCheck } from './watchdog.ts'
import { holdingHostAwake, hostHoldSocket } from './host-hold.ts'
import { DEFAULT_LISTEN_HOST, loadConfig } from './config.ts'
import { startProxy } from './proxy.ts'
import { createServer } from 'node:http'

const dir = mkdtempSync(join(tmpdir(), 'guardian-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const limits = { perFifteenMinutes: 1, perHour: 3 }
const MINUTE = 60_000

test('the budget allows one restart per fifteen minutes and three per hour', () => {
  const now = 100 * 60 * MINUTE
  assert.equal(evaluateBudget([], now, limits).allowed, true)
  assert.equal(evaluateBudget([now - 5 * MINUTE], now, limits).allowed, false)
  assert.equal(evaluateBudget([now - 16 * MINUTE], now, limits).allowed, true)
  assert.equal(evaluateBudget([now - 50 * MINUTE, now - 35 * MINUTE, now - 16 * MINUTE], now, limits).allowed, false)
  assert.equal(evaluateBudget([now - 70 * MINUTE, now - 35 * MINUTE, now - 16 * MINUTE], now, limits).allowed, true)
})

test('spending is durable across instances', () => {
  const path = join(dir, 'budget-durable.json')
  const now = 1_000_000_000
  assert.equal(new RestartBudget(path, limits).trySpend(now).allowed, true)
  assert.equal(new RestartBudget(path, limits).trySpend(now + MINUTE).allowed, false)
  assert.equal(new RestartBudget(path, limits).trySpend(now + 16 * MINUTE).allowed, true)
})

test('an unreadable budget blocks action rather than allowing it', () => {
  const path = join(dir, 'budget-garbled.json')
  writeFileSync(path, 'not json')
  const answer = new RestartBudget(path, limits).trySpend(1)
  assert.equal(answer.allowed, false)
  assert.match(answer.allowed ? '' : answer.why, /unreadable/)
})

test('an older page must still show everything it showed', () => {
  const anchor = { chatId: 'c', before: 100, messageIds: ['a', 'b', 'c'] }
  assert.equal(compareHistoryPage(anchor, ['a', 'b', 'c']), null)
  assert.match(compareHistoryPage(anchor, ['a', 'c'])!, /lost 1 of 3/)
  assert.match(compareHistoryPage(anchor, [])!, /lost 3 of 3/)
})

test('the newest page can move on, but not lose everything', () => {
  const anchor = { chatId: 'c', before: null, messageIds: ['a', 'b'] }
  assert.equal(compareHistoryPage(anchor, ['b', 'x', 'y']), null)
  assert.equal(compareHistoryPage(anchor, ['x', 'y', 'z']), null)
  assert.match(compareHistoryPage(anchor, [])!, /no messages at all/)
  assert.equal(compareHistoryPage({ chatId: 'c', before: null, messageIds: [] }, []), null)
})

test('a release too old for the data is refused, and a fresh machine accepts anything', () => {
  assert.equal(schemaRefusal(null, { schemaVersion: 1, dataReadableBySchemaFrom: 1 }), null)
  assert.equal(schemaRefusal({ version: 5, readableBySchemaFrom: 3 }, { schemaVersion: 4, dataReadableBySchemaFrom: 3 }), null)
  assert.match(schemaRefusal({ version: 5, readableBySchemaFrom: 3 }, { schemaVersion: 2, dataReadableBySchemaFrom: 2 })!, /schema 3/)
})

test('the runner host starts only runners from the releases it serves', async () => {
  const { validateSpawnRequest, SpawnRefused } = await import('./runner-host.ts')
  const roots = ['/home/p/ouro-next/home/releases']
  const ok = { entry: '/home/p/ouro-next/home/releases/r1/server/src/bin/ouro-runner.ts', configPath: '/x/runner-1.json', logPath: '/x/runner.log', env: {} }
  assert.equal(validateSpawnRequest(ok, roots).entry, ok.entry)
  assert.throws(() => validateSpawnRequest({ ...ok, entry: '/bin/sh' }, roots), SpawnRefused)
  assert.throws(() => validateSpawnRequest({ ...ok, entry: '/tmp/evil/server/src/bin/ouro-runner.ts' }, roots), SpawnRefused)
  assert.throws(() => validateSpawnRequest({ ...ok, entry: '/home/p/ouro-next/home/releases/../../x/server/src/bin/ouro-runner.ts' }, roots), SpawnRefused)
  assert.throws(() => validateSpawnRequest({ ...ok, configPath: 'relative.json' }, roots), SpawnRefused)
})

test('a failed check is "starting" during the grace, and an outage counts only from the end of it', () => {
  const timing = { coldStartGraceMs: 60_000, sustainedOutageMs: 3 * MINUTE }
  const started = { startedAt: 0, lastHealthyAt: null }
  assert.deepEqual(judgeFailedCheck(started, 59_000, timing), { kind: 'starting' })
  // A slow start: never healthy, judged from the end of the grace, not from the start.
  assert.deepEqual(judgeFailedCheck(started, 60_000 + 2 * MINUTE, timing), { kind: 'outage', outageMs: 2 * MINUTE })
  assert.deepEqual(judgeFailedCheck(started, 60_000 + 3 * MINUTE, timing), { kind: 'sustained_outage', outageMs: 3 * MINUTE })
  // A server that was healthy and then stopped answering: from its last good answer.
  const wasHealthy = { startedAt: 0, lastHealthyAt: 10 * MINUTE }
  assert.deepEqual(judgeFailedCheck(wasHealthy, 12 * MINUTE, timing), { kind: 'outage', outageMs: 2 * MINUTE })
  assert.deepEqual(judgeFailedCheck(wasHealthy, 13 * MINUTE, timing), { kind: 'sustained_outage', outageMs: 3 * MINUTE })
})

test('a followed head is deployed unless it runs already or failed here', () => {
  const retry = 30 * MINUTE
  assert.deepEqual(followStep('b', 'b', null, 0, retry), { kind: 'up_to_date' })
  assert.deepEqual(followStep('b', 'a', null, 0, retry), { kind: 'deploy' })
  assert.deepEqual(followStep('b', 'a', { phase: 'superseded', endedAt: 0, startedTooSlowly: false }, 0, retry), { kind: 'deploy' })
  assert.deepEqual(followStep('b', 'a', { phase: 'live', endedAt: 0, startedTooSlowly: false }, 0, retry), { kind: 'deploy' }, 'replaced since by a deploy by hand')
  for (const phase of ['build_failed', 'verification_failed', 'refused', 'rolled_back', 'rollback_unverified'] as const) {
    assert.deepEqual(followStep('b', 'a', { phase, endedAt: 0, startedTooSlowly: false }, 10 * retry, retry), { kind: 'failed_before', phase })
  }
})

test('a followed head that only started too slowly is tried again once its wait is over', () => {
  const retry = 30 * MINUTE
  const slow = { phase: 'rolled_back', endedAt: 1_000, startedTooSlowly: true } as const
  assert.deepEqual(followStep('b', 'a', slow, 1_000 + retry - 1, retry), { kind: 'slow_before', retryAt: 1_000 + retry })
  assert.deepEqual(followStep('b', 'a', slow, 1_000 + retry, retry), { kind: 'deploy' })
})

test('following needs both a remote and a branch; neither stops it', () => {
  assert.deepEqual(followingRequested('origin', 'main'), { remote: 'origin', branch: 'main' })
  assert.equal(followingRequested(null, undefined), null)
  assert.throws(() => followingRequested('origin', null), FollowRefused)
})

test('the baseline reads the four most recently active chats and the two quietest, each once', () => {
  const chat = (id: string, seq: number | null) => ({ id, latestMessage: seq === null ? null : { seq } })
  const chats = [chat('c', 30), chat('empty', null), chat('a', 10), chat('g', 70), chat('e', 50), chat('b', 20), chat('f', 60), chat('d', 40), chat('h', 80)]
  assert.deepEqual(chatsToSample(chats), ['h', 'g', 'f', 'e', 'b', 'a'])
  assert.deepEqual(chatsToSample([...chats].reverse()), ['h', 'g', 'f', 'e', 'b', 'a'], 'the order chats come in changes nothing')
  assert.deepEqual(chatsToSample([chat('x', 2), chat('y', 1), chat('z', 3)]), ['z', 'x', 'y'], 'few chats: each once')
})

test('a deploy holds a Sprite awake from start to end, through its Tasks API, and lets go even when it fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-hold-'))
  const socketPath = join(dir, 'api.sock')
  const calls: string[] = []
  const api = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    request.resume()
    request.on('end', () => response.writeHead(request.method === 'PUT' ? 200 : 204).end())
  })
  await new Promise<void>((done) => api.listen(socketPath, done))
  try {
    assert.equal(await holdingHostAwake(socketPath, 'ouro-guardian-deploy', async () => {
      assert.deepEqual(calls, ['PUT /v1/tasks/ouro-guardian-deploy'], 'held before the work')
      return 'deployed'
    }), 'deployed')
    assert.deepEqual(calls, ['PUT /v1/tasks/ouro-guardian-deploy', 'DELETE /v1/tasks/ouro-guardian-deploy'])
    await assert.rejects(holdingHostAwake(socketPath, 'ouro-guardian-deploy', async () => { throw new Error('build failed') }))
    assert.equal(calls.at(-1), 'DELETE /v1/tasks/ouro-guardian-deploy')
  } finally {
    api.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(hostHoldSocket({ OURO_HOST_HOLD: 'none' }), null)
  assert.equal(hostHoldSocket({ OURO_HOST_HOLD: 'sprite', OURO_SPRITE_API_SOCKET: '/x.sock' }), '/x.sock')
  assert.equal(await holdingHostAwake(null, 'ouro-guardian-deploy', async () => 1), 1, 'no Sprite: just the work')
})

test('the listening port binds everywhere unless the configuration names an address, as a server behind its own proxy does', async () => {
  const path = join(dir, 'guardian-listen.json')
  writeFileSync(path, JSON.stringify({ home: dir, listenPort: 8080, sourceDir: dir }))
  assert.equal(loadConfig(path).listenHost, DEFAULT_LISTEN_HOST)
  writeFileSync(path, JSON.stringify({ home: dir, listenPort: 8080, sourceDir: dir, listenHost: '127.0.0.1' }))
  assert.equal(loadConfig(path).listenHost, '127.0.0.1')

  const server = await new Promise<ReturnType<typeof startProxy>>((resolve) => {
    const started = startProxy({ host: '127.0.0.1', port: 0, upstreamSocket: join(dir, 'no-such.sock'), onListening: () => resolve(started) })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  assert.equal(address.address, '127.0.0.1')
  await new Promise((resolve) => server.close(resolve))
})
