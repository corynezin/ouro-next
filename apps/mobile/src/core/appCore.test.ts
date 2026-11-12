import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SERVER_PORT } from '@ouro/contract'
import { parseInviteLink, parsePairLink, serverUrlFromInput } from './accounts/pairing.ts'
import { DEFAULT_PREFERENCES, PreferencesStore } from './accounts/preferences.ts'
import { SavedServers, ServerListDamaged } from './accounts/savedServers.ts'
import type { SavedServer } from './accounts/savedServers.ts'
import { AppCore, STARTUP_FAILED_MESSAGE } from './appCore.ts'
import { deferred, FakeClock, FakeIds, FakeLifecycle, FakeNetwork, MemoryDurableStore, MemorySecureStorage, settle } from './platform/fakes.ts'
import { caughtUpFrame, messageOf, snapshotOf } from './testSupport.ts'

const LIST_KEY = 'ouronext.servers'
const PREFS_KEY = 'ouronext.preferences'
const A = 'https://a.test'
const B = 'https://b.test'

function setup() {
  const secureStorage = new MemorySecureStorage()
  const durableStore = new MemoryDurableStore()
  const network = new FakeNetwork()
  const clock = new FakeClock()
  const lifecycle = new FakeLifecycle()
  const ids = new FakeIds()
  const deps = { secureStorage, durableStore, network, clock, lifecycle, ids }
  for (const url of [A, B]) network.routeJson('GET', `${url}/v2/snapshot`, snapshotOf({ epoch: url }))
  return { ...deps, deps, core: new AppCore(deps), servers: new SavedServers(secureStorage, ids) }
}

const paired = (url: string) => ({ url, token: `token-${url}`, deviceName: 'phone', deviceId: 'd', personName: null })
const entry = (id: string, url: string): SavedServer => ({ id, label: id, url, deviceName: 'phone', deviceId: 'd', personName: null, hostedServerId: null })
const pairResponse = { deviceToken: 'new-token', deviceId: 'd2', personId: 'p', machineId: 'm', machineName: 'alpha' }

test('no saved setup: ready with no session', async () => {
  const { core } = setup()
  await core.start()
  assert.deepEqual(core.startup, { stage: 'ready' })
  assert.equal(core.activeSession, null)
})

test('startup connects to the active server', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  const second = await ctx.servers.add(paired(B))
  await ctx.core.start()
  assert.equal(ctx.core.activeSession?.serverId, second.id)
  ctx.core.activeSession?.dispose()
})

test('an active server with no token falls through to the next usable one', async () => {
  const ctx = setup()
  const first = await ctx.servers.add(paired(A))
  const second = await ctx.servers.add(paired(B))
  ctx.secureStorage.values.delete(`ouronext.server.${second.id}.token`)
  await ctx.core.start()
  assert.equal(ctx.core.activeSession?.serverId, first.id)
  ctx.core.activeSession?.dispose()
})

test('storage that rejects fails startup with Retry, and deletes nothing', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  const before = new Map(ctx.secureStorage.values)
  ctx.secureStorage.failReads = true
  await ctx.core.start()
  assert.deepEqual(ctx.core.startup, { stage: 'failed', message: STARTUP_FAILED_MESSAGE })
  assert.deepEqual(ctx.secureStorage.values, before)

  ctx.secureStorage.failReads = false
  await ctx.core.start()
  assert.equal(ctx.core.startup.stage, 'ready')
  assert.ok(ctx.core.activeSession)
  ctx.core.activeSession?.dispose()
})

test('a pairing that finishes while startup reads storage is not replaced', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  ctx.network.routeJson('POST', `${B}/v2/pair`, pairResponse)
  const slowRead = deferred<void>()
  const read = ctx.secureStorage.read.bind(ctx.secureStorage)
  ctx.secureStorage.read = async (key) => { await slowRead.promise; return read(key) }
  const starting = ctx.core.start()
  ctx.secureStorage.read = read
  const pairing = ctx.core.pairAndActivate(B, 'code')
  await pairing
  const server = ctx.core.activeSession!.serverId
  slowRead.resolve()
  await starting
  assert.equal(ctx.core.activeSession?.serverId, server)
  assert.deepEqual(ctx.core.startup, { stage: 'ready' })
  assert.equal(ctx.core.activeSession?.api.endpoint.url, B)
  ctx.core.activeSession?.dispose()
})

test('a failed startup that lost to a pairing does not hide the working pairing', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', `${B}/v2/pair`, pairResponse)
  const slowRead = deferred<string | null>()
  const read = ctx.secureStorage.read.bind(ctx.secureStorage)
  ctx.secureStorage.read = () => slowRead.promise
  const starting = ctx.core.start()
  ctx.secureStorage.read = read
  await ctx.core.pairAndActivate(B, 'code')
  slowRead.reject(new Error('storage unavailable'))
  await starting
  assert.deepEqual(ctx.core.startup, { stage: 'ready' })
  assert.ok(ctx.core.activeSession)
  ctx.core.activeSession?.dispose()
})

test('switching disposes the old session, and its late answer has nowhere to land', async () => {
  const ctx = setup()
  const first = await ctx.servers.add(paired(A))
  const second = await ctx.servers.add(paired(B))
  await ctx.servers.setActiveId(first.id)
  await ctx.core.start()
  const oldSession = ctx.core.activeSession!
  const slow = deferred<{ status: number; text: string }>()
  ctx.network.route('GET', `${A}/v2/chats/c1/messages`, () => slow.promise)
  const load = oldSession.loadLatest('c1')
  await settle()

  assert.equal(await ctx.core.switchTo(second), true)
  assert.equal(oldSession.isDisposed, true)
  assert.equal(ctx.core.activeSession?.serverId, second.id)
  slow.resolve({ status: 200, text: JSON.stringify({ messages: [messageOf({ seq: 1, chatId: 'c1' })], hasOlder: false }) })
  assert.equal((await load).ok, false)
  assert.equal(ctx.core.activeSession?.store.timeline('c1'), undefined)
  ctx.core.activeSession?.dispose()
})

test('rapid A-B-A leaves only the last session running', async () => {
  const ctx = setup()
  const a = await ctx.servers.add(paired(A))
  const b = await ctx.servers.add(paired(B))
  await ctx.core.start()
  await Promise.all([ctx.core.switchTo(a), ctx.core.switchTo(b), ctx.core.switchTo(a)])
  assert.equal(ctx.core.activeSession?.serverId, a.id)
  await settle()
  const stillOpen = ctx.network.requests.filter((r) => r.url.includes('/v2/changes') && !r.signal.aborted)
  assert.equal(stillOpen.length, 1)
  assert.equal(stillOpen[0]!.url.startsWith(A), true)
  ctx.core.activeSession?.dispose()
})

test('a send survives a switch: it goes to its own server with its own token', async () => {
  const ctx = setup()
  const a = await ctx.servers.add(paired(A))
  const b = await ctx.servers.add(paired(B))
  await ctx.servers.setActiveId(a.id)
  await ctx.core.start()
  const session = ctx.core.activeSession!
  const answer = deferred<{ status: number; text: string }>()
  ctx.network.route('POST', `${A}/v2/commands/send_message`, () => answer.promise)
  session.send({ destination: { kind: 'direct', to: 'master', answersAskId: null }, conversationId: 'c', text: 'hello', attachments: [] })
  await settle()
  await ctx.core.switchTo(b)

  answer.resolve({ status: 200, text: JSON.stringify({ message: messageOf({ seq: 1, chatId: 'c', from: 'human' }) }) })
  await settle()
  const sent = ctx.network.requests.filter((r) => r.url.includes('send_message'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.url.startsWith(A), true)
  assert.equal(sent[0]!.headers.authorization, `Bearer token-${A}`)
  assert.equal(session.outbox.entries.length, 0, 'the send finished although its session was disposed')
  assert.equal(ctx.core.activeSession?.outbox.entries.length, 0)
  ctx.core.activeSession?.dispose()
})

test('a failed send on another server is still there on returning', async () => {
  const ctx = setup()
  const a = await ctx.servers.add(paired(A))
  const b = await ctx.servers.add(paired(B))
  await ctx.servers.setActiveId(a.id)
  await ctx.core.start()
  ctx.core.activeSession!.send({ destination: { kind: 'direct', to: 'master', answersAskId: null }, conversationId: 'c', text: 'hello', attachments: [] })
  await settle()
  await ctx.core.switchTo(b)
  assert.equal(ctx.core.activeSession?.outbox.entries.length, 0)
  await ctx.core.switchTo(a)
  assert.equal(ctx.core.activeSession?.outbox.entries[0]?.delivery.state, 'failed')
  ctx.core.activeSession?.dispose()
})

test('sends left by a kill go out on launch, for servers that are not active too', async () => {
  const ctx = setup()
  const a = await ctx.servers.add(paired(A))
  const b = await ctx.servers.add(paired(B))
  await ctx.servers.setActiveId(a.id)
  await ctx.durableStore.write(`outbox/${b.id}/key-00000001`, JSON.stringify({
    idempotencyKey: 'key-00000001', destination: { kind: 'direct', to: 'master', answersAskId: null }, conversationId: 'c', text: 'left behind',
    attachments: [], createdAt: 1, delivery: { state: 'sending' },
  }))
  ctx.network.routeJson('POST', `${B}/v2/commands/send_message`, { message: messageOf({ seq: 1, chatId: 'c', from: 'human' }) })
  await ctx.core.start()
  await settle()
  assert.equal((ctx.network.bodiesTo('send_message')[0] as { idempotencyKey: string }).idempotencyKey, 'key-00000001')
  assert.equal(ctx.durableStore.values.size, 0)
  ctx.core.activeSession?.dispose()
})

test('removing the active server moves to the next; removing the last leaves none', async () => {
  const ctx = setup()
  const a = await ctx.servers.add(paired(A))
  const b = await ctx.servers.add(paired(B))
  await ctx.core.start()
  assert.equal(ctx.core.activeSession?.serverId, b.id)
  await ctx.core.removeServer(b.id)
  assert.equal(ctx.core.activeSession?.serverId, a.id)
  assert.equal(ctx.secureStorage.values.has(`ouronext.server.${b.id}.token`), false)
  await ctx.core.removeServer(a.id)
  assert.equal(ctx.core.activeSession, null)
  assert.equal(await ctx.servers.activeId(), null)
})

test('sign out forgets the account, every server and every token', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  await ctx.core.hostedAccounts.save({ accountId: 'u', token: 't', name: 'Alex' })
  await ctx.core.start()
  await ctx.core.signOut()
  assert.equal(ctx.core.activeSession, null)
  assert.equal(ctx.core.hostedAccount, null)
  assert.deepEqual(await ctx.servers.list(), [])
  assert.equal([...ctx.secureStorage.values.keys()].filter((k) => k.endsWith('.token')).length, 0)
  assert.equal(await ctx.core.hostedAccounts.load(), null)
})

test('sign out is refused while the server list is damaged, and nothing is deleted', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  ctx.secureStorage.values.set(LIST_KEY, 'not json')
  await ctx.core.hostedAccounts.save({ accountId: 'u', token: 't', name: 'Alex' })
  await assert.rejects(ctx.core.signOut(), ServerListDamaged)
  assert.ok(await ctx.core.hostedAccounts.load())
  assert.equal([...ctx.secureStorage.values.keys()].filter((k) => k.endsWith('.token')).length, 1)
})

test('pair failure reports the server reason and saves nothing', async () => {
  const ctx = setup()
  ctx.network.routeJson('POST', `${A}/v2/pair`, { error: { code: 'pairing_code_invalid', message: 'That code has expired.', retryable: false } }, 403)
  await assert.rejects(ctx.core.pairAndActivate(A, 'old'), /That code has expired/)
  assert.deepEqual(await ctx.servers.list(), [])
})

test('pairing the same address replaces its entry and token', async () => {
  const ctx = setup()
  const first = await ctx.servers.add(paired(`${A}/`))
  ctx.network.routeJson('POST', `${A}/v2/pair`, pairResponse)
  await ctx.core.pairAndActivate(A, 'code')
  const list = await ctx.servers.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.id, first.id)
  assert.equal(await ctx.servers.tokenOf(first.id), 'new-token')
  ctx.core.activeSession?.dispose()
})

// ---- damaged server list ----

test('a list that is not JSON or not an array is damaged; tokens stay', async () => {
  for (const raw of ['not json', '{"a":1}']) {
    const ctx = setup()
    ctx.secureStorage.values.set(LIST_KEY, raw)
    ctx.secureStorage.values.set('ouronext.server.x.token', 'kept')
    assert.deepEqual(await ctx.servers.list(), [])
    assert.equal(ctx.servers.needsRecovery, true)
    assert.equal(ctx.secureStorage.values.get('ouronext.server.x.token'), 'kept')
    assert.equal(ctx.secureStorage.values.get(LIST_KEY), raw)
  }
})

test('a mixed list salvages unique valid entries and refuses changes, leaving the original untouched', async () => {
  const ctx = setup()
  const raw = JSON.stringify([entry('good', A), { id: 'bad' }, entry('dup', B), entry('dup', B)])
  ctx.secureStorage.values.set(LIST_KEY, raw)
  assert.deepEqual((await ctx.servers.list()).map((s) => s.id), ['good'])
  assert.equal(ctx.servers.needsRecovery, true)
  await assert.rejects(ctx.servers.rename('good', 'new'), (error: Error) => error instanceof ServerListDamaged
    && error.message === 'Saved server list needs recovery. Reset it from the recovery warning before making changes.')
  await assert.rejects(ctx.servers.remove('good'), ServerListDamaged)
  await assert.rejects(ctx.servers.add(paired(B)), ServerListDamaged)
  assert.equal(ctx.secureStorage.values.get(LIST_KEY), raw)
})

test('a salvaged server still connects', async () => {
  const ctx = setup()
  ctx.secureStorage.values.set(LIST_KEY, JSON.stringify([entry('good', A), { id: 'bad' }]))
  ctx.secureStorage.values.set('ouronext.server.good.token', 't')
  await ctx.core.start()
  assert.equal(ctx.core.activeSession?.serverId, 'good')
  assert.equal(ctx.core.servers.needsRecovery, true)
  ctx.core.activeSession?.dispose()
})

test('reset keeps a recovery copy of the exact value and every token, and pairing works again', async () => {
  const ctx = setup()
  ctx.secureStorage.values.set(LIST_KEY, 'garbage')
  ctx.secureStorage.values.set('ouronext.server.x.token', 'kept')
  await ctx.servers.list()
  await ctx.servers.resetDamagedList()
  assert.equal(ctx.servers.needsRecovery, false)
  assert.equal(ctx.secureStorage.values.get(LIST_KEY), '[]')
  const copies = [...ctx.secureStorage.values].filter(([k]) => k.startsWith(`${LIST_KEY}.recovery.`))
  assert.deepEqual(copies.map(([, v]) => v), ['garbage'])
  assert.equal(ctx.secureStorage.values.get('ouronext.server.x.token'), 'kept')
  await ctx.servers.add(paired(A))
  assert.equal((await ctx.servers.list()).length, 1)
})

test('pairing while the list is damaged is refused with the recovery words, before the one-use code is spent', async () => {
  const ctx = setup()
  ctx.secureStorage.values.set(LIST_KEY, 'garbage')
  ctx.network.routeJson('POST', `${B}/v2/pair`, pairResponse)
  await ctx.core.servers.list()
  await assert.rejects(ctx.core.pairAndActivate(B, 'code'), (error: Error) => error instanceof ServerListDamaged
    && error.message === 'Reset the damaged server list from the recovery warning before pairing.')
  assert.equal(ctx.network.requests.filter((request) => request.url.endsWith('/v2/pair')).length, 0)
})

test('a failed backup prevents the reset', async () => {
  const ctx = setup()
  ctx.secureStorage.values.set(LIST_KEY, 'garbage')
  await ctx.servers.list()
  ctx.secureStorage.failNextWriteMatching = /recovery/
  await assert.rejects(ctx.servers.resetDamagedList())
  assert.equal(ctx.secureStorage.values.get(LIST_KEY), 'garbage')
  assert.equal(ctx.servers.needsRecovery, true)
})

test('a read that rejects is not treated as damage and resets nothing', async () => {
  const ctx = setup()
  ctx.secureStorage.values.set(LIST_KEY, JSON.stringify([entry('good', A)]))
  ctx.secureStorage.failReads = true
  await assert.rejects(ctx.servers.list())
  await assert.rejects(ctx.servers.resetDamagedList())
  ctx.secureStorage.failReads = false
  assert.deepEqual((await ctx.servers.list()).map((s) => s.id), ['good'])
})

// ---- preferences ----

function preferencesOf(raw: string | null) {
  const storage = new MemorySecureStorage()
  if (raw !== null) storage.values.set(PREFS_KEY, raw)
  return { storage, preferences: new PreferencesStore(storage, new FakeIds()) }
}

test('absent preferences are defaults, not damage, and changes are saved', async () => {
  const { storage, preferences } = preferencesOf(null)
  await preferences.load()
  assert.deepEqual(preferences.current, DEFAULT_PREFERENCES)
  assert.equal(preferences.needsRecovery, false)
  preferences.set('modelAvatars', false)
  await settle()
  assert.equal(JSON.parse(storage.values.get(PREFS_KEY)!).modelAvatars, false)
})

test('invalid preferences block saving until reset, while changes apply for this run', async () => {
  const raw = 'garbage'
  const { storage, preferences } = preferencesOf(raw)
  await preferences.load()
  assert.equal(preferences.needsRecovery, true)
  preferences.set('modelAvatars', false)
  await settle()
  assert.equal(preferences.current.modelAvatars, false)
  assert.equal(storage.values.get(PREFS_KEY), raw)
})

test('preferences that are JSON but not an object are damaged, and not written back', async () => {
  for (const raw of ['[true]', '5', 'null', '"faceid"']) {
    const { storage, preferences } = preferencesOf(raw)
    await preferences.load()
    assert.equal(preferences.needsRecovery, true, raw)
    assert.deepEqual(preferences.current, DEFAULT_PREFERENCES)
    preferences.set('modelAvatars', false)
    await settle()
    assert.equal(storage.values.get(PREFS_KEY), raw)
  }
})

test('mixed preferences salvage valid fields, default invalid ones, and retain the original', async () => {
  const raw = JSON.stringify({ requireFaceId: true, idleFold: 'soon', modelAvatars: false })
  const { storage, preferences } = preferencesOf(raw)
  await preferences.load()
  assert.equal(preferences.current.requireFaceId, true)
  assert.deepEqual(preferences.current.idleFold, DEFAULT_PREFERENCES.idleFold)
  assert.equal(preferences.current.modelAvatars, false)
  assert.equal(preferences.needsRecovery, true)
  assert.equal(storage.values.get(PREFS_KEY), raw)
})

test('resetting preferences keeps a recovery copy and the Face ID lock', async () => {
  const raw = JSON.stringify({ requireFaceId: true, idleFold: 'soon' })
  const { storage, preferences } = preferencesOf(raw)
  await preferences.load()
  await preferences.resetDamaged()
  assert.equal(preferences.needsRecovery, false)
  assert.equal(preferences.current.requireFaceId, true)
  assert.deepEqual([...storage.values].filter(([k]) => k.includes('.recovery.')).map(([, v]) => v), [raw])
  preferences.set('modelAvatars', false)
  await settle()
  assert.equal(JSON.parse(storage.values.get(PREFS_KEY)!).modelAvatars, false)
})

test('a failed backup prevents the preferences reset, leaving them damaged and as stored', async () => {
  const raw = JSON.stringify({ requireFaceId: true, idleFold: 'soon' })
  const { storage, preferences } = preferencesOf(raw)
  await preferences.load()
  storage.failNextWriteMatching = /recovery/
  await assert.rejects(preferences.resetDamaged())
  assert.equal(preferences.needsRecovery, true)
  assert.equal(storage.values.get(PREFS_KEY), raw)
})

test('a read that rejects blocks writes until a successful load', async () => {
  const { storage, preferences } = preferencesOf(JSON.stringify({ modelAvatars: false }))
  storage.failReads = true
  await assert.rejects(preferences.load())
  preferences.set('requireFaceId', true)
  await settle()
  assert.equal(JSON.parse(storage.values.get(PREFS_KEY)!).requireFaceId, undefined)
  storage.failReads = false
  await preferences.load()
  assert.equal(preferences.current.modelAvatars, false)
})

// ---- pairing input ----

test('address input follows the reference rules, with our default port', () => {
  assert.equal(serverUrlFromInput('100.64.1.2'), `http://100.64.1.2:${DEFAULT_SERVER_PORT}`)
  assert.equal(serverUrlFromInput('100.64.1.2:9000'), 'http://100.64.1.2:9000')
  assert.equal(serverUrlFromInput('mac.ts.net:9000'), 'http://mac.ts.net:9000')
  assert.equal(serverUrlFromInput('mac.ts.net'), 'https://mac.ts.net')
  assert.equal(serverUrlFromInput('https://x.sprites.app/'), 'https://x.sprites.app')
  assert.equal(serverUrlFromInput(''), null)
  assert.equal(serverUrlFromInput('ftp://x'), null)
})

test('pair links work with any scheme', () => {
  const link = 'ouronext://pair?url=https%3A%2F%2Fa.test&code=abc'
  assert.deepEqual(parsePairLink(link), { url: 'https://a.test', code: 'abc' })
  assert.deepEqual(parsePairLink(link.replace('ouronext', 'other')), { url: 'https://a.test', code: 'abc' })
  assert.equal(parsePairLink('ouronext://pair?url=https%3A%2F%2Fa.test'), null)
  assert.equal(parsePairLink('hello'), null)
})

test('invite links give the code', () => {
  assert.equal(parseInviteLink('ouronext://invite?code=xyz'), 'xyz')
  assert.equal(parseInviteLink('ouronext://pair?code=xyz'), null)
})

test('caught-up helper frames are accepted by a live session', async () => {
  const ctx = setup()
  await ctx.servers.add(paired(A))
  await ctx.core.start()
  await settle()
  ctx.network.lastStream.pushFrame(caughtUpFrame(0))
  await settle()
  assert.equal(ctx.core.activeSession?.connection.phase, 'live')
  ctx.core.activeSession?.dispose()
})

test('the first server paired becomes the update home; switching never moves it; removing it clears it', async () => {
  const ctx = setup()
  await ctx.core.start()
  ctx.network.routeJson('POST', `${A}/v2/pair`, pairResponse)
  ctx.network.routeJson('POST', `${B}/v2/pair`, pairResponse)
  const a = await ctx.core.pairAndActivate(A, 'code')
  assert.equal((await ctx.core.updateHome())?.id, a.id)
  const b = await ctx.core.pairAndActivate(B, 'code')
  assert.equal(ctx.core.activeSession?.serverId, b.id)
  assert.equal((await ctx.core.updateHome())?.id, a.id, 'pairing another keeps the home')
  await ctx.core.switchTo(a)
  await ctx.core.switchTo(b)
  assert.equal((await ctx.core.updateHome())?.id, a.id, 'switching keeps the home')
  ctx.core.setUpdateHome(b.id)
  assert.equal((await ctx.core.updateHome())?.id, b.id)
  await ctx.core.removeServer(b.id)
  assert.equal(await ctx.core.updateHome(), null, 'the home is gone, so is the update source')
  ctx.core.activeSession?.dispose()
})

test('sign out clears the update home; a preferences reset keeps it', async () => {
  const ctx = setup()
  await ctx.core.start()
  ctx.network.routeJson('POST', `${A}/v2/pair`, pairResponse)
  const a = await ctx.core.pairAndActivate(A, 'code')
  await ctx.secureStorage.write(PREFS_KEY, JSON.stringify({ updateHomeServerId: a.id, idleFold: 'broken' }))
  await ctx.core.preferences.load()
  await ctx.core.preferences.resetDamaged()
  assert.equal(ctx.core.preferences.current.updateHomeServerId, a.id)
  await ctx.core.signOut()
  assert.equal(ctx.core.preferences.current.updateHomeServerId, null)
})

test('pairing a server leaves it unlinked; one the person just made here is linked with the other saved servers', async () => {
  const ctx = setup()
  await ctx.core.start()
  for (const url of [A, B]) {
    ctx.network.routeJson('POST', `${url}/v2/pair`, pairResponse)
    ctx.network.routeJson('POST', `${url}/v2/commands/create_computer_invite`, { code: `code-${url}`, expiresAt: 1, command: 'words for people', address: url })
    ctx.network.routeJson('POST', `${url}/v2/commands/join_computer`, {})
  }
  await ctx.core.pairAndActivate(A, 'code')
  await ctx.core.pairAndActivate(B, 'code')
  await settle()
  assert.deepEqual(ctx.network.bodiesTo('/join_computer'), [], 'a plain pairing links nothing by itself')

  await ctx.core.removeServer((await ctx.core.servers.list()).find((server) => server.url === B)!.id)
  await ctx.core.pairAndActivate(B, 'code', { label: 'Made', afterPairing: 'link_with_other_servers' })
  await settle()
  const joins = ctx.network.requests.filter((request) => request.url.includes('/join_computer'))
  assert.deepEqual(joins.map((request) => [request.url.split('/v2/')[0], (JSON.parse(request.body!) as { input: unknown }).input]), [[B, { address: A, code: `code-${A}` }]])
  ctx.core.activeSession?.dispose()
})
