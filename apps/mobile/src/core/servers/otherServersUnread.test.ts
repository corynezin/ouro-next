import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SavedServers } from '../accounts/savedServers.ts'
import { AppCore } from '../appCore.ts'
import { FakeClock, FakeIds, FakeLifecycle, FakeNetwork, MemoryDurableStore, MemorySecureStorage, settle } from '../platform/fakes.ts'
import type { EntityStore } from '../session/entityStore.ts'
import { readStateOf, snapshotOf } from '../testSupport.ts'
import { OTHER_SERVERS_CHECK_INTERVAL_MS, OtherServersUnread } from './otherServersUnread.ts'

const A = 'https://a.test'
const B = 'https://b.test'
const C = 'https://c.test'
const paired = (url: string) => ({ url, token: `token-${url}`, deviceName: 'phone', deviceId: 'd', personName: null })
const unreadTotal = (store: EntityStore) => [...store.readStates.values()].reduce((sum, readState) => sum + readState.unreadCount, 0)

test('other servers are counted from one snapshot each, at most once a minute, and again on a later foreground', async () => {
  const secureStorage = new MemorySecureStorage()
  const network = new FakeNetwork()
  const clock = new FakeClock()
  const lifecycle = new FakeLifecycle()
  const ids = new FakeIds()
  const core = new AppCore({ secureStorage, durableStore: new MemoryDurableStore(), network, clock, lifecycle, ids })
  const servers = new SavedServers(secureStorage, ids)
  const a = await servers.add(paired(A))
  const c = await servers.add(paired(C)) // its snapshot fails: no route
  const b = await servers.add(paired(B))
  network.routeJson('GET', `${A}/v2/snapshot`, snapshotOf({ readStates: [readStateOf('chat-1', 2, 3), readStateOf('chat-2', 1, 1)] }))
  network.routeJson('GET', `${B}/v2/snapshot`, snapshotOf())
  await core.start()
  assert.equal(core.activeSession?.serverId, b.id)

  const unread = new OtherServersUnread({ core, unreadOf: unreadTotal })
  const stop = unread.start()
  const snapshotReads = () => network.requests.filter((request) => request.url === `${A}/v2/snapshot`).length

  await unread.checkIfDue()
  assert.deepEqual([...unread.counts], [[a.id, 4]], 'the open server is left out, and one that fails has no count')
  assert.equal(unread.counts.has(c.id), false)
  assert.equal(unread.checking, false)

  await unread.checkIfDue()
  lifecycle.comeToForeground()
  await settle()
  assert.equal(snapshotReads(), 1, 'not again within a minute')

  await clock.advance(OTHER_SERVERS_CHECK_INTERVAL_MS)
  lifecycle.comeToForeground()
  await settle()
  assert.equal(snapshotReads(), 2, 'a foreground a minute later checks again')
  stop()
  core.activeSession?.dispose()
})
