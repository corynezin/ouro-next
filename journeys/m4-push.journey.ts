// Push notifications through the real server against a fake APNs gateway: what is pushed, how loud, the provider token,
// reminders that survive a restart without a burst, dead tokens, and the silent update push.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { NotificationSettings } from '@ouro/contract'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import { BUNDLE_ID, FakeApns, KEY_ID, TEAM_ID } from './fake-apns.ts'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const PHONE_TOKEN = 'a1'.repeat(32)
const TABLET_TOKEN = 'b2'.repeat(32)

const apns = new FakeApns()
const { pushed, goneTokens } = apns

let run: JourneyRun
let phone: AppClient
let tablet: AppClient
before(async () => {
  await apns.start()
  run = new JourneyRun({ env: apns.runEnv() })
  apns.addKeyTo(run)
  await run.startServer()
  phone = await run.pairDevice('phone')
  tablet = await run.pairDevice('tablet')
  assert.deepEqual(await phone.command('register_push_token', { token: PHONE_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID }), { apnsConfigured: true })
  await tablet.command('register_push_token', { token: TABLET_TOKEN, environment: 'production', bundleId: BUNDLE_ID })
})
after(async () => {
  await run.cleanup()
  apns.close()
})

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const settle = () => new Promise((done) => setTimeout(done, 700))
const serverNow = () => Date.now() + (existsSync(run.clockFile) ? Number(readFileSync(run.clockFile, 'utf8')) : 0)
const toPhone = (since: number) => pushed.slice(since).filter((push) => push.token === PHONE_TOKEN)
const about = (agentId: string, since: number) => toPhone(since).filter((push) => 'agentId' in push.ouro.subject && push.ouro.subject.agentId === agentId)

async function useSettings(changes: Partial<NotificationSettings>): Promise<void> {
  await phone.command('set_notification_settings', { ...DEFAULT_NOTIFICATION_SETTINGS, ...changes })
}

/** An agent that has answered its task, and the push about that answer already sent. */
async function readyAgent(name: string): Promise<string> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  await waitFor(`${name} to go idle`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 })
  await settle()
  return (await phone.agent(name)).id
}

async function agentAsks(agentName: string, flags: string, question: string) {
  const since = pushed.length
  await send(agentName, standInScript({ do: 'run', command: `ouro ask human ${flags} "${question}"` }))
  const ask = await waitFor(`${agentName}'s question`, async () => (await phone.snapshot()).asks.find((candidate) => candidate.text === question))
  return { ask, since }
}

test("an agent's reply is pushed to every phone of the person, signed and addressed as APNs needs, and settings sync", async () => {
  await useSettings({})
  const { id: personId, ...synced } = (await tablet.snapshot()).notificationSettings
  assert.deepEqual(synced, DEFAULT_NOTIFICATION_SETTINGS)
  assert.equal((await phone.snapshot()).notificationSettings.id, personId, "one person's settings, on both their devices")
  const since = pushed.length
  await phone.command('create_agent', { task: 'hello', name: 'greeter', model: null, folder: join(run.dir, 'greeter') })
  const [push] = await waitFor('the push to the phone', () => toPhone(since).length > 0 && toPhone(since))
  const agent = await phone.agent('greeter')
  const chatId = await phone.directChatWith('greeter')
  assert.deepEqual(push!.aps.alert, { title: 'greeter', body: 'stand-in received: hello' })
  assert.equal(push!.aps.sound, 'default')
  assert.equal(push!.aps['thread-id'], chatId)
  assert.equal(push!.aps['interruption-level'], 'active')
  assert.ok(Number(push!.aps.badge) >= 1, 'the badge counts the unread reply')
  assert.equal(push!.ouro.deviceId, phone.deviceId, 'which of the phone\'s servers it came from')
  assert.equal(push!.ouro.subject.kind, 'message')
  assert.deepEqual({ ...push!.ouro.subject, messageId: undefined }, { kind: 'message', chatId, messageId: undefined, agentId: agent.id })
  assert.equal(push!.headers['apns-topic'], BUNDLE_ID)
  assert.equal(push!.headers['apns-push-type'], 'alert')
  assert.equal(push!.headers['apns-collapse-id'], 'from:greeter')
  const tabletPush = await waitFor('the tablet too', () => pushed.slice(since).find((candidate) => candidate.token === TABLET_TOKEN))
  assert.equal(tabletPush.ouro.deviceId, tablet.deviceId)

  // The person's own message is never pushed back to them.
  assert.equal(toPhone(since).filter((candidate) => (candidate.aps.alert as { body: string }).body === 'hello').length, 0)

  // Another person's settings are theirs: a change syncs to all the person's devices.
  await useSettings({ burstSeconds: 120 })
  await waitFor('the tablet to see the change', async () => (await tablet.snapshot()).notificationSettings.burstSeconds === 120)
})

test('a burst from one agent is one banner, and the next is loud again once the burst is over', async () => {
  await useSettings({})
  const agentId = await readyAgent('chatty')
  const since = pushed.length
  await send('chatty', 'one')
  await waitFor('the first push', () => about(agentId, since).length === 1)
  await send('chatty', 'two')
  const second = (await waitFor('the second push', () => about(agentId, since).length === 2 && about(agentId, since)))[1]!
  assert.equal(second.aps.sound, undefined, 'quiet within the burst')
  assert.equal(second.aps['interruption-level'], 'passive')
  assert.equal(second.headers['apns-collapse-id'], 'from:chatty', 'and it replaces the first banner')
  run.advanceClock(61_000)
  await send('chatty', 'three')
  const third = (await waitFor('the third push', () => about(agentId, since).length === 3 && about(agentId, since)))[2]!
  assert.equal(third.aps.sound, 'default')
})

test('what needs me: asks, not every reply; muted agents and "nothing" push nothing', async () => {
  const agentId = await readyAgent('asker')
  await useSettings({ mode: 'needs_me' })
  let since = pushed.length
  await send('asker', 'just chatting')
  await waitFor('the reply', async () => (await phone.conversation('asker')).some((message) => message.text === 'stand-in received: just chatting'))
  await settle()
  assert.deepEqual(about(agentId, since), [], 'a reply is not pushed')

  const { ask, since: askedSince } = await agentAsks('asker', '', 'Tea or coffee?')
  const [askPush] = await waitFor('the ask push', () => about(agentId, askedSince).length > 0 && about(agentId, askedSince))
  assert.equal(askPush!.aps.category, 'ask', 'with the answer actions')
  assert.deepEqual(askPush!.ouro.subject, { kind: 'ask', askId: ask.id, chatId: await phone.directChatWith('asker'), agentId, agentAddress: 'asker' })
  assert.deepEqual(askPush!.aps.alert, { title: 'asker', body: 'Tea or coffee?' })
  await settle()
  assert.equal(about(agentId, askedSince).length, 1, 'the message posing the ask is not pushed a second time')

  await useSettings({ mutedAgentIds: [agentId] })
  since = pushed.length
  await agentAsks('asker', '--urgent', 'Muted question?')
  await settle()
  assert.deepEqual(about(agentId, since), [])

  await useSettings({ mode: 'nothing' })
  since = pushed.length
  await agentAsks('asker', '--urgent', 'Nothing question?')
  await settle()
  assert.deepEqual(about(agentId, since), [])
})

test('a group pushes only when it calls the person by name', async () => {
  await useSettings({ burstSeconds: 0 })
  await readyAgent('roomie')
  const { chat } = await phone.command('create_chat', { title: 'Push Room', members: ['roomie'] })
  const inRoom = (since: number) => toPhone(since).filter((push) => 'chatId' in push.ouro.subject && push.ouro.subject.chatId === chat.id)
  let since = pushed.length
  await phone.command('send_message', { to: 'roomie', text: standInScript({ do: 'run', command: "ouro send '#push-room' 'nothing for anyone'; ouro send '#push-room' '@human come and look'; ouro reply ok" }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const [push] = await waitFor('the mention push', () => inRoom(since).length > 0 && inRoom(since))
  assert.deepEqual(push!.aps.alert, { title: 'roomie in #push-room', body: '@human come and look' })
  assert.equal(push!.ouro.subject.kind === 'message' && push!.ouro.subject.agentId, null, 'a room is routed by chat')
  await settle()
  assert.equal(inRoom(since).length, 1, 'the post without a mention pushed nothing')
  since = pushed.length
  await phone.command('post_to_chat', { chatId: chat.id, text: '@human talking to myself', attachmentIds: [] })
  await settle()
  assert.equal(inRoom(since).length, 0, 'never for their own post')
  await useSettings({})
})

test('quiet hours are silent, and an urgent question breaks through as time-sensitive', async () => {
  const agentId = await readyAgent('nightowl')
  const hour = new Date(serverNow()).getUTCHours()
  const time = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`
  await useSettings({ quietHours: { start: time(hour - 1), end: time(hour + 2), timeZone: 'UTC' } })

  const { since } = await agentAsks('nightowl', '--blocked', 'Quietly blocked?')
  const [quiet] = await waitFor('the quiet push', () => about(agentId, since).length > 0 && about(agentId, since))
  assert.equal(quiet!.aps.sound, undefined)
  assert.equal(quiet!.aps['interruption-level'], 'passive')

  const { since: urgentSince } = await agentAsks('nightowl', '--urgent', 'Loudly urgent?')
  const [urgent] = await waitFor('the urgent push', () => about(agentId, urgentSince).length > 0 && about(agentId, urgentSince))
  assert.equal(urgent!.aps.sound, 'default')
  assert.equal(urgent!.aps['interruption-level'], 'time-sensitive')
  await useSettings({})
})

test('an unanswered question is pushed again after its interval, not again on restart, and when its snooze ends', async () => {
  await useSettings({ burstSeconds: 0 })
  const agentId = await readyAgent('waiter')
  const { ask, since } = await agentAsks('waiter', '--blocked', 'Deploy now?')
  await waitFor('the first push', () => about(agentId, since).length === 1)

  // A restart doesn't repeat it: when it was last pushed is stored.
  await run.killServer('SIGKILL')
  await run.startServer()
  await settle()
  assert.equal(about(agentId, since).length, 1)

  run.advanceClock(29 * 60_000)
  await settle()
  assert.equal(about(agentId, since).length, 1, 'not before 30 minutes for a blocking question')
  run.advanceClock(2 * 60_000)
  await waitFor('the reminder', () => about(agentId, since).length === 2)
  await settle()
  assert.equal(about(agentId, since).length, 2, 'one reminder, not one per tick')

  await phone.command('snooze_ask', { askId: ask.id, snooze: { kind: 'until', at: serverNow() + 10 * 60_000 } })
  run.advanceClock(9 * 60_000)
  await settle()
  assert.equal(about(agentId, since).length, 2, 'silent while snoozed')
  run.advanceClock(2 * 60_000)
  await waitFor('the push when the snooze ends', () => about(agentId, since).length === 3)
  await useSettings({})
})

test("a token APNs says is gone is dropped, and a phone can stop its own pushes", async () => {
  await useSettings({ burstSeconds: 0 })
  const agentId = await readyAgent('pinger')
  goneTokens.add(TABLET_TOKEN)
  let attemptsBefore = pushed.length
  await send('pinger', 'first')
  await waitFor('the phone push', () => about(agentId, attemptsBefore).length === 1)
  await settle()
  goneTokens.delete(TABLET_TOKEN)
  attemptsBefore = pushed.length
  await send('pinger', 'second')
  await waitFor('the phone push', () => about(agentId, attemptsBefore).length === 1)
  await settle()
  assert.equal(pushed.slice(attemptsBefore).filter((push) => push.token === TABLET_TOKEN).length, 0, 'the dead token is no longer used')

  await phone.command('clear_push_token', {})
  attemptsBefore = pushed.length
  await send('pinger', 'third')
  await waitFor('the reply', async () => (await phone.conversation('pinger')).some((message) => message.text === 'stand-in received: third'))
  await settle()
  assert.deepEqual(pushed.slice(attemptsBefore), [], 'no phone has a token now')

  await phone.command('register_push_token', { token: PHONE_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await tablet.command('register_push_token', { token: TABLET_TOKEN, environment: 'production', bundleId: BUNDLE_ID })
  await useSettings({})
})

for (const keyless of [{ case: 'no key', key: null }, { case: "a key that can't be read", key: 'not a key' }]) {
  test(`a server with ${keyless.case} runs, keeps the token and says it cannot push`, async () => {
    const other = new JourneyRun({ env: { OURO_APNS_KEY_ID: KEY_ID, OURO_APNS_TEAM_ID: TEAM_ID } })
    try {
      if (keyless.key !== null) {
        writeFileSync(join(other.dir, 'broken.p8'), keyless.key)
        other.addServerEnv({ OURO_APNS_KEY_FILE: join(other.dir, 'broken.p8') })
      }
      await other.startServer()
      const otherPhone = await other.pairDevice()
      assert.deepEqual(await otherPhone.command('register_push_token', { token: PHONE_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID }), { apnsConfigured: false })
      if (keyless.key !== null) {
        assert.match(other.log(), /"event":"push_unavailable"/)
        assert.ok(!other.log().includes(keyless.key), 'the key itself is never logged')
      }
    } finally {
      await other.cleanup()
    }
  })
}

test('a published phone update is a silent background push carrying the badge', async () => {
  const exportDir = join(run.dir, 'export')
  mkdirSync(join(exportDir, 'bundles'), { recursive: true })
  writeFileSync(join(exportDir, 'bundles', 'ios.js'), 'globalThis.update = 1\n')
  writeFileSync(join(exportDir, 'metadata.json'), JSON.stringify({ fileMetadata: { ios: { bundle: 'bundles/ios.js', assets: [] } } }))
  const since = pushed.length
  const registered = await new Promise<{ updateNumber: number }>((resolve, reject) => {
    const request = httpRequest({ socketPath: join(run.dataDir, 'local.sock'), path: '/v2/internal/updates', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => (response.statusCode === 200 ? resolve(JSON.parse(body) as { updateNumber: number }) : reject(new Error(body))))
    })
    request.end(JSON.stringify({ exportDir, runtimeVersion: '0.1.0', commit: null }))
  })
  const [push] = await waitFor('the update push', () => toPhone(since).length > 0 && toPhone(since))
  assert.deepEqual(push!.ouro, { deviceId: phone.deviceId, subject: { kind: 'update_available', updateNumber: registered.updateNumber } })
  assert.equal(push!.aps['content-available'], 1)
  assert.equal(push!.aps.alert, undefined)
  assert.equal(push!.aps.sound, undefined)
  assert.equal(typeof push!.aps.badge, 'number')
  assert.equal(push!.headers['apns-push-type'], 'background')
  assert.equal(push!.headers['apns-priority'], '5')
})

test("the badge counts only listed agents' chats, as the app does: an archived agent's unread reply drops out", async () => {
  await readyAgent('shelved')
  const shelved = await phone.agent('shelved')
  const shelvedChat = await phone.directChatWith('shelved')
  assert.ok(((await phone.snapshot()).readStates.find((state) => state.chatId === shelvedChat)?.unreadCount ?? 0) >= 1, 'its reply is unread')
  await phone.command('archive_agent', { agentId: shelved.id })
  const since = pushed.length
  await phone.command('create_agent', { task: 'after the shelf', name: 'unshelved', model: null, folder: join(run.dir, 'unshelved') })
  const [push] = await waitFor('the push about the new reply', () => toPhone(since).length > 0 && toPhone(since))
  const snapshot = await phone.snapshot()
  const listed = new Set(snapshot.agents.filter((agent) => agent.state.state !== 'archived').map((agent) => agent.name))
  const listedChats = new Set(snapshot.chats.filter((chat) => chat.kind === 'direct' && chat.members.some((member) => listed.has(member.address))).map((chat) => chat.id))
  const expected = snapshot.readStates.filter((state) => listedChats.has(state.chatId)).reduce((sum, state) => sum + state.unreadCount, 0)
  assert.equal(Number(push!.aps.badge), expected)
  assert.ok(!listedChats.has(shelvedChat))
})
