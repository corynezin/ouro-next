// A computer whose host pauses when idle, as a Sprite does: it sleeps when it has nothing to do and the other computer's
// chatter doesn't wake it; a message wakes it, it holds itself awake through the work and lets go after; a hold it can't
// get refuses the work, retryably, rather than taking it and losing it; and two such computers don't wake each other.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { SleepingHost } from './sleeping-host.ts'
import type { HostEvent } from './sleeping-host.ts'

let alpha: JourneyRun
let beta: JourneyRun
let betaHost: SleepingHost
let alphaPhone: AppClient
let betaPhone: AppClient

/** Pairs two computers, the second joining the first. */
async function joined(first: AppClient, second: AppClient, firstRun: JourneyRun): Promise<void> {
  const invite = await first.command('create_computer_invite', {})
  await second.command('join_computer', { address: firstRun.url, code: invite.command.split(' ').at(-1)! })
}

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  betaHost = new SleepingHost(beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await betaHost.attach()
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  await joined(alphaPhone, betaPhone, alpha)
  await betaPhone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'worker', model: 'stand-in', folder: null })
  await waitFor('worker idle', async () => (await betaPhone.agent('worker')).state.state === 'idle', 30_000)
})
after(async () => {
  await betaHost.detach()
  await alpha.cleanup()
  await beta.cleanup()
})

const send = (phone: AppClient, to: string, text: string, wake: 'wake' | 'fyi' = 'wake') => phone.command('send_message', { to, text, attachmentIds: [], wake, answersAskId: null })
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const eventsSince = (host: SleepingHost, mark: number, event: HostEvent) => host.events.slice(mark).filter((candidate) => candidate === event).length

/** Time passes for both computers alike: their signed requests carry the time, and must agree on it. */
function timePasses(ms: number): void {
  alpha.advanceClock(ms)
  beta.advanceClock(ms)
}

/** After its last work, the server lets go once its grace has passed on its own clock; then the host pauses it. What the
 * phone sees can come before the work behind it ends (a turn finishing, a copy reaching the other computer), and grace
 * counts from that end, so time passes again until it lets go. */
async function asleep(host: SleepingHost): Promise<void> {
  const giveUpAt = performance.now() + 30_000
  while (performance.now() < giveUpAt) {
    timePasses(91_000)
    const slept = await waitFor('the host asleep', () => host.frozen && !host.held, 3_000).then(() => true, () => false)
    if (slept) return
  }
  throw new Error('timed out waiting for the host asleep')
}

test("an idle computer sleeps, and the other computer's hellos don't wake it", async () => {
  await waitFor('worker idle, with nothing waiting', async () => {
    const worker = await betaPhone.agent('worker')
    return worker.state.state === 'idle' && worker.queuedDeliveries === 0
  })
  await asleep(betaHost)
  const mark = betaHost.events.length
  // Alpha says hello to its other computers every 2 seconds; this one it leaves alone.
  await pause(8_000)
  assert.equal(eventsSince(betaHost, mark, 'thaw'), 0, 'nothing woke it')
  assert.ok(betaHost.frozen)
})

test('a message wakes it; it holds itself awake through a long turn, renewing, and lets go after', async () => {
  await asleep(betaHost)
  const mark = betaHost.events.length
  const { message } = await send(alphaPhone, 'worker@beta', standInScript({ do: 'barrier', name: 'long-turn' }, { do: 'run', command: 'ouro reply "finished the long turn"' }))
  await waitFor('worker in its turn', () => beta.barrierReached('long-turn'), 30_000)
  assert.ok(eventsSince(betaHost, mark, 'thaw') >= 1, 'the message woke it')
  assert.ok(eventsSince(betaHost, mark, 'hold') >= 1, 'it held itself awake before taking the message')

  // Nothing is open to it now, yet it stays up: the turn holds it, and the hold is renewed before it would expire.
  const holdsBefore = eventsSince(betaHost, mark, 'hold')
  timePasses(61_000)
  await waitFor('the hold renewed', () => eventsSince(betaHost, mark, 'hold') > holdsBefore)
  await pause(1_000)
  assert.ok(!betaHost.frozen, 'awake through the turn')

  beta.releaseBarrier('long-turn')
  // The owner is the same person on each computer; the agent's answer to them is in its conversation where it lives.
  const answered = await waitFor('the answer', async () => (await betaPhone.conversation('worker')).find((candidate) => candidate.text === 'finished the long turn'), 30_000)
  assert.equal(answered.from, 'worker')
  assert.ok((await betaPhone.conversation('worker')).some((candidate) => candidate.id === message.id))
  await asleep(betaHost)
  assert.ok(eventsSince(betaHost, mark, 'release') >= 1, 'it let go once the work was done')
})

test('an FYI is taken without holding the computer awake', async () => {
  await asleep(betaHost)
  const mark = betaHost.events.length
  const { message } = await send(alphaPhone, 'worker@beta', 'for when you next look', 'fyi')
  await waitFor('accepted at beta', async () => (await alphaPhone.conversation('worker@beta')).find((candidate) => candidate.id === message.id)?.remoteDeliveries[0]?.state.state === 'accepted', 30_000)
  await waitFor('asleep again', () => betaHost.frozen, 30_000)
  assert.equal(eventsSince(betaHost, mark, 'hold'), 0, 'no hold for an FYI')
})

test("a hold it can't get refuses the work, retryably, and the work goes through once it can; stopping still works", async () => {
  betaHost.refuseHolds = true
  try {
    const mark = betaHost.events.length
    // The journey's client tries a retryable refusal again, as a person would with Retry; each is refused until it can hold.
    const sending = send(betaPhone, 'worker', `from the phone\n${standInScript({ do: 'run', command: 'ouro reply "phone answered"' })}`)
    await waitFor('a hold refused', () => eventsSince(betaHost, mark, 'hold_refused') >= 1)
    const raw = await fetch(`${beta.url}/v2/commands/send_message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${betaPhone.token}` },
      body: JSON.stringify({ idempotencyKey: 'sleeping-refused-once', input: { to: 'worker', text: 'refused', attachmentIds: [], wake: 'wake', answersAskId: null } }),
    })
    assert.equal(raw.status, 503)
    assert.deepEqual(((await raw.json()) as { error: { code: string; retryable: boolean } }).error, { code: 'host_hold_refused', message: "beta couldn't stay awake for it; try again", retryable: true })
    assert.ok(!(await betaPhone.conversation('worker')).some((candidate) => candidate.text === 'refused' || candidate.text.startsWith('from the phone')), 'nothing was taken')

    const { message: fromAlpha } = await send(alphaPhone, 'worker@beta', `from alpha\n${standInScript({ do: 'run', command: 'ouro reply "alpha answered"' })}`)
    await waitFor('alpha told to try again later', async () => {
      const state = (await alphaPhone.conversation('worker@beta')).find((candidate) => candidate.id === fromAlpha.id)?.remoteDeliveries[0]?.state
      return state?.state === 'queued' && state.attempts >= 1
    }, 30_000)

    await betaPhone.command('stop_agent', { agentId: (await betaPhone.agent('worker')).id })
    await waitFor('worker stopped', async () => (await betaPhone.agent('worker')).state.state === 'stopped')
    betaHost.refuseHolds = false
    await sending
    await waitFor('the phone answered', async () => (await betaPhone.conversation('worker')).find((candidate) => candidate.text === 'phone answered'), 30_000)
    await waitFor('alpha answered', async () => (await betaPhone.conversation('worker')).find((candidate) => candidate.text === 'alpha answered'), 60_000)
    assert.equal((await alphaPhone.conversation('worker@beta')).find((candidate) => candidate.id === fromAlpha.id)?.remoteDeliveries[0]?.state.state, 'accepted')
  } finally {
    betaHost.refuseHolds = false
  }
})

test("two computers that both sleep don't wake each other", async () => {
  const gamma = new JourneyRun()
  const delta = new JourneyRun()
  const gammaHost = new SleepingHost(gamma)
  const deltaHost = new SleepingHost(delta)
  try {
    gamma.addServerEnv({ OURO_MACHINE_NAME: 'gamma' })
    delta.addServerEnv({ OURO_MACHINE_NAME: 'delta' })
    await Promise.all([gammaHost.attach(), deltaHost.attach()])
    await Promise.all([gamma.startServer(), delta.startServer()])
    const gammaPhone = await gamma.pairDevice()
    const deltaPhone = await delta.pairDevice()
    await joined(gammaPhone, deltaPhone, gamma)
    await waitFor('each has heard from the other', async () => (await gammaPhone.snapshot()).computers[0]?.release !== null && (await deltaPhone.snapshot()).computers[0]?.release !== null)
    await waitFor('both asleep', () => gammaHost.frozen && deltaHost.frozen, 30_000)
    const marks = [gammaHost.events.length, deltaHost.events.length] as const
    await pause(8_000)
    assert.equal(eventsSince(gammaHost, marks[0], 'thaw'), 0, 'gamma slept on')
    assert.equal(eventsSince(deltaHost, marks[1], 'thaw'), 0, 'delta slept on')
  } finally {
    await Promise.all([gammaHost.detach(), deltaHost.detach()])
    await gamma.cleanup()
    await delta.cleanup()
  }
})
