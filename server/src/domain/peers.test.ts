import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PEER_MIN_PROTOCOL, PEER_PROTOCOL } from '@ouro/contract'
import { addressFromPeer, computerStatusOf, peerRetryDelayMs, protocolProblem, signedPayload, withinClockSkew } from './peers.ts'

test('the signature covers every field, and no field can smuggle a line', () => {
  const fields = { method: 'post', path: '/peer/v1/hello?x=1', bodySha256: 'abc', machineId: 'm1', time: '1000', nonce: 'n' }
  assert.equal(signedPayload(fields), 'ouro-peer/1\nPOST\n/peer/v1/hello?x=1\nabc\nm1\n1000\nn')
  assert.throws(() => signedPayload({ ...fields, path: '/a\nb' }))
})

test('two versions work together when their protocol ranges overlap', () => {
  assert.equal(protocolProblem({ protocol: PEER_PROTOCOL, minProtocol: PEER_MIN_PROTOCOL }), null)
  assert.match(protocolProblem({ protocol: PEER_MIN_PROTOCOL - 1, minProtocol: 0 })!, /update it/)
  assert.match(protocolProblem({ protocol: PEER_PROTOCOL + 2, minProtocol: PEER_PROTOCOL + 1 })!, /update this server/)
})

test('status reads from the last contact: online, then reconnecting, then offline', () => {
  assert.equal(computerStatusOf(null, 0), 'offline')
  assert.equal(computerStatusOf(0, 10_000), 'online')
  assert.equal(computerStatusOf(0, 10_001), 'reconnecting')
  assert.equal(computerStatusOf(0, 45_000), 'reconnecting')
  assert.equal(computerStatusOf(0, 45_001), 'offline')
})

test('a request a minute off either way is still believed, and no more', () => {
  assert.ok(withinClockSkew(0, 60_000))
  assert.ok(withinClockSkew(60_000, 0))
  assert.ok(!withinClockSkew(0, 60_001))
  assert.ok(!withinClockSkew(Number.NaN, 0))
})

test('a machine that does not answer is tried again after longer and longer, up to a minute', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(peerRetryDelayMs), [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000])
})

test("addresses cross between machines: an agent gains or loses its machine, a third machine's and people's stay", () => {
  assert.equal(addressFromPeer('alice', 'alpha', 'beta'), 'alice@alpha')
  assert.equal(addressFromPeer('bob@beta', 'alpha', 'beta'), 'bob')
  assert.equal(addressFromPeer('carol@gamma', 'alpha', 'beta'), 'carol@gamma')
  assert.equal(addressFromPeer('human', 'alpha', 'beta'), 'human')
})
