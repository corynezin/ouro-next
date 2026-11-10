// Snoozes and reminders of an ask from an agent on another computer, through two real servers and a fake APNs gateway.
// The snooze is the ask's, kept by its own computer: snoozed from either computer, it shows on both, and its end there
// reaches the copy. Each computer reminds the phones it pushes, by the same rules, so a phone paired with both is
// reminded once, by the agent's own computer. A snooze until quiet hours end is until their next end.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import type { AskSnooze, RemoteAskEntity } from '@ouro/contract'
import { quietHoursEndAfter } from '../server/src/domain/push.ts'
import { BUNDLE_ID, FakeApns } from './fake-apns.ts'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const BOTH_TOKEN = 'c3'.repeat(32)
const ALPHA_ONLY_TOKEN = 'd4'.repeat(32)

const apns = new FakeApns()
let alpha: JourneyRun
let beta: JourneyRun
/** One phone, paired with both computers. */
let phoneAtAlpha: AppClient
let phoneAtBeta: AppClient
/** Paired only with alpha, where the copies are. */
let tabletAtAlpha: AppClient

before(async () => {
  await apns.start()
  alpha = new JourneyRun({ env: apns.runEnv() })
  beta = new JourneyRun({ env: apns.runEnv() })
  apns.addKeyTo(alpha)
  apns.addKeyTo(beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  phoneAtAlpha = await alpha.pairDevice('phone')
  phoneAtBeta = await beta.pairDevice('phone')
  tabletAtAlpha = await alpha.pairDevice('tablet')
  await phoneAtAlpha.command('register_push_token', { token: BOTH_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await phoneAtBeta.command('register_push_token', { token: BOTH_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await tabletAtAlpha.command('register_push_token', { token: ALPHA_ONLY_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  const invite = await phoneAtAlpha.command('create_computer_invite', {})
  await phoneAtBeta.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
  apns.close()
})

// Both servers read their clocks through the same offset, so their signed requests stay within each other's skew.
let clockOffsetMs = 0
const timePasses = (byMs: number) => { clockOffsetMs += byMs; alpha.advanceClock(byMs); beta.advanceClock(byMs) }
const serverNow = () => Date.now() + clockOffsetMs

const settle = () => new Promise((done) => setTimeout(done, 1_500))
const pushesOf = (text: string, token: string) => apns.pushed.filter((push) => push.token === token && (push.aps.alert as { body?: string } | undefined)?.body === text)

/** An agent on beta asks the person, who talks to it from alpha; answers the copy at alpha once it and its push are there. */
async function askFromBeta(name: string, question: string): Promise<RemoteAskEntity> {
  await phoneAtBeta.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => (await phoneAtBeta.agent(name)).state.state === 'idle', 30_000)
  await waitFor(`${name}@beta at alpha`, async () => (await phoneAtAlpha.snapshot()).remoteAgents.some((agent) => agent.address === `${name}@beta`), 30_000)
  await phoneAtAlpha.command('send_message', { to: `${name}@beta`, text: standInScript({ do: 'run', command: `ouro ask human --blocked "${question}"` }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const copy = await waitFor('the copy at alpha', async () => (await tabletAtAlpha.snapshot()).remoteAsks.find((found) => found.text === question) ?? null, 30_000)
  await waitFor('the copy pushed to the tablet', () => pushesOf(question, ALPHA_ONLY_TOKEN).length === 1, 30_000)
  await waitFor(`${name} idle after asking`, async () => (await phoneAtBeta.agent(name)).state.state === 'idle', 30_000)
  return copy
}

/** The phone paired with both was pushed twice, as it came and as the reminder, both times by beta. */
async function pushedByBetaOnly(text: string): Promise<void> {
  const toBoth = pushesOf(text, BOTH_TOKEN)
  assert.equal(toBoth.length, 2, `the phone paired with both, once each time, not ${toBoth.length} pushes`)
  const betaDeviceId = (await phoneAtBeta.snapshot()).viewer.deviceId
  assert.ok(toBoth.every((push) => push.ouro.deviceId === betaDeviceId), "by the agent's own computer")
}

const snoozeThere = async (askId: string) => (await phoneAtBeta.snapshot()).asks.find((ask) => ask.id === askId)?.snooze
const snoozeHere = async (askId: string) => (await tabletAtAlpha.snapshot()).remoteAsks.find((ask) => ask.id === askId)?.snooze
const same = (a: AskSnooze | null | undefined, b: AskSnooze | null) => JSON.stringify(a) === JSON.stringify(b)

test("a copy snoozed here is snoozed on the ask's own computer, and taking it off there shows here", async () => {
  const copy = await askFromBeta('sleeper', 'Snooze me?')
  const snooze: AskSnooze = { kind: 'until', at: serverNow() + 3_600_000 }
  const answered = await tabletAtAlpha.command('snooze_ask', { askId: copy.id, snooze })
  assert.ok('remoteAsk' in answered)
  assert.deepEqual(answered.remoteAsk.snooze, snooze, 'shown here at once')
  assert.deepEqual(await snoozeThere(copy.id), snooze, 'kept there')

  await assert.rejects(tabletAtAlpha.command('snooze_ask', { askId: copy.id, snooze: { kind: 'until', at: serverNow() + 8 * 86_400_000 } }),
    (error: { code?: string }) => error.code === 'invalid_request', 'refused there as it would be here')

  await phoneAtBeta.command('snooze_ask', { askId: copy.id, snooze: null })
  await waitFor('the snooze off at alpha', async () => same(await snoozeHere(copy.id), null), 30_000)
})

test("a snooze until it's done ends when the agent stops there, and that is the reminder here", async () => {
  const copy = await askFromBeta('worker', 'Tell me when done?')
  await tabletAtAlpha.command('snooze_ask', { askId: copy.id, snooze: { kind: 'agent_done_or_idle' } })
  await phoneAtBeta.command('stop_agent', { agentId: (await phoneAtBeta.agent('worker')).id })
  await waitFor('the snooze ended at alpha', async () => same(await snoozeHere(copy.id), null), 30_000)
  await waitFor('reminded on the tablet', () => pushesOf('Tell me when done?', ALPHA_ONLY_TOKEN).length === 2, 30_000)
  await settle()
  await pushedByBetaOnly('Tell me when done?')
})

test("a snooze until the person is back ends when they read the copy's computer", async () => {
  const copy = await askFromBeta('patient', 'When you are back?')
  const answered = await tabletAtAlpha.command('snooze_ask', { askId: copy.id, snooze: { kind: 'person_back' } })
  assert.ok('remoteAsk' in answered)
  assert.deepEqual(answered.remoteAsk.snooze, { kind: 'person_back' })
  // Reading alpha's state is being back. Nothing reads beta's meanwhile, which would end it there by itself: the copy's
  // snooze goes only when beta, told by alpha, ends it and says so.
  await waitFor('the snooze ended, as beta tells alpha', async () => same(await snoozeHere(copy.id), null), 30_000)
  assert.equal(await snoozeThere(copy.id), null)
})

test("a snooze until quiet hours end is until their next end, by the snoozing computer's settings, and refused without any", async () => {
  const copy = await askFromBeta('night', 'After the night?')
  const quietHours = { start: '22:00', end: '07:00', timeZone: 'UTC' }
  await tabletAtAlpha.command('set_notification_settings', { ...DEFAULT_NOTIFICATION_SETTINGS, quietHours })
  try {
    const answered = await tabletAtAlpha.command('snooze_ask', { askId: copy.id, snooze: { kind: 'quiet_hours_end' } })
    const until: AskSnooze = { kind: 'until', at: quietHoursEndAfter(quietHours, serverNow()) }
    assert.ok('remoteAsk' in answered)
    assert.deepEqual(answered.remoteAsk.snooze, until)
    assert.deepEqual(await snoozeThere(copy.id), until, 'kept there as the time')
    // Beta has no quiet hours set for the person, so there it can't be asked for.
    await assert.rejects(phoneAtBeta.command('snooze_ask', { askId: copy.id, snooze: { kind: 'quiet_hours_end' } }), (error: { code?: string }) => error.code === 'invalid_request')
  } finally {
    await tabletAtAlpha.command('set_notification_settings', DEFAULT_NOTIFICATION_SETTINGS)
  }
})

test("an unanswered copy is reminded after its level's interval, to the phones its own computer doesn't push", async () => {
  await askFromBeta('waiter', 'Still there?')
  assert.equal(pushesOf('Still there?', BOTH_TOKEN).length, 1)
  timePasses(31 * 60_000)
  await waitFor('reminded on the tablet', () => pushesOf('Still there?', ALPHA_ONLY_TOKEN).length === 2, 30_000)
  await waitFor('reminded on the phone paired with both', () => pushesOf('Still there?', BOTH_TOKEN).length === 2, 30_000)
  await settle()
  await pushedByBetaOnly('Still there?')
  assert.equal(pushesOf('Still there?', ALPHA_ONLY_TOKEN).length, 2)
})
