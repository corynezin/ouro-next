// Tailscale on a host that pauses when idle, as a Sprite does: while the login waits for the person, the server holds
// the host awake, so the login can finish when they approve it elsewhere; once it has, the host may sleep again.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { TailscaleStatus } from '@ouro/contract'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { SleepingHost } from './sleeping-host.ts'

const run = new JourneyRun()
const host = new SleepingHost(run)
let phone: AppClient
before(async () => {
  await host.attach()
  await run.startServer()
  phone = await run.pairDevice()
  mkdirSync(run.tailscaleDir, { recursive: true })
})
after(async () => {
  await host.detach()
  await run.cleanup()
})

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function asleep(): Promise<void> {
  const giveUpAt = performance.now() + 30_000
  while (performance.now() < giveUpAt) {
    run.advanceClock(91_000)
    const slept = await waitFor('the host asleep', () => host.frozen && !host.held, 3_000).then(() => true, () => false)
    if (slept) return
  }
  throw new Error('timed out waiting for the host asleep')
}

test('the host stays awake while the login waits for the person, and sleeps once it has finished', async () => {
  await asleep()
  const connect = await phone.tailscale('POST')
  assert.equal(connect.status, 200, JSON.stringify(connect.body))
  await waitFor('the login link', async () => TailscaleStatus.parse((await phone.tailscale('GET')).body).tailscale.state === 'logging_in')

  // Nobody asks after it now; past the grace after any other work, the waiting login alone keeps the host up.
  run.advanceClock(91_000)
  await pause(2_000)
  run.advanceClock(91_000)
  await pause(2_000)
  assert.ok(host.held, 'held through the wait')
  assert.ok(!host.frozen, 'awake through the wait')

  // The person approves from their own browser; the server notices on its own, without being asked, and lets go.
  writeFileSync(join(run.tailscaleDir, 'approved'), '')
  await asleep()
  assert.deepEqual(TailscaleStatus.parse((await phone.tailscale('GET')).body).tailscale, { state: 'connected', ip: '100.64.0.7' })
})
