import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeNetwork } from '../platform/fakes.ts'
import { buildUpdateManifest } from '@ouro/contract'
import { checkManifest } from './manifest.ts'

const ENDPOINT = { manifestUrl: 'https://home.test/updates/manifest', headers: {} }
const RUNTIME = { runtimeVersion: '0.1.0', platform: 'ios' as const }
// Built the way the server builds every manifest it serves.
const good = buildUpdateManifest({
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', createdAt: new Date('2026-11-09T10:00:00.000Z'), runtimeVersion: '0.1.0', updateNumber: 3, commit: null, machineId: 'machine-1',
  launchAsset: { hash: 'A'.repeat(43), url: 'https://home.test/updates/assets/bundle.js' },
  assets: [],
})

async function check(json: unknown, status = 200) {
  const network = new FakeNetwork()
  network.routeJson('GET', '/updates/manifest', json, status)
  const result = await checkManifest(network, ENDPOINT, RUNTIME)
  return { result, request: network.requests[0] }
}

test('a manifest built as the server builds it is valid, and the request says which runtime asks', async () => {
  const { result, request } = await check(good)
  assert.deepEqual(result, { kind: 'valid' })
  assert.equal(request?.headers['expo-runtime-version'], '0.1.0')
  assert.equal(request?.headers['expo-platform'], 'ios')
  assert.equal(request?.headers['expo-protocol-version'], '1')
  assert.equal(request?.headers.authorization, undefined, 'the route is open: no token')
})

test('the crash that was seen natively, a date without milliseconds, is refused here', async () => {
  const { result } = await check({ ...good, createdAt: '2026-11-09T10:00:00Z' })
  assert.equal(result.kind, 'invalid')
})

test('a missing launch asset, the wrong runtime, or not JSON is refused', async () => {
  const { launchAsset: _launchAsset, ...withoutLaunch } = good
  assert.equal((await check(withoutLaunch)).result.kind, 'invalid')
  assert.deepEqual((await check({ ...good, runtimeVersion: '9' })).result, { kind: 'invalid', reason: 'the manifest is for runtime 9' })
  const network = new FakeNetwork()
  network.route('GET', '/updates/manifest', () => ({ status: 200, text: '--boundary' }))
  assert.deepEqual(await checkManifest(network, ENDPOINT, RUNTIME), { kind: 'invalid', reason: 'the manifest is not JSON' })
})

test('nothing newer, a server error and no answer are told apart', async () => {
  assert.deepEqual((await check(null, 204)).result, { kind: 'none' })
  assert.deepEqual((await check({}, 500)).result, { kind: 'unreachable', reason: 'HTTP 500' })
  assert.deepEqual((await check({}, 404)).result, { kind: 'unreachable', reason: 'HTTP 404' }, 'a missing route is not "no update"')
  assert.equal((await checkManifest(new FakeNetwork(), ENDPOINT, RUNTIME)).kind, 'unreachable')
})
