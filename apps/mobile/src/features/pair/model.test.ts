import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PairingGate } from './model.ts'

test('a second pairing while one is under way is not sent, so it cannot spend the code; after it, pairing works again', async () => {
  const gate = new PairingGate()
  const sent: string[] = []
  let finish = () => {}
  const first = gate.run(() => new Promise<void>((resolve) => { sent.push('first'); finish = resolve }))
  assert.equal(await gate.run(async () => { sent.push('second') }), false)
  finish()
  assert.equal(await first, true)
  assert.equal(await gate.run(async () => { sent.push('third') }), true)
  await assert.rejects(gate.run(async () => { throw new Error('refused') }))
  assert.equal(await gate.run(async () => { sent.push('after a failure') }), true)
  assert.deepEqual(sent, ['first', 'third', 'after a failure'])
})
