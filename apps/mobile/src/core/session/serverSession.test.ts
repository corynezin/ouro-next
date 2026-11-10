import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WATCH_LEASE_MS } from '@ouro/contract'
import type { IntegrationEntity } from '@ouro/contract'
import { deferred, FakeClock, FakeIds, FakeLifecycle, FakeNetwork, MemoryDurableStore, settle } from '../platform/fakes.ts'
import {
  agentOf, agentUpsert, caughtUpFrame, directChatOf, messageOf, messageUpsert, readStateOf, snapshotOf,
} from '../testSupport.ts'
import { ServerDrafts } from './drafts.ts'
import { outboxEntriesNotYetListed, ServerOutbox } from './outbox.ts'
import { failureText, ServerApi, STOP_ATTEMPTS } from './serverApi.ts'
import type { ApiFailure } from './serverApi.ts'
import { PLAN_USAGE_REFRESH_MS, ServerSession, WATCH_BEAT_MS } from './serverSession.ts'

const SERVER_URL = 'https://a.test'

function setup(initial = snapshotOf()) {
  const network = new FakeNetwork()
  const clock = new FakeClock()
  const lifecycle = new FakeLifecycle()
  const ids = new FakeIds()
  const store = new MemoryDurableStore()
  network.routeJson('GET', '/v2/snapshot', initial)
  const deps = { network, clock, lifecycle, ids }
  const outboxLifetime = new AbortController()
  const makeOutbox = () => new ServerOutbox({ store, clock, ids, api: new ServerApi(deps, { url: SERVER_URL, token: 't' }, outboxLifetime.signal) }, 's1')
  const outbox = makeOutbox()
  const session = new ServerSession(deps, 's1', { url: SERVER_URL, token: 't' }, { outbox, drafts: new ServerDrafts(store, 's1') })
  return { network, clock, lifecycle, ids, store, deps, outbox, makeOutbox, session }
}

async function connected(ctx: ReturnType<typeof setup>) {
  ctx.session.start()
  await settle()
  ctx.network.lastStream.pushFrame(caughtUpFrame(ctx.session.store.cursor))
  await settle()
}

const historyOf = (messages: object[], hasOlder = false) => ({ messages, hasOlder })

test('status stays connecting until the stream says it caught up, and only then claims live', async () => {
  const ctx = setup()
  ctx.session.start()
  await settle()
  assert.equal(ctx.session.connection.phase, 'connecting')
  ctx.network.lastStream.pushFrame(caughtUpFrame(0))
  await settle()
  assert.equal(ctx.session.connection.phase, 'live')
  assert.equal(ctx.session.connection.downSince, null)
  ctx.session.dispose()
})

test('a snapshot fills the store and the stream opens from its epoch and cursor', async () => {
  const ctx = setup(snapshotOf({ epoch: 'e7', cursor: 42, agents: [agentOf({ id: 'a1', name: 'alice' })] }))
  ctx.session.start()
  await settle()
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'alice')
  const streamUrl = ctx.network.requests.find((r) => r.url.includes('/v2/changes'))!.url
  assert.match(streamUrl, /epoch=e7&after=42/)
  ctx.session.dispose()
})

test('after a drop it reconnects from where it was, without a new snapshot, and a replay applies once', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  const agent = agentOf({ id: 'a1', name: 'alice' })
  ctx.network.lastStream.pushFrame(agentUpsert(6, agent))
  await settle()
  ctx.network.lastStream.drop()
  await settle()
  assert.equal(ctx.session.connection.phase, 'offline')
  assert.equal(ctx.session.connection.detail, 'connection lost')

  await ctx.clock.advance(1999)
  assert.equal(ctx.network.streams.length, 1)
  await ctx.clock.advance(1)
  assert.equal(ctx.network.streams.length, 2)
  assert.match(ctx.network.requests.at(-1)!.url, /after=6/)
  assert.equal(ctx.network.requests.filter((r) => r.url.includes('/v2/snapshot')).length, 1)

  // The server replays one we already have: it must change nothing.
  ctx.network.lastStream.pushFrame(agentUpsert(6, { ...agent, name: 'replayed' }))
  await settle()
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'alice')
  assert.equal(ctx.session.store.cursor, 6)
  ctx.network.lastStream.pushFrame(agentUpsert(7, { ...agent, name: 'current' }))
  await settle()
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'current')
  assert.equal(ctx.session.store.cursor, 7)
  ctx.session.dispose()
})

test('downSince stays at the first failure across retries, so the offline banner cannot blink', async () => {
  const ctx = setup()
  await connected(ctx)
  ctx.network.lastStream.drop()
  await settle()
  const downSince = ctx.session.connection.downSince
  ctx.network.streamFailure = new Error('still down')
  await ctx.clock.advance(2000)
  await ctx.clock.advance(2000)
  assert.equal(ctx.session.connection.phase, 'offline')
  assert.equal(ctx.session.connection.downSince, downSince)
  ctx.session.dispose()
})

test('coming to the foreground retries at once', async () => {
  const ctx = setup()
  await connected(ctx)
  ctx.network.lastStream.drop()
  await settle()
  const before = ctx.network.streams.length
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.network.streams.length, before + 1)
  ctx.session.dispose()
})

test('a 401 on the stream means unpaired and stops retrying', async () => {
  const ctx = setup()
  ctx.network.streamStatus = 401
  ctx.session.start()
  await settle()
  assert.equal(ctx.session.connection.phase, 'unpaired')
  const requests = ctx.network.requests.length
  await ctx.clock.advance(60_000)
  assert.equal(ctx.network.requests.length, requests)
  ctx.session.dispose()
})

test('a 401 on the snapshot means unpaired too', async () => {
  const ctx = setup()
  ctx.network.routeJson('GET', '/v2/snapshot', { error: 'nope' }, 401)
  ctx.session.start()
  await settle()
  assert.equal(ctx.session.connection.phase, 'unpaired')
  ctx.session.dispose()
})

test('a new epoch takes a new snapshot and discards history that no longer applies', async () => {
  const chat = directChatOf('c1', 'alice')
  const ctx = setup(snapshotOf({ epoch: 'e1', chats: [chat] }))
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([messageOf({ seq: 1, chatId: 'c1' })]))
  await connected(ctx)
  const close = ctx.session.openChat('c1')
  await settle()
  assert.equal(ctx.session.store.timeline('c1')?.messages.length, 1)

  ctx.network.routeJson('GET', '/v2/snapshot', snapshotOf({ epoch: 'e2', cursor: 3, chats: [chat] }))
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([messageOf({ seq: 2, chatId: 'c1' })]))
  ctx.network.lastStream.pushFrame({ frame: 'resync_required', epoch: 'e2' })
  await settle()
  assert.equal(ctx.session.store.epoch, 'e2')
  ctx.network.lastStream.pushFrame(caughtUpFrame(3))
  await settle()
  assert.deepEqual(ctx.session.store.timeline('c1')?.messages.map((m) => m.seq), [2])
  close()
  ctx.session.dispose()
})

test('a dropped connection keeps the data on screen', async () => {
  const ctx = setup(snapshotOf({ agents: [agentOf({ id: 'a1', name: 'alice' })] }))
  await connected(ctx)
  ctx.network.lastStream.drop()
  await settle()
  assert.equal(ctx.session.store.agents.size, 1)
  ctx.session.dispose()
})

test('after dispose nothing lands: a slow snapshot, a slow page, and no more retries', async () => {
  const ctx = setup()
  const slowSnapshot = deferred<{ status: number; text: string }>()
  ctx.network.route('GET', '/v2/snapshot', () => slowSnapshot.promise)
  ctx.session.start()
  await settle()
  ctx.session.dispose()
  slowSnapshot.resolve({ status: 200, text: JSON.stringify(snapshotOf({ agents: [agentOf({ id: 'late', name: 'late' })] })) })
  await settle()
  assert.equal(ctx.session.store.agents.size, 0)
  const requests = ctx.network.requests.length
  await ctx.clock.advance(60_000)
  assert.equal(ctx.network.requests.length, requests)
})

test('a stream that simply ends is a disconnect: the half-sent last frame is not applied, and the server resends it', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  const agent = agentOf({ id: 'a1', name: 'alice' })
  ctx.network.lastStream.pushFrame(agentUpsert(6, agent))
  const lostFrame = `data: ${JSON.stringify(agentUpsert(7, { ...agent, name: 'lost' }))}`
  ctx.network.lastStream.push(lostFrame.slice(0, lostFrame.length - 5))
  await settle()
  assert.equal(ctx.session.connection.phase, 'live')

  // No error, as expo/fetch reports a lost connection: read() just returns done.
  ctx.network.lastStream.end()
  await settle()
  assert.equal(ctx.session.connection.phase, 'offline', 'an end must not keep claiming live')
  assert.equal(ctx.session.connection.detail, 'the connection ended')
  assert.equal(ctx.session.store.cursor, 6)
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'alice')

  await ctx.clock.advance(2000)
  assert.equal(ctx.network.streams.length, 2)
  assert.match(ctx.network.requests.at(-1)!.url, /after=6/)
  assert.equal(ctx.network.requests.filter((r) => r.url.includes('/v2/snapshot')).length, 1)

  ctx.network.lastStream.pushFrame(agentUpsert(7, { ...agent, name: 'resent' }))
  ctx.network.lastStream.pushFrame(caughtUpFrame(7))
  await settle()
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'resent')
  assert.equal(ctx.session.connection.phase, 'live')
  ctx.session.dispose()
})

test('it keeps reconnecting however many times the stream ends', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  for (const expectedStreams of [2, 3, 4]) {
    ctx.network.lastStream.end()
    await settle()
    await ctx.clock.advance(2000)
    assert.equal(ctx.network.streams.length, expectedStreams)
    assert.match(ctx.network.requests.at(-1)!.url, /after=5/)
  }
  ctx.session.dispose()
})

// FakeStream closes only on its signal, like expo/fetch: leaving the read loop or cancelling the reader closes nothing.
const streamSignals = (ctx: ReturnType<typeof setup>) => ctx.network.requests.filter((r) => r.url.includes('/v2/changes')).map((r) => r.signal)

const waysAStreamFinishes: { name: string; finish: (ctx: ReturnType<typeof setup>) => void }[] = [
  { name: 'it ends', finish: (ctx) => ctx.network.lastStream.end() },
  { name: 'it fails', finish: (ctx) => ctx.network.lastStream.drop() },
  { name: 'the server requires a resync', finish: (ctx) => ctx.network.lastStream.pushFrame({ frame: 'resync_required', epoch: 'e2' }) },
  { name: 'a frame is invalid', finish: (ctx) => ctx.network.lastStream.push('data: {"frame":"nonsense"}\n\n') },
  { name: 'the session is disposed', finish: (ctx) => ctx.session.dispose() },
]

for (const { name, finish } of waysAStreamFinishes) {
  test(`the fetch is aborted when ${name}, because nothing else closes the connection`, async () => {
    const ctx = setup()
    await connected(ctx)
    const [signal] = streamSignals(ctx)
    assert.equal(signal!.aborted, false)
    finish(ctx)
    await settle()
    assert.equal(signal!.aborted, true)
    ctx.session.dispose()
  })
}

for (const status of [401, 500]) {
  test(`the fetch is aborted when the stream answers ${status}`, async () => {
    const ctx = setup()
    ctx.network.streamStatus = status
    ctx.session.start()
    await settle()
    assert.equal(streamSignals(ctx)[0]!.aborted, true)
    ctx.session.dispose()
  })
}

test('after many reconnects and a dispose, no stream is left open', async () => {
  const ctx = setup()
  await connected(ctx)
  for (let round = 0; round < 3; round++) {
    ctx.network.lastStream.end()
    await settle()
    await ctx.clock.advance(2000)
  }
  ctx.session.dispose()
  await settle()
  const signals = streamSignals(ctx)
  assert.equal(signals.length, 4)
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true, true, true])
})

test('a connection that dies silently stops claiming live and reconnects from its cursor', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  const [signal] = streamSignals(ctx)
  await ctx.clock.advance(39_999)
  assert.equal(ctx.session.connection.phase, 'live')
  await ctx.clock.advance(1)
  assert.equal(ctx.session.connection.phase, 'offline')
  assert.equal(ctx.session.connection.detail, 'nothing heard from the server')
  assert.equal(signal!.aborted, true)
  await ctx.clock.advance(2000)
  assert.equal(ctx.network.streams.length, 2)
  assert.match(ctx.network.requests.at(-1)!.url, /after=5/)
  ctx.session.dispose()
})

test('a heartbeat keeps a quiet stream live', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  for (let beat = 0; beat < 10; beat++) {
    await ctx.clock.advance(15_000)
    ctx.network.lastStream.push(': heartbeat\n\n')
    await settle()
  }
  assert.equal(ctx.session.connection.phase, 'live')
  assert.equal(ctx.network.streams.length, 1)
  ctx.session.dispose()
})

test('a late frame from a stream given up on changes nothing', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  const lateChunk = deferred<string>()
  // A read that stays pending through the abort and then delivers anyway, which FakeStream can't do.
  ctx.network.openStream = async (request) => {
    ctx.network.requests.push(request)
    return { status: 200, chunks: (async function* () { yield await lateChunk.promise })() }
  }
  ctx.session.start()
  await settle()
  await ctx.clock.advance(40_000)
  assert.equal(ctx.session.connection.phase, 'offline')
  lateChunk.resolve(`data: ${JSON.stringify(agentUpsert(6, agentOf({ id: 'a1', name: 'alice' })))}\n\n`)
  await settle()
  assert.equal(ctx.session.store.cursor, 5)
  assert.equal(ctx.session.store.agents.get('a1'), undefined)
  ctx.session.dispose()
})

test('back in the foreground, one missed heartbeat is enough to reconnect at once', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  await ctx.clock.advance(19_999)
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.session.connection.phase, 'live', 'a stream heard from recently is left alone')
  assert.equal(ctx.network.streams.length, 1)

  await ctx.clock.advance(1)
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.session.connection.phase, 'offline')
  await ctx.clock.advance(2000)
  assert.equal(ctx.network.streams.length, 2)
  assert.match(ctx.network.requests.at(-1)!.url, /after=5/)
  ctx.session.dispose()
})

test('a stream that never answers is given up on too', async () => {
  const ctx = setup()
  const never = new Promise<never>(() => {})
  ctx.network.openStream = async () => never
  ctx.session.start()
  await settle()
  assert.equal(ctx.session.connection.phase, 'connecting')
  await ctx.clock.advance(40_000)
  assert.equal(ctx.session.connection.phase, 'offline')
  ctx.session.dispose()
})

test('dispose does not depend on a pending read settling', async () => {
  const ctx = setup()
  ctx.network.openStream = async (request) => {
    ctx.network.requests.push(request)
    return { status: 200, chunks: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } }
  }
  ctx.session.start()
  await settle()
  const [signal] = streamSignals(ctx)
  ctx.session.dispose()
  await settle()
  assert.equal(signal!.aborted, true)
})

test('refresh replaces the store from a new snapshot and follows on from its cursor, closing the old stream', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  const [firstSignal] = streamSignals(ctx)
  ctx.network.routeJson('GET', '/v2/snapshot', snapshotOf({ cursor: 9, agents: [agentOf({ id: 'a1', name: 'alice' })] }))
  let finished = false
  void ctx.session.refresh().then(() => { finished = true })
  await settle()
  assert.equal(firstSignal!.aborted, true)
  assert.equal(ctx.session.store.agents.get('a1')?.name, 'alice')
  assert.match(ctx.network.requests.at(-1)!.url, /after=9/)
  assert.equal(finished, false, 'still spinning until it is live again')
  ctx.network.lastStream.pushFrame(caughtUpFrame(9))
  await settle()
  assert.equal(finished, true)
  assert.equal(ctx.session.connection.phase, 'live')
  ctx.session.dispose()
})

test('refresh while offline tries at once, and settles when that fails too', async () => {
  const ctx = setup(snapshotOf({ cursor: 5 }))
  await connected(ctx)
  ctx.network.lastStream.drop()
  await settle()
  ctx.network.route('GET', '/v2/snapshot', () => { throw new Error('no route') })
  let finished = false
  const before = ctx.network.requests.length
  void ctx.session.refresh().then(() => { finished = true })
  await settle()
  assert.equal(ctx.network.requests.length, before + 1)
  assert.equal(finished, true)
  assert.equal(ctx.session.connection.phase, 'offline')
  ctx.session.dispose()
})

test('a refresh in progress settles on dispose', async () => {
  const ctx = setup()
  await connected(ctx)
  const answer = deferred<never>()
  ctx.network.route('GET', '/v2/snapshot', () => answer.promise)
  let finished = false
  void ctx.session.refresh().then(() => { finished = true })
  await settle()
  ctx.session.dispose()
  await settle()
  assert.equal(finished, true)
})

test('dispose aborts the live stream', async () => {
  const ctx = setup()
  await connected(ctx)
  const signal = ctx.network.requests.find((r) => r.url.includes('/v2/changes'))!.signal
  ctx.session.dispose()
  assert.equal(signal.aborted, true)
})

test('a change to a chat nobody has opened is not kept; opening loads it', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  await connected(ctx)
  ctx.network.lastStream.pushFrame(messageUpsert(1, messageOf({ seq: 1, chatId: 'c1' })))
  await settle()
  assert.equal(ctx.session.store.timeline('c1'), undefined)
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([messageOf({ seq: 1, chatId: 'c1' })]))
  ctx.network.routeJson('POST', 'mark_chat_read', { readState: readStateOf('c1', 1) })
  const close = ctx.session.openChat('c1')
  await settle()
  assert.deepEqual(ctx.session.store.timeline('c1')?.messages.map((m) => m.seq), [1])
  close()
  ctx.session.dispose()
})

test('older pages merge in order, and paging stops when there is nothing older', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  ctx.network.routeJson('POST', 'mark_chat_read', { readState: readStateOf('c1', 9) })
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([messageOf({ seq: 8, chatId: 'c1' }), messageOf({ seq: 9, chatId: 'c1' })], true))
  await connected(ctx)
  const close = ctx.session.openChat('c1')
  await settle()
  ctx.network.routeJson('GET', 'before=8', historyOf([messageOf({ seq: 7, chatId: 'c1' })], false))
  await ctx.session.loadOlder('c1')
  const timeline = ctx.session.store.timeline('c1')!
  assert.deepEqual(timeline.messages.map((m) => m.seq), [7, 8, 9])
  assert.equal(timeline.hasOlder, false)
  const requests = ctx.network.requests.length
  await ctx.session.loadOlder('c1')
  assert.equal(ctx.network.requests.length, requests)
  close()
  ctx.session.dispose()
})

test('concurrent loads of the same chat make one request', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([], false))
  await connected(ctx)
  await Promise.all([ctx.session.loadLatest('c1'), ctx.session.loadLatest('c1')])
  assert.equal(ctx.network.requests.filter((r) => r.url.includes('/messages')).length, 1)
  ctx.session.dispose()
})

test('a page failure is reported, not thrown, and leaves what was loaded', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  await connected(ctx)
  const result = await ctx.session.loadLatest('c1')
  assert.equal(result.ok, false)
  ctx.session.dispose()
})

test('opening a chat marks through the newest message, and a reply while open is marked too', async () => {
  const chat = { ...directChatOf('c1', 'alice'), latestMessage: { seq: 4, from: 'alice', at: 4, text: 'hi' } }
  const ctx = setup(snapshotOf({ cursor: 10, chats: [chat], readStates: [readStateOf('c1', 2, 2)] }))
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([messageOf({ seq: 4, chatId: 'c1' })]))
  ctx.network.routeJson('POST', 'mark_chat_read', { readState: readStateOf('c1', 4) })
  await connected(ctx)
  const close = ctx.session.openChat('c1')
  await settle()
  assert.deepEqual((ctx.network.bodiesTo('mark_chat_read').at(-1) as { input: object }).input, { chatId: 'c1', readThroughSeq: 4 })

  ctx.network.lastStream.pushFrame(messageUpsert(11, messageOf({ seq: 5, chatId: 'c1' })))
  await settle()
  assert.equal((ctx.network.bodiesTo('mark_chat_read').at(-1) as { input: { readThroughSeq: number } }).input.readThroughSeq, 5)

  close()
  const marks = ctx.network.bodiesTo('mark_chat_read').length
  ctx.network.lastStream.pushFrame(messageUpsert(12, messageOf({ seq: 6, chatId: 'c1' })))
  await settle()
  assert.equal(ctx.network.bodiesTo('mark_chat_read').length, marks)
  ctx.session.dispose()
})

test('the same chat open twice stays open until both leave', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([]))
  await connected(ctx)
  const first = ctx.session.openChat('c1')
  const second = ctx.session.openChat('c1')
  first()
  first() // closing twice counts once
  assert.equal(ctx.session.isChatOpen('c1'), true)
  second()
  assert.equal(ctx.session.isChatOpen('c1'), false)
  ctx.session.dispose()
})

test('Stop retries with one key while the proxy says the machine is down, up to 3 times (AG-54)', async () => {
  assert.equal(STOP_ATTEMPTS, 3)
  const ctx = setup()
  const answers = [{ status: 503, text: 'bad gateway' }, { status: 200, text: JSON.stringify({ agent: agentOf({ id: 'a1', name: 'alice' }) }) }]
  ctx.network.route('POST', 'stop_agent', () => answers.shift()!)
  await connected(ctx)
  const running = ctx.session.command('stop_agent', { agentId: 'a1' }, 3)
  await settle()
  await ctx.clock.advance(1000)
  const result = await running
  assert.equal(result.ok, true)
  const bodies = ctx.network.bodiesTo('stop_agent') as { idempotencyKey: string }[]
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]!.idempotencyKey, bodies[1]!.idempotencyKey)
  ctx.session.dispose()
})

test('a retry waiting out its delay is cancelled by dispose and never issues the command', async () => {
  const ctx = setup()
  ctx.network.route('POST', 'stop_agent', () => ({ status: 503, text: '' }))
  await connected(ctx)
  const running = ctx.session.command('stop_agent', { agentId: 'a1' }, 3)
  await settle()
  ctx.session.dispose()
  const result = await running
  assert.equal(result.ok, false)
  assert.equal(ctx.network.bodiesTo('stop_agent').length, 1)
})

test('proxy errors read as the machine being unreachable, typed refusals as themselves', async () => {
  const ctx = setup()
  await connected(ctx)
  for (const status of [502, 503, 504]) {
    ctx.network.route('POST', 'stop_agent', () => ({ status, text: '<html>' }))
    assert.equal(await ctx.session.commandError('stop_agent', { agentId: 'a1' }), "Couldn't reach your Ouro machine. Try again in a few seconds.", `HTTP ${status} (AG-60)`)
  }
  ctx.network.routeJson('POST', 'interrupt_agent', { error: { code: 'not_found', message: 'no such agent', retryable: false } }, 404)
  assert.equal(await ctx.session.commandError('interrupt_agent', { agentId: 'a1' }), 'no such agent')
  ctx.session.dispose()
})

test('a success that does not match the contract is an error, not data', async () => {
  const ctx = setup()
  await connected(ctx)
  ctx.network.routeJson('POST', 'stop_agent', { agent: { id: 'no fields' } })
  assert.equal(await ctx.session.commandError('stop_agent', { agentId: 'a1' }), 'malformed response')
  ctx.session.dispose()
})

test('a read that hangs times out and says so', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  ctx.network.route('GET', '/v2/chats/c1/messages', () => new Promise(() => {}))
  await connected(ctx)
  const load = ctx.session.loadLatest('c1')
  await settle()
  await ctx.clock.advance(30_000)
  const result = await load
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.failure.kind, 'timed_out')
  ctx.session.dispose()
})

// ---- outbox ----

const sendToAlice = (text = 'hello') => ({ destination: { kind: 'direct' as const, to: 'alice', answersAskId: null }, conversationId: 'c1', text, attachments: [] })
const acceptedMessage = (seq: number, key: string) => ({ message: messageOf({ seq, chatId: 'c1', from: 'human', clientKey: key }) })

test('a send is saved before any network call', async () => {
  const ctx = setup()
  const answer = deferred<{ status: number; text: string }>()
  ctx.network.route('POST', 'send_message', () => answer.promise)
  const key = ctx.outbox.send(sendToAlice())
  assert.equal(ctx.outbox.entries[0]?.delivery.state, 'sending')
  await settle()
  assert.ok([...ctx.store.values.keys()].some((k) => k.includes(key)))
  answer.resolve({ status: 200, text: JSON.stringify(acceptedMessage(1, key)) })
  await settle()
  assert.equal(ctx.outbox.entries.length, 0)
  assert.equal(ctx.store.values.size, 0)
})

test('an accepted send becomes the listed message, and its bubble hides as soon as the stream lists it', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  const answer = deferred<{ status: number; text: string }>()
  ctx.network.route('POST', 'send_message', () => answer.promise)
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([]))
  ctx.network.routeJson('POST', 'mark_chat_read', { readState: readStateOf('c1', 1) })
  await connected(ctx)
  const close = ctx.session.openChat('c1')
  await settle()
  const key = ctx.session.send(sendToAlice())
  await settle()
  const shown = () => outboxEntriesNotYetListed(ctx.outbox.entriesIn('c1'), ctx.session.store.timeline('c1')!.messages)
  assert.equal(shown().length, 1)
  // The stream beats the command's own answer.
  ctx.network.lastStream.pushFrame(messageUpsert(1, messageOf({ seq: 1, chatId: 'c1', from: 'human', clientKey: key })))
  await settle()
  assert.equal(shown().length, 0)
  answer.resolve({ status: 200, text: JSON.stringify(acceptedMessage(1, key)) })
  await settle()
  assert.equal(ctx.outbox.entries.length, 0)
  assert.deepEqual(ctx.session.store.timeline('c1')!.messages.map((m) => m.seq), [1])
  close()
  ctx.session.dispose()
})

test('the command answer does not overwrite a newer state from the stream', async () => {
  const ctx = setup(snapshotOf({ chats: [directChatOf('c1', 'alice')] }))
  const answer = deferred<{ status: number; text: string }>()
  ctx.network.route('POST', 'send_message', () => answer.promise)
  ctx.network.routeJson('GET', '/v2/chats/c1/messages', historyOf([]))
  ctx.network.routeJson('POST', 'mark_chat_read', { readState: readStateOf('c1', 1) })
  await connected(ctx)
  const close = ctx.session.openChat('c1')
  await settle()
  const key = ctx.session.send(sendToAlice())
  await settle()
  const newer = messageOf({ seq: 1, chatId: 'c1', from: 'human', clientKey: key, deliveries: [{ recipient: 'alice', recipientAgentId: 'a1', wake: 'wake', state: { state: 'completed', at: 5, turnId: 't', outcome: 'turn_finished' } }] })
  ctx.network.lastStream.pushFrame(messageUpsert(1, newer))
  await settle()
  answer.resolve({ status: 200, text: JSON.stringify(acceptedMessage(1, key)) })
  await settle()
  assert.equal(ctx.session.store.timeline('c1')!.messages[0]!.deliveries.length, 1)
  close()
  ctx.session.dispose()
})

test('a failed send says why, and retrying reuses its key', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'send_message', { error: { code: 'agent_archived', message: 'alice is archived', retryable: false } }, 409)
  const key = ctx.outbox.send(sendToAlice())
  await settle()
  assert.deepEqual(ctx.outbox.entries[0]?.delivery, { state: 'failed', reason: 'alice is archived' })

  ctx.network.routeJson('POST', 'send_message', acceptedMessage(1, key))
  ctx.outbox.retry(key)
  assert.equal(ctx.outbox.entries[0]?.delivery.state, 'sending')
  await settle()
  assert.equal(ctx.outbox.entries.length, 0)
  const bodies = ctx.network.bodiesTo('send_message') as { idempotencyKey: string }[]
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]!.idempotencyKey, key)
  assert.equal(bodies[1]!.idempotencyKey, key)
})

test('the network dropping mid-send is a visible failure, in the owner\'s words rather than the platform error', async () => {
  const ctx = setup()
  ctx.outbox.send(sendToAlice())
  await settle()
  const entry = ctx.outbox.entries[0]!
  assert.deepEqual(entry.delivery, { state: 'failed', reason: "Couldn't reach your Ouro machine. Try again in a few seconds." })
})

test('a store that cannot save makes the send fail without touching the network', async () => {
  const ctx = setup()
  ctx.store.failWrites = true
  ctx.outbox.send(sendToAlice())
  await settle()
  assert.equal(ctx.outbox.entries[0]?.delivery.state, 'failed')
  assert.equal(ctx.network.bodiesTo('send_message').length, 0)
})

test('a kill between saving and sending resumes with the same key after restart', async () => {
  const ctx = setup()
  const answer = deferred<{ status: number; text: string }>()
  ctx.network.route('POST', 'send_message', () => answer.promise)
  const key = ctx.outbox.send(sendToAlice())
  await settle()
  // Killed here: the answer never lands. A new outbox reads the same store.
  const reloaded = ctx.makeOutbox()
  ctx.network.routeJson('POST', 'send_message', acceptedMessage(1, key))
  await reloaded.load()
  await settle()
  assert.equal(reloaded.entries.length, 0)
  const bodies = ctx.network.bodiesTo('send_message') as { idempotencyKey: string }[]
  assert.equal(bodies.at(-1)!.idempotencyKey, key)
})

test('a failed send stays failed across a restart, without resending', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'send_message', { error: { code: 'internal', message: 'boom', retryable: true } }, 500)
  ctx.outbox.send(sendToAlice())
  await settle()
  const sends = ctx.network.bodiesTo('send_message').length
  const reloaded = ctx.makeOutbox()
  await reloaded.load()
  await settle()
  assert.equal(reloaded.entries[0]?.delivery.state, 'failed')
  assert.equal(ctx.network.bodiesTo('send_message').length, sends)
})

test('messages to one conversation go in order, one at a time', async () => {
  const ctx = setup()
  const first = deferred<{ status: number; text: string }>()
  const answers = [first.promise, Promise.resolve({ status: 200, text: JSON.stringify(acceptedMessage(2, 'x')) })]
  ctx.network.route('POST', 'send_message', () => answers.shift()!)
  ctx.outbox.send(sendToAlice('one'))
  await settle()
  ctx.outbox.send(sendToAlice('two'))
  await settle()
  assert.equal(ctx.network.bodiesTo('send_message').length, 1)
  first.resolve({ status: 200, text: JSON.stringify(acceptedMessage(1, 'y')) })
  await settle()
  const texts = (ctx.network.bodiesTo('send_message') as { input: { text: string } }[]).map((b) => b.input.text)
  assert.deepEqual(texts, ['one', 'two'])
})

const withFile = (name: string) => ({
  ...sendToAlice('look'),
  attachments: [{ localId: name, uri: `file:///${name}`, fileName: name, mimeType: 'image/png', byteLength: 3 }],
})

test('a retry does not upload again what already went up', async () => {
  const ctx = setup()
  ctx.network.uploadHandler = (request) => ({ status: 200, text: JSON.stringify({ id: `att-${request.fileUri}`, fileName: 'x', mimeType: 'image/png', byteLength: 3 }) })
  ctx.network.routeJson('POST', 'send_message', { error: { code: 'internal', message: 'boom', retryable: true } }, 500)
  const key = ctx.outbox.send(withFile('a.png'))
  await settle()
  assert.equal(ctx.network.uploads.length, 1)
  assert.equal(ctx.outbox.entries[0]?.attachments[0]?.uploadedAttachmentId, 'att-file:///a.png')

  ctx.network.routeJson('POST', 'send_message', acceptedMessage(1, key))
  ctx.outbox.retry(key)
  await settle()
  assert.equal(ctx.network.uploads.length, 1)
  const last = ctx.network.bodiesTo('send_message').at(-1) as { input: { attachmentIds: string[] } }
  assert.deepEqual(last.input.attachmentIds, ['att-file:///a.png'])
})

test('a failed upload fails the send, and the message is not issued', async () => {
  const ctx = setup()
  ctx.network.uploadHandler = () => ({ status: 413, text: JSON.stringify({ error: { code: 'attachment_too_large', message: 'too large', retryable: false } }) })
  ctx.outbox.send(withFile('big.mov'))
  await settle()
  assert.deepEqual(ctx.outbox.entries[0]?.delivery, { state: 'failed', reason: 'too large' })
  assert.equal(ctx.network.bodiesTo('send_message').length, 0)
})

test('an upload answered with nothing readable names the file and its status (CHAT-73)', async () => {
  const ctx = setup()
  ctx.network.uploadHandler = () => ({ status: 500, text: '<html>Internal Server Error</html>' })
  ctx.outbox.send(withFile('big.mov'))
  await settle()
  assert.deepEqual(ctx.outbox.entries[0]?.delivery, { state: 'failed', reason: 'big.mov: upload failed (500)' })
})

test('Edit takes a failed send back, and Delete discards it', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'send_message', { error: { code: 'internal', message: 'boom', retryable: true } }, 500)
  const edited = ctx.outbox.send(sendToAlice('edit me'))
  const deleted = ctx.outbox.send(sendToAlice('delete me'))
  await settle()
  assert.equal((await ctx.outbox.takeBack(edited))?.text, 'edit me')
  await ctx.outbox.discard(deleted)
  assert.equal(ctx.outbox.entries.length, 0)
  assert.equal(ctx.store.values.size, 0)
})

test('Edit is refused for a send still going out', async () => {
  const ctx = setup()
  ctx.network.route('POST', 'send_message', () => new Promise(() => {}))
  const key = ctx.outbox.send(sendToAlice())
  await settle()
  assert.equal(await ctx.outbox.takeBack(key), null)
  assert.equal(ctx.outbox.entries.length, 1)
})

test('a group post uses post_to_chat', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'post_to_chat', { message: messageOf({ seq: 1, chatId: 'g1', from: 'human' }), pendingAtHome: false })
  ctx.outbox.send({ destination: { kind: 'group', chatId: 'g1' }, conversationId: 'g1', text: 'hi all', attachments: [] })
  await settle()
  assert.deepEqual((ctx.network.bodiesTo('post_to_chat')[0] as { input: object }).input, { chatId: 'g1', text: 'hi all', attachmentIds: [] })
  assert.equal(ctx.outbox.entries.length, 0)
})

// ---- drafts ----

test('drafts are per conversation and survive a restart; clearing removes them', async () => {
  const ctx = setup()
  const drafts = new ServerDrafts(ctx.store, 's1')
  drafts.setText('c1', 'half a thought')
  drafts.setText('c2', 'another')
  await settle()
  const reloaded = new ServerDrafts(ctx.store, 's1')
  await reloaded.load()
  assert.equal(reloaded.textOf('c1'), 'half a thought')
  reloaded.setText('c1', '')
  await settle()
  const again = new ServerDrafts(ctx.store, 's1')
  await again.load()
  assert.equal(again.textOf('c1'), '')
  assert.equal(again.textOf('c2'), 'another')
})

test('the same conversation name on two servers has separate drafts', async () => {
  const ctx = setup()
  new ServerDrafts(ctx.store, 's1').setText('master', 'for one')
  await settle()
  const other = new ServerDrafts(ctx.store, 's2')
  await other.load()
  assert.equal(other.textOf('master'), '')
})

test('every kind of failure has words to show, so no screen needs a reasonless fallback (AG-26, SET-27)', () => {
  // One of each kind; the type makes a new kind fail to compile here until it is added.
  const oneOfEach: { [K in ApiFailure['kind']]: Extract<ApiFailure, { kind: K }> } = {
    refused: { kind: 'refused', status: 409, error: { code: 'invalid_request', message: 'That name is taken.', retryable: false } },
    unauthenticated: { kind: 'unauthenticated', status: 401 },
    machine_unreachable: { kind: 'machine_unreachable', status: 502 },
    no_answer: { kind: 'no_answer', reason: 'fetch failed' },
    timed_out: { kind: 'timed_out' },
    invalid_answer: { kind: 'invalid_answer', status: 200, reason: 'bad json' },
    cancelled: { kind: 'cancelled' },
  }
  for (const failure of Object.values(oneOfEach)) assert.ok(failureText(failure).trim().length > 0, failure.kind)
})

test("the list reads the ChatGPT plan's usage now and every 2 minutes while ChatGPT is signed in, and stops when left (AG-10)", async () => {
  const signedIn: IntegrationEntity = { id: 'chatgpt', provider: 'chatgpt', state: { status: 'signed_in', email: null, plan: null, models: [] }, checkedAt: 1 }
  const ctx = setup(snapshotOf({ integrations: [signedIn] }))
  ctx.network.routeJson('POST', 'refresh_plan_usage', { server: snapshotOf().server })
  await connected(ctx)
  const stop = ctx.session.followPlanUsage()
  await settle()
  const asked = () => ctx.network.bodiesTo('refresh_plan_usage') as { input: { provider: string } }[]
  assert.equal(asked().length, 1)
  assert.deepEqual(asked()[0]!.input, { provider: 'chatgpt' })
  await ctx.clock.advance(PLAN_USAGE_REFRESH_MS - 1)
  assert.equal(asked().length, 1)
  await ctx.clock.advance(1)
  assert.equal(asked().length, 2)
  stop()
  await ctx.clock.advance(PLAN_USAGE_REFRESH_MS * 3)
  assert.equal(asked().length, 2, 'not after leaving the list')
  ctx.session.dispose()
})

test("an agent's chat on screen tells the server it is watching, now and every 25 seconds, until it leaves (CHAT-17)", async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'watch_agent', {})
  await connected(ctx)
  const stop = ctx.session.watchAgent('a1')
  await settle()
  const told = () => ctx.network.bodiesTo('watch_agent') as { input: { agentId: string } }[]
  assert.deepEqual(told().map((body) => body.input), [{ agentId: 'a1' }])
  assert.ok(WATCH_BEAT_MS < WATCH_LEASE_MS, "inside the server's lease")
  await ctx.clock.advance(WATCH_BEAT_MS)
  assert.equal(told().length, 2)
  stop()
  await ctx.clock.advance(WATCH_BEAT_MS * 3)
  assert.equal(told().length, 2, 'not after leaving')
  ctx.session.dispose()
})

test('without ChatGPT signed in nothing is asked', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', 'refresh_plan_usage', { server: snapshotOf().server })
  await connected(ctx)
  const stop = ctx.session.followPlanUsage()
  await ctx.clock.advance(PLAN_USAGE_REFRESH_MS)
  assert.equal(ctx.network.bodiesTo('refresh_plan_usage').length, 0)
  stop()
  ctx.session.dispose()
})

test("OpenRouter's spend is read every 2 minutes too while it has a key, beside ChatGPT's plan (AG-10)", async () => {
  const chatgpt: IntegrationEntity = { id: 'chatgpt', provider: 'chatgpt', state: { status: 'signed_in', email: null, plan: null, models: [] }, checkedAt: 1 }
  const openrouter: IntegrationEntity = { id: 'openrouter', provider: 'openrouter', state: { status: 'configured', spentUsd: 1, availableUsd: 9 }, checkedAt: 1 }
  const ctx = setup(snapshotOf({ integrations: [chatgpt, openrouter] }))
  ctx.network.routeJson('POST', 'refresh_plan_usage', { server: snapshotOf().server })
  await connected(ctx)
  const stop = ctx.session.followPlanUsage()
  await settle()
  const providers = () => (ctx.network.bodiesTo('refresh_plan_usage') as { input: { provider: string } }[]).map((body) => body.input.provider)
  assert.deepEqual(providers().sort(), ['chatgpt', 'openrouter'])
  await ctx.clock.advance(PLAN_USAGE_REFRESH_MS)
  assert.deepEqual(providers().sort(), ['chatgpt', 'chatgpt', 'openrouter', 'openrouter'])
  stop()
  ctx.session.dispose()
})

test('OpenRouter not answering keeps the timer going, and without a key it is not asked', async () => {
  const openrouter: IntegrationEntity = { id: 'openrouter', provider: 'openrouter', state: { status: 'configured', spentUsd: 1, availableUsd: 9 }, checkedAt: 1 }
  const ctx = setup(snapshotOf({ integrations: [openrouter] }))
  ctx.network.routeJson('POST', 'refresh_plan_usage', { error: { code: 'provider_unreachable', message: 'OpenRouter did not answer', retryable: true } }, 503)
  await connected(ctx)
  const stop = ctx.session.followPlanUsage()
  await settle()
  await ctx.clock.advance(PLAN_USAGE_REFRESH_MS)
  assert.equal(ctx.network.bodiesTo('refresh_plan_usage').length, 2)
  stop()
  ctx.session.dispose()
  const none = setup(snapshotOf({ integrations: [{ ...openrouter, state: { status: 'not_configured' } }] }))
  none.network.routeJson('POST', 'refresh_plan_usage', { server: snapshotOf().server })
  await connected(none)
  const stopNone = none.session.followPlanUsage()
  await none.clock.advance(PLAN_USAGE_REFRESH_MS)
  assert.equal(none.network.bodiesTo('refresh_plan_usage').length, 0)
  stopNone()
  none.session.dispose()
})
