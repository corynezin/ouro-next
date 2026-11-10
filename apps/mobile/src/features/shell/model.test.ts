import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOTHING_USABLE_TO_PAIR_WITH, pairingTarget } from '../pair/model.ts'
import { DAMAGED_SETUP_TEXT, recoveryBanner, rootView } from './model.ts'

const ready = { stage: 'ready' } as const
const failed = { stage: 'failed', message: 'could not read' } as const
const noDamage = { preferencesDamaged: false, serverListDamaged: false }

test('the root follows startup, then the active server, then whether a hosted account is waiting for its first', () => {
  assert.deepEqual(rootView({ stage: 'loading' }, 's1', false), { kind: 'loading' })
  assert.deepEqual(rootView(failed, 's1', false), { kind: 'startup_failed', message: 'could not read' })
  assert.deepEqual(rootView(ready, null, false), { kind: 'welcome' })
  assert.deepEqual(rootView(ready, null, true), { kind: 'setup' })
  assert.deepEqual(rootView(ready, 's1', true), { kind: 'server', serverId: 's1' })
})

test('the recovery banner offers only the reset that applies', () => {
  assert.equal(recoveryBanner({ startup: ready, ...noDamage }), null)
  assert.equal(recoveryBanner({ startup: { stage: 'loading' }, preferencesDamaged: true, serverListDamaged: true }), null)
  assert.deepEqual(recoveryBanner({ startup: ready, ...noDamage, preferencesDamaged: true }), { text: DAMAGED_SETUP_TEXT, offerPreferencesReset: true, offerServerListReset: false })
  assert.deepEqual(recoveryBanner({ startup: ready, ...noDamage, serverListDamaged: true }), { text: DAMAGED_SETUP_TEXT, offerPreferencesReset: false, offerServerListReset: true })
  assert.deepEqual(recoveryBanner({ startup: failed, ...noDamage }), { text: 'could not read', offerPreferencesReset: false, offerServerListReset: true })
})

test('pairing takes the link first, then the address and code, and says so when neither works', () => {
  const blank = { link: '', address: '', code: '' }
  assert.deepEqual(pairingTarget({ ...blank, link: 'ouronext://pair?url=http%3A%2F%2F1.2.3.4%3A8790&code=abc', address: 'ignored', code: 'ignored' }), { url: 'http://1.2.3.4:8790', code: 'abc' })
  assert.deepEqual(pairingTarget({ ...blank, address: 'mac.example.com', code: ' abc ' }), { url: 'https://mac.example.com', code: 'abc' })
  assert.equal(pairingTarget(blank), null)
  assert.equal(pairingTarget({ ...blank, address: 'mac.example.com' }), null, 'an address alone is not enough')
  assert.equal(pairingTarget({ ...blank, code: 'abc' }), null, 'a code alone is not enough')
  assert.match(NOTHING_USABLE_TO_PAIR_WITH, /ouronext:\/\/pair/)
})
