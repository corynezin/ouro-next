// Work an older release left stuck, on a host that pauses when idle: a crash loop's messages put back in the queue, as
// releases before failures were kept left them, wait for the next message and don't keep the host awake; and messages a
// refusal was taken for a passing failure on fail now as refusals, telling the person, rather than waiting forever.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { SleepingHost } from './sleeping-host.ts'

const run = new JourneyRun()
const host = new SleepingHost(run)
let phone: AppClient

before(async () => {
  await host.attach()
  await run.startServer()
  phone = await run.pairDevice()
})
after(async () => {
  await host.detach()
  await run.cleanup()
})

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })

async function readyAgent(name: string): Promise<void> {
  await phone.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => (await phone.agent(name)).state.state === 'idle', 30_000)
}

/** Its crash backoffs pass until automatic retries stop. */
async function gaveUp(name: string): Promise<void> {
  const giveUpAt = performance.now() + 60_000
  while (performance.now() < giveUpAt) {
    const { state } = await phone.agent(name)
    if (state.state === 'stopped' && state.stopped.reason === 'crash' && state.stopped.relaunch.kind === 'gave_up') return
    run.advanceClock(301_000)
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`timed out waiting for ${name} to give up`)
}

async function asleep(): Promise<void> {
  const giveUpAt = performance.now() + 30_000
  while (performance.now() < giveUpAt) {
    run.advanceClock(91_000)
    const slept = await waitFor('the host asleep', () => host.frozen && !host.held, 3_000).then(() => true, () => false)
    if (slept) return
  }
  throw new Error('timed out waiting for the host asleep')
}

test("a crash loop's messages left waiting don't keep the host awake; they wait for the next message", async () => {
  await readyAgent('looper')
  await send('looper', standInScript({ do: 'crash' }))
  await gaveUp('looper')
  await run.killServer()
  run.leaveFailedDeliveriesQueued('looper')
  await run.startServer()
  const looper = await phone.agent('looper')
  assert.equal(looper.queuedDeliveries, 1, 'left waiting')
  await asleep()
})

test('messages a refusal was taken for a passing failure on, left waiting, fail as refused at the next start, and the person hears why', async () => {
  await readyAgent('flagged')
  // As releases before refusals were told apart took one: a passing failure, retried until it gave up.
  const refusal = "API Error: Opus 5.5's safeguards flagged this message as a potential violation of our usage policy. [reasoning_extraction]"
  const { message } = await send('flagged', standInScript({ do: 'fail', failure: 'transient', detail: refusal, everyTime: true }))
  await gaveUp('flagged')
  await run.killServer()
  run.leaveFailedDeliveriesQueued('flagged')
  await run.startServer()

  const flagged = await phone.agent('flagged')
  assert.equal(flagged.queuedDeliveries, 0, 'not left waiting')
  const sent = (await phone.conversation('flagged')).find((candidate) => candidate.id === message.id)
  const delivery = sent?.deliveries[0]
  assert.equal(delivery?.state.state, 'undeliverable')
  assert.match(delivery?.state.state === 'undeliverable' ? delivery.state.reason : '', /the model refused it: .*safeguards flagged.*Rephrase it, or try another model/)
  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === snapshot.viewer.address))!
  const notices = (await phone.history(systemChat.id)).messages.map((notice) => notice.text).filter((text) => text.startsWith('flagged '))
  assert.equal(notices.length, 1, notices.join(' | '))
  assert.match(notices[0]!, /^flagged couldn't take a message: the model refused it: .*Rephrase it, or try another model\.$/)
  await asleep()
})
