import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushTokenRegistrationOf } from './registration.ts'

test("the bundle id is the binary's own, so a build running an update (no app config in its manifest) still registers", () => {
  assert.deepEqual(pushTokenRegistrationOf('ab'.repeat(32), { bundleId: 'dev.claudeinbox.ouronext', productionApns: true }),
    { token: 'ab'.repeat(32), environment: 'production', bundleId: 'dev.claudeinbox.ouronext' })
  assert.equal(pushTokenRegistrationOf('ab'.repeat(32), { bundleId: 'dev.claudeinbox.ouronext', productionApns: false }).environment, 'sandbox')
})

test('a build with no bundle id says so rather than registering an empty one', () => {
  assert.throws(() => pushTokenRegistrationOf('ab'.repeat(32), { bundleId: null, productionApns: true }), /This build has no bundle identifier\./)
})
