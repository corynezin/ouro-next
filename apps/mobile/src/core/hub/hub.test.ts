import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignupResult } from '@ouro/contract'
import type { HostedServer } from '@ouro/contract'
import { FakeClock, FakeNetwork, settle } from '../platform/fakes.ts'
import { HubApi, interpretHubResponse } from './hubApi.ts'
import type { HubResult } from './hubApi.ts'
import { HostedServers } from './hostedServers.ts'
import { primaryOf, SETUP_COPY, SetupFlow } from './setupFlow.ts'

const HUB = 'https://hub.test'
const hostedServer = (status: HostedServer['status'], primary = true): HostedServer => ({ id: 's1', label: 'Alex', createdAt: 1, primary, status })

test('the hub client sends the token, and reads refusals, a revoked account and a proxy outage apart', async () => {
  const network = new FakeNetwork()
  const hub = new HubApi({ network, clock: new FakeClock() }, `${HUB}/`)
  network.routeJson('POST', '/hub/v1/signup', { accountId: 'a1', token: 'tok', name: 'Alex' })
  assert.deepEqual(await hub.signup({ invite: ' alpha ', name: 'Alex' }), { ok: true, value: { accountId: 'a1', token: 'tok', name: 'Alex' } })
  assert.deepEqual(network.bodiesTo('/signup'), [{ invite: 'alpha', name: 'Alex' }])
  assert.equal(network.requests[0]!.url, `${HUB}/hub/v1/signup`)

  network.routeJson('GET', '/hub/v1/servers', { servers: [hostedServer({ state: 'provisioning', step: 'install' })] })
  const listed = await hub.listServers('tok')
  assert.ok(listed.ok)
  assert.equal(network.requests.at(-1)!.headers.authorization, 'Bearer tok')

  network.routeJson('POST', '/hub/v1/signup', { error: { code: 'invite_invalid', message: 'That invite was used already.', retryable: false } }, 403)
  assert.deepEqual(await hub.signup({ invite: 'x', name: 'A' }), { ok: false, failure: { kind: 'refused', code: 'invite_invalid', message: 'That invite was used already.', retryable: false } })
  network.routeJson('GET', '/hub/v1/servers', { error: { code: 'unauthenticated', message: 'no', retryable: false } }, 401)
  assert.deepEqual(await hub.listServers('old'), { ok: false, failure: { kind: 'unauthenticated' } })
  network.route('GET', '/hub/v1/servers', () => ({ status: 502, text: '<html>Bad gateway</html>' }))
  assert.deepEqual(await hub.listServers('tok'), { ok: false, failure: { kind: 'unreachable', reason: 'HTTP 502' } })
  network.routeJson('GET', '/hub/v1/servers', { servers: 'nope' })
  assert.deepEqual(await hub.listServers('tok'), { ok: false, failure: { kind: 'invalid_answer', status: 200 } })
})

function flowWith(answers: HubResult<HostedServer | null>[], pair: (address: string, code: string) => Promise<void> = async () => {}) {
  const clock = new FakeClock()
  const paired: string[] = []
  let reads = 0
  const flow = new SetupFlow({
    clock,
    read: async () => answers[Math.min(reads++, answers.length - 1)]!,
    pair: async (address, code) => { paired.push(`${address} ${code}`); await pair(address, code) },
    onChange: () => {},
  })
  return { clock, flow, paired, reads: () => reads }
}

test('setup follows the steps every 2 s, waits 5 s after no answer, and pairs itself once ready', async () => {
  const ready = hostedServer({ state: 'ready', address: 'https://s1.test', pairing: { code: 'C0DE', expiresAt: 9 } })
  const { clock, flow, paired, reads } = flowWith([
    { ok: true, value: null },
    { ok: true, value: hostedServer({ state: 'provisioning', step: 'install' }) },
    { ok: false, failure: { kind: 'unreachable', reason: 'offline' } },
    { ok: true, value: ready },
  ])
  flow.start()
  await settle()
  assert.deepEqual(flow.state, { stage: 'waiting', step: null })
  await clock.advance(2000)
  assert.deepEqual(flow.state, { stage: 'waiting', step: 'install' })
  await clock.advance(2000)
  assert.equal(reads(), 3)
  assert.deepEqual(flow.state, { stage: 'waiting', step: 'install' }, 'no error shown for a missed poll')
  await clock.advance(4999)
  assert.equal(reads(), 3)
  await clock.advance(1)
  assert.deepEqual(flow.state, { stage: 'done' })
  assert.deepEqual(paired, ['https://s1.test C0DE'])
  assert.equal(clock.pendingTimerCount, 0)
})

test('setup ends with the reason: revoked sign-up, failed server, already paired, a failed pairing', async () => {
  const cases: [HubResult<HostedServer | null>, string][] = [
    [{ ok: false, failure: { kind: 'unauthenticated' } }, SETUP_COPY.signedOut],
    [{ ok: false, failure: { kind: 'refused', code: 'internal', message: 'The hub is busy.', retryable: true } }, 'The hub is busy.'],
    [{ ok: true, value: hostedServer({ state: 'failed', why: 'No capacity in that region.' }) }, 'No capacity in that region.'],
    [{ ok: true, value: hostedServer({ state: 'ready', address: 'https://s1.test', pairing: null }) }, SETUP_COPY.alreadyPaired],
  ]
  for (const [answer, message] of cases) {
    const { flow } = flowWith([answer])
    flow.start()
    await settle()
    assert.deepEqual(flow.state, { stage: 'failed', message })
  }
  const ready = hostedServer({ state: 'ready', address: 'https://s1.test', pairing: { code: 'C0DE', expiresAt: 9 } })
  const { flow } = flowWith([{ ok: true, value: ready }], async () => { throw new Error('That code has expired.') })
  flow.start()
  await settle()
  assert.deepEqual(flow.state, { stage: 'failed', message: 'Connecting this phone failed: That code has expired.' })
})

test('Try again starts over, and stopping drops an answer still on its way', async () => {
  const { clock, flow, reads } = flowWith([{ ok: true, value: hostedServer({ state: 'provisioning', step: 'create' }) }])
  flow.start()
  await settle()
  flow.stop()
  await clock.advance(10_000)
  assert.equal(reads(), 1)
  flow.start()
  await settle()
  assert.equal(reads(), 2)
  assert.equal(clock.pendingTimerCount, 1)
  flow.stop()
})

test('the primary server is the one made at sign-up', () => {
  const other = { ...hostedServer({ state: 'provisioning', step: 'create' }, false), id: 's2' }
  assert.equal(primaryOf([other, hostedServer({ state: 'provisioning', step: 'create' })])?.id, 's1')
  assert.equal(primaryOf([other]), null)
})

test('whether the hub can make servers is remembered for five minutes, per account; the list itself is read each time', async () => {
  const network = new FakeNetwork()
  const clock = new FakeClock()
  const hosted = new HostedServers(new HubApi({ network, clock }, HUB), clock)
  const account = { accountId: 'a1', token: 'tok', name: 'Alex' }
  network.route('GET', '/hub/v1/servers', () => ({ status: 503, text: '' }))
  assert.deepEqual(await hosted.load(account), { available: false, servers: [] })
  network.routeJson('GET', '/hub/v1/servers', { servers: [hostedServer({ state: 'provisioning', step: 'create' })] })
  const asked = network.requests.length
  assert.deepEqual(await hosted.load(account), { available: false, servers: [] })
  assert.equal(network.requests.length, asked, 'not asked again while the answer is remembered')
  assert.equal((await hosted.load({ ...account, accountId: 'a2' })).available, true, 'another account is checked afresh')

  await clock.advance(5 * 60_000)
  assert.equal((await hosted.load(account)).available, true)
  network.route('GET', '/hub/v1/servers', () => ({ status: 503, text: '' }))
  assert.deepEqual(await hosted.load(account), { available: true, servers: [] }, 'the button stays; the list is empty for now')
})

test("a refusal with a code this app doesn't know, as a full hub's 503, is the hub's refusal with its message", () => {
  const message = 'This hub has no room for another computer right now. Your invite code still works: try it again later.'
  const answer = interpretHubResponse(503, JSON.stringify({ error: { code: 'hub_full', message, retryable: true } }), SignupResult)
  assert.deepEqual(answer, { ok: false, failure: { kind: 'refused', code: 'hub_full', message, retryable: true } })
  assert.deepEqual(interpretHubResponse(503, '<html>Service Unavailable</html>', SignupResult), { ok: false, failure: { kind: 'unreachable', reason: 'HTTP 503' } }, "a proxy's own 503 is still unreachable")
})
