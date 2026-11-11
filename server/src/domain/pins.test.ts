import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinPositionAfter, pinPositionAt } from './pins.ts'

test('a moved pin goes halfway between its new neighbours, or a whole step past either end', () => {
  assert.equal(pinPositionAt([], 0), 0)
  assert.equal(pinPositionAt([0, 1, 2], 0), -1)
  assert.equal(pinPositionAt([0, 1, 2], 3), 3)
  assert.equal(pinPositionAt([0, 1, 2], 1), 0.5)
  assert.equal(pinPositionAt([0, 0.5, 1], 2), 0.75)
})

test('neighbours too close to halve ask for a renumbering', () => {
  assert.equal(pinPositionAt([0, 1e-10], 1), null)
  // Moving one pin between the same two again and again comes to that, and not before it has halved many times.
  let after = 1
  let moves = 0
  for (let position = pinPositionAt([0, after], 1); position !== null; position = pinPositionAt([0, after], 1)) {
    after = position
    moves++
  }
  assert.ok(moves > 25, `${moves} moves`)
})

test('a new pin goes after the last, at the next whole number', () => {
  assert.equal(pinPositionAfter(undefined), 0)
  assert.equal(pinPositionAfter(2), 3)
  assert.equal(pinPositionAfter(2.5), 3)
  assert.equal(pinPositionAfter(-1.5), -1)
})
