import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PushPayload, PushSubject } from '@ouro/contract'
import { SavedServers } from '../accounts/savedServers.ts'
import { AppCore } from '../appCore.ts'
import { FakeClock, FakeIds, FakeLifecycle, FakeNetwork, FakePushPlatform, MemoryDurableStore, MemorySecureStorage, settle } from '../platform/fakes.ts'
import { agentOf, caughtUpFrame, directChatOf, messageOf, readStateOf, readStateUpsert, snapshotOf } from '../testSupport.ts'
import type { EntityStore } from '../session/entityStore.ts'
import { allowOutcomeText, NO_PUSH_TOKEN, placeOf, PUSH_TOKEN_WAIT_MS, PushCenter, pushPayloadOf, SNOOZE_FROM_NOTIFICATION_MS } from './pushCenter.ts'

const A = 'https://a.test'
const B = 'https://b.test'

const unreadTotal = (store: EntityStore) => [...store.chats.keys()].reduce((sum, chatId) => sum + (store.readStateOfChat(chatId)?.unreadCount ?? 0), 0)

async function setup() {
  const secureStorage = new MemorySecureStorage()
  const network = new FakeNetwork()
  const clock = new FakeClock()
  const lifecycle = new FakeLifecycle()
  const ids = new FakeIds()
  const deps = { secureStorage, durableStore: new MemoryDurableStore(), network, clock, lifecycle, ids }
  const snapshot = snapshotOf({
    agents: [agentOf({ id: 'a1', name: 'alice' })],
    chats: [directChatOf('c1', 'alice')],
    readStates: [readStateOf('c1', 0, 2)],
  })
  for (const url of [A, B]) {
    network.routeJson('GET', `${url}/v2/snapshot`, snapshot)
    network.routeJson('POST', `${url}/v2/commands/register_push_token`, { apnsConfigured: true })
  }
  const servers = new SavedServers(secureStorage, ids)
  const onA = await servers.add({ url: A, token: 'token-a', deviceName: 'phone', deviceId: 'device-on-a', personName: null })
  const onB = await servers.add({ url: B, token: 'token-b', deviceName: 'phone', deviceId: 'device-on-b', personName: null })
  await servers.setActiveId(onA.id)
  const core = new AppCore(deps)
  const platform = new FakePushPlatform()
  const updateChecks: number[] = []
  const center = new PushCenter({ core, platform, badgeCountOf: unreadTotal, checkForUpdate: () => updateChecks.push(clock.now()) })
  return { network, clock, lifecycle, core, platform, center, onA, onB, updateChecks }
}

type Context = Awaited<ReturnType<typeof setup>>

async function startLive(ctx: Context) {
  await ctx.core.start()
  ctx.center.start()
  await settle()
  ctx.network.lastStream.pushFrame(caughtUpFrame(0))
  await settle()
}

function finish(ctx: Context) {
  ctx.center.stop()
  ctx.core.activeSession?.dispose()
}

const registrationsTo = (ctx: Context, url: string) => ctx.network.requests.filter((r) => r.url === `${url}/v2/commands/register_push_token`).length
const push = (deviceId: string, subject: PushSubject): PushPayload => ({ deviceId, subject })
const messageInC1: PushSubject = { kind: 'message', chatId: 'c1', messageId: 'm1', agentId: 'a1' }
const askInC1: PushSubject = { kind: 'ask', askId: 'k1', chatId: 'c1', agentId: 'a1', agentAddress: 'alice' }

test('a push is read from its `ouro` object, and anything else is not ours', () => {
  const payload = push('d', messageInC1)
  assert.deepEqual(pushPayloadOf({ aps: { alert: 'hi' }, ouro: payload }), payload)
  assert.equal(pushPayloadOf({ aps: {} }), null)
  assert.equal(pushPayloadOf({ ouro: { deviceId: 'd', subject: { kind: 'future_kind' } } }), null)
})

test('a tap leads to the agent chat, or to the room for a group mention', () => {
  assert.deepEqual(placeOf(messageInC1), { kind: 'agent_chat', agentId: 'a1' })
  assert.deepEqual(placeOf({ kind: 'message', chatId: 'g1', messageId: 'm', agentId: null }), { kind: 'room', chatId: 'g1' })
  assert.deepEqual(placeOf(askInC1), { kind: 'agent_chat', agentId: 'a1' })
  assert.equal(placeOf({ kind: 'update_available', updateNumber: 3 }), null)
})

test('a phone that already allowed notifications registers once the stream is live, and once per session', async () => {
  const ctx = await setup()
  ctx.platform.currentPermission = 'granted'
  await ctx.core.start()
  ctx.center.start()
  await settle()
  assert.equal(registrationsTo(ctx, A), 0, 'not while connecting')
  ctx.network.lastStream.pushFrame(caughtUpFrame(0))
  await settle()
  assert.equal(registrationsTo(ctx, A), 1)
  assert.deepEqual(ctx.network.bodiesTo('/register_push_token').map((body) => (body as { input: unknown }).input), [{ token: 'ab'.repeat(32), environment: 'sandbox', bundleId: 'dev.test.ouro' }])
  ctx.network.lastStream.drop()
  await ctx.clock.advance(5000)
  ctx.network.lastStream.pushFrame(caughtUpFrame(0))
  await settle()
  assert.equal(registrationsTo(ctx, A), 1, 'a reconnect is the same session')
  assert.equal(ctx.platform.prompts, 0)
  finish(ctx)
})

test('without permission nothing registers and nothing prompts until the Settings button', async () => {
  const ctx = await setup()
  await startLive(ctx)
  assert.equal(registrationsTo(ctx, A), 0)
  assert.equal(ctx.platform.prompts, 0)
  const outcome = await ctx.center.allowOnThisPhone()
  assert.equal(allowOutcomeText(outcome), 'Notifications are on for this phone.')
  assert.equal(ctx.platform.prompts, 1)
  assert.equal(registrationsTo(ctx, A), 1)
  finish(ctx)
})

test('the Settings button says when iOS has notifications off, and when the server has no APNs key', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.platform.permissionAfterPrompt = 'denied'
  assert.equal(allowOutcomeText(await ctx.center.allowOnThisPhone()), 'Notifications are off for Ouro (Settings → Notifications).')
  assert.equal(registrationsTo(ctx, A), 0)
  ctx.platform.currentPermission = 'granted'
  ctx.network.routeJson('POST', `${A}/v2/commands/register_push_token`, { apnsConfigured: false })
  assert.equal(allowOutcomeText(await ctx.center.allowOnThisPhone()), 'This server has no APNs key yet, so it can’t send notifications.')
  finish(ctx)
})

test('the badge is agent unread on the active server, set only when it changes', async () => {
  const ctx = await setup()
  await startLive(ctx)
  assert.deepEqual(ctx.platform.badges, [2])
  ctx.network.lastStream.pushFrame(readStateUpsert(1, readStateOf('c1', 1, 2)))
  await settle()
  assert.deepEqual(ctx.platform.badges, [2], 'same count, no call')
  ctx.network.lastStream.pushFrame(readStateUpsert(2, readStateOf('c1', 3, 0)))
  await settle()
  assert.deepEqual(ctx.platform.badges, [2, 0])
  finish(ctx)
})

test('a push or a return to the app sets the badge again, since a push may have changed the icon', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.network.lastStream.pushFrame(readStateUpsert(1, readStateOf('c1', 3, 0)))
  await settle()
  assert.deepEqual(ctx.platform.badges, [2, 0])
  // Away, a push puts 1 on the icon; the message is read before the app counts it, so the count stays 0.
  ctx.lifecycle.goToBackground()
  ctx.center.received(push('device-on-a', messageInC1))
  assert.deepEqual(ctx.platform.badges, [2, 0, 0], 'a push resets the icon to the app’s count')
  ctx.lifecycle.comeToForeground()
  assert.deepEqual(ctx.platform.badges, [2, 0, 0, 0], 'so does coming back')
  finish(ctx)
})

test('a push about the chat on screen stays quiet, but only on that server and while the app is active', async () => {
  const ctx = await setup()
  await startLive(ctx)
  const session = ctx.core.activeSession!
  assert.equal(await ctx.center.shouldPresent(push('device-on-a', messageInC1)), true, 'not open')
  const close = session.openChat('c1')
  assert.equal(await ctx.center.shouldPresent(push('device-on-a', messageInC1)), false)
  assert.equal(await ctx.center.shouldPresent(push('device-on-b', messageInC1)), true, 'the same chat id on another server')
  ctx.lifecycle.goToBackground()
  assert.equal(await ctx.center.shouldPresent(push('device-on-a', messageInC1)), true)
  close()
  finish(ctx)
})

test('tapping a push from another server switches to it, then leaves where to go for navigation', async () => {
  const ctx = await setup()
  await startLive(ctx)
  let changes = 0
  ctx.center.subscribe(() => changes++)
  await ctx.center.responded(push('device-on-b', messageInC1), { kind: 'opened' })
  assert.equal(ctx.core.activeSession?.serverId, ctx.onB.id)
  assert.equal(changes, 1)
  assert.deepEqual(ctx.center.takeOpening(), { serverId: ctx.onB.id, place: { kind: 'agent_chat', agentId: 'a1' } })
  assert.equal(ctx.center.takeOpening(), null, 'taken once')
  await ctx.center.responded(push('a-device-this-phone-forgot', messageInC1), { kind: 'opened' })
  assert.equal(ctx.center.opening, null)
  finish(ctx)
})

test('Reply answers the ask through the outbox of the server that sent it, without switching', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.network.routeJson('POST', `${B}/v2/commands/send_message`, { message: messageOf({ seq: 1, chatId: 'c1', from: 'human' }) })
  await ctx.center.responded(push('device-on-b', askInC1), { kind: 'replied', text: '  yes, ship it ' })
  await settle()
  assert.equal(ctx.core.activeSession?.serverId, ctx.onA.id)
  const sent = ctx.network.requests.filter((r) => r.url === `${B}/v2/commands/send_message`).map((r) => JSON.parse(r.body!).input)
  assert.deepEqual(sent, [{ to: 'alice', text: 'yes, ship it', attachmentIds: [], wake: sent[0].wake, answersAskId: 'k1' }])
  await ctx.center.responded(push('device-on-b', askInC1), { kind: 'replied', text: '   ' })
  await settle()
  assert.equal(ctx.network.requests.filter((r) => r.url === `${B}/v2/commands/send_message`).length, 1, 'an empty reply sends nothing')
  finish(ctx)
})

test('Snooze 1 hour snoozes that ask on its own server', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.network.routeJson('POST', `${B}/v2/commands/snooze_ask`, { ask: {} }, 500)
  await ctx.center.responded(push('device-on-b', askInC1), { kind: 'snoozed' })
  const bodies = ctx.network.requests.filter((r) => r.url === `${B}/v2/commands/snooze_ask`).map((r) => JSON.parse(r.body!).input)
  assert.deepEqual(bodies, [{ askId: 'k1', snooze: { kind: 'until', at: ctx.clock.now() + SNOOZE_FROM_NOTIFICATION_MS } }])
  finish(ctx)
})

test('an update push asks for a check; it is never shown', async () => {
  const ctx = await setup()
  await startLive(ctx)
  const update = push('device-on-a', { kind: 'update_available', updateNumber: 7 })
  ctx.center.received(update)
  assert.equal(ctx.updateChecks.length, 1)
  assert.equal(await ctx.center.shouldPresent(update), false)
  ctx.center.received(push('device-on-a', messageInC1))
  assert.equal(ctx.updateChecks.length, 1)
  // Woken in the background by the silent push, it checks too, which downloads the update there.
  ctx.lifecycle.goToBackground()
  ctx.center.received(update)
  assert.equal(ctx.updateChecks.length, 2)
  finish(ctx)
})

test('removing a server asks it to stop pushing to this phone', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.network.routeJson('POST', `${B}/v2/commands/clear_push_token`, {})
  await ctx.core.removeServer(ctx.onB.id)
  await settle()
  assert.equal(ctx.network.requests.filter((r) => r.url === `${B}/v2/commands/clear_push_token`).length, 1)
  finish(ctx)
})

test('the Settings button still answers when iOS never hands over a push token', async () => {
  const ctx = await setup()
  await startLive(ctx)
  ctx.platform.tokenArrives = false
  const allowing = ctx.center.allowOnThisPhone()
  await settle()
  await ctx.clock.advance(PUSH_TOKEN_WAIT_MS)
  assert.equal(allowOutcomeText(await allowing), NO_PUSH_TOKEN)
  assert.equal(registrationsTo(ctx, A), 0)
  finish(ctx)
})
