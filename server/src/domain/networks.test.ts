import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptance, fullyTrusted, ownerAddressFrom, sharesMemoryWith, signingFor } from './networks.ts'
import type { HeldNetwork, PeerPlace } from './networks.ts'

const privateHome: HeldNetwork = { id: 'p', kind: 'private', role: 'home' }
const sharedHome: HeldNetwork = { id: 's', kind: 'shared', role: 'home' }
const sharedExtra: HeldNetwork = { id: 's', kind: 'shared', role: 'extra' }
const peer = (place: Partial<PeerPlace> = {}): PeerPlace => ({ name: 'mac', networkId: null, visiting: false, unkeyedAllowed: false, ownerName: null, ...place })

test('without a home key, everything is accepted, as before networks', () => {
  assert.deepEqual(acceptance(null, null, null), { kind: 'accepted', network: null })
  assert.deepEqual(acceptance(null, { networkId: 'x', visiting: false, signatureValid: false }, peer()), { kind: 'accepted', network: null })
})

test('with a home key, only what is signed with it is accepted', () => {
  assert.deepEqual(acceptance(sharedHome, { networkId: 's', visiting: true, signatureValid: true }, peer()), { kind: 'accepted', network: { id: 's', visiting: true } })
  assert.equal(acceptance(sharedHome, { networkId: 's', visiting: false, signatureValid: false }, peer()).kind, 'refused')
  assert.equal(acceptance(sharedHome, { networkId: 'p', visiting: false, signatureValid: true }, peer()).kind, 'refused')
  assert.equal(acceptance(sharedHome, null, peer()).kind, 'refused')
})

test('a private network takes an unsigned request only from a link from before networks that has never signed', () => {
  assert.deepEqual(acceptance(privateHome, null, peer({ unkeyedAllowed: true, networkId: 'p' })), { kind: 'accepted', network: null })
  assert.equal(acceptance(privateHome, null, peer({ unkeyedAllowed: true, networkId: null })).kind, 'refused', 'left out of the network')
  assert.equal(acceptance(privateHome, null, peer({ unkeyedAllowed: true, networkId: 'old' })).kind, 'refused', 'of a home since replaced')
  assert.equal(acceptance(privateHome, null, peer({ unkeyedAllowed: false })).kind, 'refused')
  assert.equal(acceptance(privateHome, null, null).kind, 'refused')
  assert.equal(acceptance(sharedHome, null, peer({ unkeyedAllowed: true })).kind, 'refused', 'never in a shared network')
})

test('a peer is signed to in the network it lives in, and a visitor is never contacted', () => {
  assert.deepEqual(signingFor(peer({ networkId: 'p' }), []), { kind: 'unkeyed' })
  assert.deepEqual(signingFor(peer({ networkId: 'p' }), [privateHome, sharedExtra]), { kind: 'keyed', networkId: 'p', visiting: false })
  assert.deepEqual(signingFor(peer({ networkId: 's' }), [privateHome, sharedExtra]), { kind: 'keyed', networkId: 's', visiting: true })
  assert.equal(signingFor(peer({ networkId: 's', visiting: true }), [sharedHome]).kind, 'never')
  assert.equal(signingFor(peer({ networkId: 'p' }), [sharedHome]).kind, 'never', 'a shared server holds no private key')
  assert.equal(signingFor(peer({ networkId: null, unkeyedAllowed: true }), [privateHome]).kind, 'never')
})

test("in a shared network another server's owner is a person of their own, never this server's human", () => {
  assert.equal(ownerAddressFrom(peer({ ownerName: 'sam' }), null), 'human')
  assert.equal(ownerAddressFrom(peer({ ownerName: 'sam' }), privateHome), 'human')
  assert.equal(ownerAddressFrom(peer({ ownerName: 'sam' }), sharedHome), 'human@sam')
  assert.equal(ownerAddressFrom(peer({ ownerName: null }), sharedHome), 'human@mac')
})

test("another server's owner can't take a name that isn't one, or someone else's here", () => {
  assert.equal(ownerAddressFrom(peer({ ownerName: '' }), sharedHome), 'human@mac')
  assert.equal(ownerAddressFrom(peer({ ownerName: 'x@y' }), sharedHome), 'human@mac')
  assert.equal(ownerAddressFrom(peer({ ownerName: 'Sam Smith' }), sharedHome), 'human@mac')
  assert.equal(ownerAddressFrom(peer({ ownerName: 'bob' }), sharedHome, (name) => name === 'bob'), 'human@mac')
})

test('memory is shared automatically only inside a private network, and trust is full inside any network', () => {
  assert.equal(sharesMemoryWith({ ...peer(), trust: 'full' }, null), true)
  assert.equal(sharesMemoryWith({ ...peer(), trust: 'limited' }, null), false)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 'p' }), trust: 'full' }, privateHome), true)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 's' }), trust: 'full' }, sharedHome), false)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 'p', visiting: true }), trust: 'full' }, privateHome), false)
  assert.equal(fullyTrusted({ trust: 'limited' }, sharedHome), true)
  assert.equal(fullyTrusted({ trust: 'limited' }, null), false)
})
