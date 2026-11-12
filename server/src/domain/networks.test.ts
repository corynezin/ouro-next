import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptance, holdingRefusal, joinedKindRefusal, ownerAddressFrom, peerMay, sharesMemoryWith, showsAgentDetailsTo, signingFor, visitingAfter } from './networks.ts'
import type { HeldNetwork, PeerAction, PeerPlace } from './networks.ts'

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

const none = () => false

test("in a shared network another server's owner is a person of their own, never this server's human", () => {
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: 'sam' }), machineId: 'm1' }, null, null, none), 'human')
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: 'sam' }), machineId: 'm1' }, privateHome, null, none), 'human')
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: 'sam' }), machineId: 'm1' }, sharedHome, null, none), 'human@sam')
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: null }), machineId: 'm1' }, sharedHome, null, none), 'human@mac')
})

test("another server's owner is who their server is: the address kept for it stays, whatever name it says later", () => {
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: 'robin' }), machineId: 'm1' }, sharedHome, 'human@sam', none), 'human@sam')
  assert.equal(ownerAddressFrom({ ...peer({ ownerName: 'robin' }), machineId: 'm1' }, privateHome, 'human@sam', none), 'human', 'a private network is the same person')
})

test("another server's owner can't take a name that isn't one, or one that is someone's here", () => {
  const sam = { ...peer({ ownerName: 'sam' }), machineId: 'ab-12cd34ef56' }
  assert.equal(ownerAddressFrom({ ...sam, ownerName: '' }, sharedHome, null, none), 'human@mac')
  assert.equal(ownerAddressFrom({ ...sam, ownerName: 'x@y' }, sharedHome, null, none), 'human@mac')
  assert.equal(ownerAddressFrom({ ...sam, ownerName: 'Sam Smith' }, sharedHome, null, none), 'human@mac')
  // This server's owner, a person invited here, or another server's owner already kept: the server's name instead.
  assert.equal(ownerAddressFrom(sam, sharedHome, null, (name) => name === 'sam'), 'human@mac')
  // And when that is someone's too, the server's name with part of its machine id.
  assert.equal(ownerAddressFrom(sam, sharedHome, null, (name) => name === 'sam' || name === 'mac'), 'human@mac-ab12cd34')
  assert.equal(ownerAddressFrom(sam, sharedHome, null, (name) => name === 'sam' || name.startsWith('mac')), 'human@server-ab12cd34')
})

test('memory is shared automatically only inside a private network, and trust is full inside any network', () => {
  assert.equal(sharesMemoryWith({ ...peer(), trust: 'full' }, null), true)
  assert.equal(sharesMemoryWith({ ...peer(), trust: 'limited' }, null), false)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 'p' }), trust: 'full' }, privateHome), true)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 's' }), trust: 'full' }, sharedHome), false)
  assert.equal(sharesMemoryWith({ ...peer({ networkId: 'p', visiting: true }), trust: 'full' }, privateHome), false)
  assert.equal(showsAgentDetailsTo({ trust: 'limited' }, sharedHome), true)
  assert.equal(showsAgentDetailsTo({ trust: 'limited' }, null), false)
})

// Who may do what, by where the peer stands: y allowed, n refused.
const ACTIONS: PeerAction[] = ['see_agents', 'message', 'group', 'snooze_ask', 'pull_memory', 'pull', 'push_memory', 'control', 'create_agent', 'move', 'read_log', 'sign_in']
const MAY: Array<{ who: string; home: HeldNetwork | null; peer: { trust: 'full' | 'limited'; networkId: string | null; visiting: boolean }; may: string }> = [
  //                                                                                                  see msg grp snz mem pul psh ctl crt mov log sig
  { who: 'before networks, trusted fully', home: null, peer: { trust: 'full', networkId: null, visiting: false }, may: 'y y y y y n n y y y y y' },
  { who: 'before networks, trusted to message', home: null, peer: { trust: 'limited', networkId: null, visiting: false }, may: 'y y y y n n n n n n n n' },
  { who: 'a member of the private home', home: privateHome, peer: { trust: 'limited', networkId: 'p', visiting: false }, may: 'y y y y y n n y y y y y' },
  { who: 'one saying it visits the private home', home: privateHome, peer: { trust: 'full', networkId: 'p', visiting: true }, may: 'n n n n n n n n n n n n' },
  { who: 'a member of the shared home', home: sharedHome, peer: { trust: 'full', networkId: 's', visiting: false }, may: 'y y y n n y y n n n n n' },
  { who: 'a visitor of the shared home', home: sharedHome, peer: { trust: 'full', networkId: 's', visiting: true }, may: 'y y y n n y y n n n n n' },
  { who: 'outside the shared home', home: sharedHome, peer: { trust: 'full', networkId: null, visiting: false }, may: 'n n n n n n n n n n n n' },
]

test('what another server may do here: everything from the person\'s own, only talk, look, pull and push from another person\'s', () => {
  for (const row of MAY) {
    const expected = row.may.split(' ')
    assert.equal(expected.length, ACTIONS.length, row.who)
    ACTIONS.forEach((action, index) => {
      const may = peerMay(action, row.peer, row.home)
      assert.equal(may.kind === 'allowed' ? 'y' : 'n', expected[index], `${row.who}: ${action}`)
      if (may.kind === 'refused') assert.ok(may.reason.length > 0)
    })
  }
})

test('a private network is held only as a home, and an extra key needs a home first', () => {
  assert.match(holdingRefusal({ kind: 'private', role: 'extra' }, privateHome) ?? '', /only as a home/)
  assert.match(holdingRefusal({ kind: 'shared', role: 'extra' }, null) ?? '', /needs a home network/)
  assert.equal(holdingRefusal({ kind: 'shared', role: 'extra' }, privateHome), null)
  assert.equal(holdingRefusal({ kind: 'private', role: 'home' }, null), null)
  assert.equal(holdingRefusal({ kind: 'shared', role: 'home' }, privateHome), null, 'a new home replaces the old')
})

test('a join is refused when the network is not the kind the person expects', () => {
  assert.equal(joinedKindRefusal('shared', 'shared'), null)
  assert.equal(joinedKindRefusal('private', 'private'), null)
  assert.match(joinedKindRefusal('shared', 'private') ?? '', /private network/)
  assert.match(joinedKindRefusal('private', 'shared') ?? '', /shared network/)
})

test('a visitor of a network stays one there, whatever it says later; elsewhere it is as it says', () => {
  assert.equal(visitingAfter(true, null, 's'), true)
  assert.equal(visitingAfter(false, null, 's'), false, 'first heard from as a member: kept as one')
  assert.equal(visitingAfter(false, { networkId: 's', visiting: true }, 's'), true)
  assert.equal(visitingAfter(false, { networkId: 'other', visiting: true }, 's'), false)
  assert.equal(visitingAfter(false, { networkId: 's', visiting: false }, 's'), false)
})
