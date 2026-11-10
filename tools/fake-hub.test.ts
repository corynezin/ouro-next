import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { HostedServer, HostedServerList, HUB_API_PREFIX, HubError, SignupResult } from '@ouro/contract'
import { startFakeHub } from './fake-hub.ts'
import type { FakeHub } from './fake-hub.ts'

const STEP_MS = 40
let hub: FakeHub

before(async () => {
  hub = await startFakeHub({ port: 0, invites: ['alpha', 'beta'], stepMs: STEP_MS, serverAddress: 'http://127.0.0.1:9999', pairCommand: "printf 'code: ABCD-1234\\nlink: x\\n' | sed -n 's/^code: //p'" })
})
after(() => hub.close())

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${hub.url}${path.startsWith('/fake-hub') ? '' : HUB_API_PREFIX}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

const until = async <T>(what: string, probe: () => Promise<T | null>): Promise<T> => {
  const deadline = Date.now() + 5_000
  for (;;) {
    const found = await probe()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

test('an invite signs up once; its primary server provisions step by step, then is ready with a pairing code', async () => {
  const signup = await call('POST', '/signup', { invite: 'alpha', name: 'Alex' })
  assert.equal(signup.status, 200)
  const { token, name } = SignupResult.parse(signup.json)
  assert.equal(name, 'Alex')
  const again = await call('POST', '/signup', { invite: 'alpha', name: 'Sam' })
  assert.equal(again.status, 403)
  assert.equal(HubError.parse(again.json).error.code, 'invite_invalid')

  const seenSteps = new Set<string>()
  const ready = await until('the server ready', async () => {
    const { servers } = HostedServerList.parse((await call('GET', '/servers', undefined, token)).json)
    const primary = servers[0]!
    assert.equal(primary.primary, true)
    if (primary.status.state === 'provisioning') seenSteps.add(primary.status.step)
    return primary.status.state === 'ready' ? primary : null
  })
  assert.ok(seenSteps.size >= 2, `several steps were seen: ${[...seenSteps].join(', ')}`)
  assert.deepEqual(ready.status.state === 'ready' && { address: ready.status.address, code: ready.status.pairing?.code }, { address: 'http://127.0.0.1:9999', code: 'ABCD-1234' })

  await call('POST', `/fake-hub/paired/${ready.id}`)
  const paired = HostedServer.parse((await call('GET', `/servers/${ready.id}`, undefined, token)).json)
  assert.equal(paired.status.state === 'ready' && paired.status.pairing, null, 'a used code is gone')
})

test('another server can be made, and a failure planned for it is reported with its reason', async () => {
  const { token } = SignupResult.parse((await call('POST', '/signup', { invite: 'beta', name: 'Bo' })).json)
  await call('POST', '/fake-hub/fail-next', { step: 'install', why: 'Installing its tools failed.' })
  const created = await call('POST', '/servers', { label: 'Second' }, token)
  const second = HostedServer.parse(created.json)
  assert.equal(second.primary, false)
  const failed = await until('the failure', async () => {
    const server = HostedServer.parse((await call('GET', `/servers/${second.id}`, undefined, token)).json)
    return server.status.state === 'failed' ? server : null
  })
  assert.deepEqual(failed.status, { state: 'failed', why: 'Installing its tools failed.' })
  const { servers } = HostedServerList.parse((await call('GET', '/servers', undefined, token)).json)
  assert.deepEqual(servers.map((server) => server.label), ["Bo's computer", 'Second'], 'the primary first')
})

test('without a token, or with a bad request, the hub refuses in its error shape', async () => {
  const anonymous = await call('GET', '/servers')
  assert.equal(anonymous.status, 401)
  assert.equal(HubError.parse(anonymous.json).error.code, 'unauthenticated')
  const blank = await call('POST', '/signup', { invite: '', name: 'X' })
  assert.equal(blank.status, 400)
  assert.equal(HubError.parse(blank.json).error.code, 'invalid_request')
  const someoneElses = await call('GET', '/servers/srv-nope', undefined, 'not-a-token')
  assert.equal(someoneElses.status, 401)
})
