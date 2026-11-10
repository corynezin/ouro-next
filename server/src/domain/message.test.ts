import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  completeDelivery, handToRunner, IllegalDeliveryTransition, markTakenIn, newQueuedDelivery, refuseDelivery, requeueDelivery, retagTurn,
  selectForDispatch,
} from './message.ts'
import type { DeliveryForDispatch } from './message.ts'

test('a delivery goes queued, handed to the runner, taken in, completed', () => {
  const queued = newQueuedDelivery(1)
  const handed = handToRunner(queued, 't', 'a1', 2)
  assert.deepEqual(handed, { state: 'handed_to_runner', since: 2, turnId: 't', attemptId: 'a1', possiblySeen: false })
  const takenIn = markTakenIn(handed, 3)
  assert.deepEqual(takenIn, { state: 'taken_in', since: 3, turnId: 't', attemptId: 'a1', possiblySeen: false })
  assert.deepEqual(completeDelivery(takenIn, 'turn_finished', 4), { state: 'completed', at: 4, turnId: 't', outcome: 'turn_finished' })
})

test('a turn that ends completes a delivery the runner never reported taken in', () => {
  assert.deepEqual(completeDelivery(handToRunner(newQueuedDelivery(1), 't', 'a1', 2), 'turn_finished', 3), { state: 'completed', at: 3, turnId: 't', outcome: 'turn_finished' })
})

test('requeueing marks it possibly seen, and the mark survives into the next attempt', () => {
  const requeued = requeueDelivery(markTakenIn(handToRunner(newQueuedDelivery(1), 't', 'a1', 2), 3), 4)
  assert.deepEqual(requeued, { state: 'queued', since: 4, possiblySeen: true })
  assert.deepEqual(handToRunner(requeued, 't2', 'a2', 5), { state: 'handed_to_runner', since: 5, turnId: 't2', attemptId: 'a2', possiblySeen: true })
})

test('a retag keeps the attempt', () => {
  const retagged = retagTurn(markTakenIn(handToRunner(newQueuedDelivery(1), 't', 'a1', 2), 3), 't2')
  assert.ok(retagged.state === 'taken_in')
  assert.equal(retagged.attemptId, 'a1')
  assert.equal(retagged.turnId, 't2')
})

test('illegal transitions throw', () => {
  const completed = completeDelivery(handToRunner(newQueuedDelivery(1), 't', 'a', 2), 'turn_finished', 3)
  assert.throws(() => requeueDelivery(completed, 4), IllegalDeliveryTransition)
  assert.throws(() => completeDelivery(newQueuedDelivery(1), 'turn_finished', 4), IllegalDeliveryTransition)
  assert.throws(() => handToRunner(completed, 't', 'a', 4), IllegalDeliveryTransition)
  assert.throws(() => markTakenIn(completed, 4), IllegalDeliveryTransition)
  assert.throws(() => markTakenIn(markTakenIn(handToRunner(newQueuedDelivery(1), 't', 'a', 2), 3), 4), IllegalDeliveryTransition)
  assert.throws(() => refuseDelivery(completed, 'x', 4), IllegalDeliveryTransition)
})

const queued = (seq: number, wake: 'wake' | 'fyi'): DeliveryForDispatch => ({ deliveryId: `d${seq}`, wake, seq, state: newQueuedDelivery(seq) })

test('an FYI alone starts nothing', () => {
  assert.deepEqual(selectForDispatch([queued(1, 'fyi')], false), [])
})

test('an FYI goes with the next real message, in order', () => {
  assert.deepEqual(selectForDispatch([queued(2, 'wake'), queued(1, 'fyi')], false).map((d) => d.seq), [1, 2])
})

test('an FYI joins a turn already running', () => {
  assert.deepEqual(selectForDispatch([queued(1, 'fyi')], true).map((d) => d.seq), [1])
})
