// One push per phone across computers, through two real servers and a fake APNs gateway: what an agent on another
// computer says or asks reaches the person's chat on both computers, and a phone paired with both is pushed once, by the
// agent's own computer; a phone paired only with the other computer is still pushed by it. A group post calling the person
// is pushed once to such a phone too, by the group's home, wherever it was written, even when the update carrying it is
// sent again after its answer was lost.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { PEER_API_PREFIX } from '@ouro/contract'
import { BUNDLE_ID, FakeApns } from './fake-apns.ts'
import type { Pushed } from './fake-apns.ts'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { NetworkLink } from './network-faults.ts'

const BOTH_TOKEN = 'c3'.repeat(32)
const ALPHA_ONLY_TOKEN = 'd4'.repeat(32)
const BETA_ONLY_TOKEN = 'e5'.repeat(32)

const apns = new FakeApns()
let alpha: JourneyRun
let beta: JourneyRun
/** One phone, paired with both computers. */
let phoneAtAlpha: AppClient
let phoneAtBeta: AppClient
/** Paired only with alpha. */
let tabletAtAlpha: AppClient
/** Paired only with beta. */
let tabletAtBeta: AppClient
/** In front of beta's peer address: what alpha sends it goes through here. */
const toBeta = new NetworkLink()

before(async () => {
  await apns.start()
  alpha = new JourneyRun({ env: apns.runEnv() })
  beta = new JourneyRun({ env: apns.runEnv() })
  apns.addKeyTo(alpha)
  apns.addKeyTo(beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta', OURO_PEER_ADDRESS: await toBeta.start() })
  await Promise.all([alpha.startServer(), beta.startServer()])
  toBeta.forwardTo(beta.url)
  phoneAtAlpha = await alpha.pairDevice('phone')
  phoneAtBeta = await beta.pairDevice('phone')
  tabletAtAlpha = await alpha.pairDevice('tablet')
  tabletAtBeta = await beta.pairDevice('tablet')
  await phoneAtAlpha.command('register_push_token', { token: BOTH_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await phoneAtBeta.command('register_push_token', { token: BOTH_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await tabletAtAlpha.command('register_push_token', { token: ALPHA_ONLY_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  await tabletAtBeta.command('register_push_token', { token: BETA_ONLY_TOKEN, environment: 'sandbox', bundleId: BUNDLE_ID })
  const invite = await phoneAtAlpha.command('create_computer_invite', {})
  await phoneAtBeta.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await toBeta.stop()
  await alpha.cleanup()
  await beta.cleanup()
  apns.close()
})

const settle = () => new Promise((done) => setTimeout(done, 1_500))
const saying = (text: string, token: string) => apns.pushed.filter((push) => push.token === token && (push.aps.alert as { body?: string } | undefined)?.body === text)

async function betaAgent(name: string): Promise<void> {
  await phoneAtBeta.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => (await phoneAtBeta.agent(name)).state.state === 'idle', 30_000)
  await waitFor(`${name}@beta at alpha`, async () => (await phoneAtAlpha.snapshot()).remoteAgents.some((agent) => agent.address === `${name}@beta`), 30_000)
}

/** The one push a phone paired with both got is beta's, and the phone paired only with alpha got alpha's. */
async function pushedOncePerPhone(text: string): Promise<void> {
  await waitFor(`"${text}" pushed to the tablet by alpha`, () => saying(text, ALPHA_ONLY_TOKEN).length > 0, 30_000)
  await settle()
  const toBoth: Pushed[] = saying(text, BOTH_TOKEN)
  assert.equal(toBoth.length, 1, `one push to the phone paired with both, not ${toBoth.length}`)
  assert.equal(toBoth[0]!.ouro.deviceId, (await phoneAtBeta.snapshot()).viewer.deviceId, "by the agent's own computer")
  assert.equal(saying(text, ALPHA_ONLY_TOKEN).length, 1)
}

test('a reply from an agent on another computer is pushed once to a phone paired with both', async () => {
  await betaAgent('replier')
  await phoneAtAlpha.command('send_message', { to: 'replier@beta', text: standInScript({ do: 'run', command: 'ouro reply "back to you"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await pushedOncePerPhone('back to you')
})

test('an ask from an agent on another computer is pushed once to a phone paired with both', async () => {
  await betaAgent('asker')
  await phoneAtAlpha.command('send_message', { to: 'asker@beta', text: standInScript({ do: 'run', command: 'ouro ask human --blocked "Ship it?"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await pushedOncePerPhone('Ship it?')
})

/** A group post calling the person: one push to the phone paired with both, from the group's home (alpha), and one to
 * each phone paired with only one computer. */
async function groupPostPushedOncePerPhone(text: string): Promise<void> {
  await waitFor(`"${text}" pushed to both tablets`, () => saying(text, ALPHA_ONLY_TOKEN).length > 0 && saying(text, BETA_ONLY_TOKEN).length > 0, 30_000)
  await settle()
  const toBoth = saying(text, BOTH_TOKEN)
  assert.equal(toBoth.length, 1, `one push to the phone paired with both, not ${toBoth.length}`)
  assert.equal(toBoth[0]!.ouro.deviceId, (await phoneAtAlpha.snapshot()).viewer.deviceId, "by the group's home")
  assert.equal(saying(text, ALPHA_ONLY_TOKEN).length, 1)
  assert.equal(saying(text, BETA_ONLY_TOKEN).length, 1)
}

test("a group post calling the person is pushed once to each phone, whether written at the group's home or on the other computer", async () => {
  await betaAgent('helper')
  await phoneAtAlpha.command('create_agent', { task: standInScript({ do: 'text', text: 'ready' }), name: 'planner', model: 'stand-in', folder: null })
  await waitFor('planner idle', async () => (await phoneAtAlpha.agent('planner')).state.state === 'idle', 30_000)
  const { chat } = await phoneAtAlpha.command('create_chat', { title: 'Across', members: ['helper@beta', 'planner'] })
  await waitFor('the copy at beta', async () => (await phoneAtBeta.snapshot()).chats.some((found) => found.id === chat.id), 30_000)
  const post = (text: string) => phoneAtAlpha.command('post_to_chat', { chatId: chat.id, text, attachmentIds: [] })

  await post(`@planner\n${standInScript({ do: 'run', command: 'ouro reply "@human written at home"' })}`)
  await groupPostPushedOncePerPhone('@human written at home')

  await post(`@helper@beta\n${standInScript({ do: 'run', command: 'ouro reply "@human written on beta"' })}`)
  await groupPostPushedOncePerPhone('@human written on beta')

  // The update carrying planner's next post reaches beta, but beta's answer is lost: alpha sends it again, and beta pushes
  // once.
  const lost = () => toBeta.events.filter((event) => event.path === `${PEER_API_PREFIX}/group-updates` && event.outcome === 'answer_lost')
  toBeta.loseAnswers(`${PEER_API_PREFIX}/group-updates`, 1, 'answer lost on the way back')
  // The shell writes the words, so only planner's post has them, not the person's that asks for it.
  await post(`@planner\n${standInScript({ do: 'run', command: 'ouro reply "@human answer $(echo lost) on the way back"' })}`)
  await waitFor("the update with planner's post lost once", () => lost().length === 1, 60_000)
  assert.equal(lost()[0]!.statuses[0], 200, 'beta had taken it')
  await groupPostPushedOncePerPhone('@human answer lost on the way back')
})
