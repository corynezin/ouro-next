import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayDecision } from './relay.ts'

test("an agent a person started relays that person's words", () => {
  assert.deepEqual(relayDecision({ parent: 'human' }), { kind: 'allowed', person: 'human' })
  assert.deepEqual(relayDecision({ parent: 'human@sam' }), { kind: 'allowed', person: 'human@sam' })
})

test('a helper started by another agent, here or elsewhere, relays nothing', () => {
  assert.equal(relayDecision({ parent: 'scout' }).kind, 'refused')
  assert.equal(relayDecision({ parent: 'scout@mac' }).kind, 'refused')
})
