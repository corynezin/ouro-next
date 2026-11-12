import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryDurableStore } from '../platform/fakes.ts'
import { joinMadeNetwork, NetworkPlans, parsePlan } from './networkPlans.ts'

test('a stored plan is read only when it has the shape of one', () => {
  assert.deepEqual(parsePlan(JSON.stringify({ kind: 'new_private', name: 'work' })), { kind: 'new_private', name: 'work' })
  const join = { kind: 'join', networkId: 'n', networkName: 'team', networkKind: 'shared', hostServerId: 's' }
  assert.deepEqual(parsePlan(JSON.stringify(join)), join)
  assert.equal(parsePlan(JSON.stringify({ kind: 'join', networkId: 'n' })), null, 'a join missing its host')
  assert.equal(parsePlan(JSON.stringify({ ...join, networkKind: 'public' })), null)
  assert.equal(parsePlan('{not json'), null)
  assert.equal(parsePlan(null), null)
})

test('once a server made a new private network, the others waiting to make one of that name join it instead', () => {
  const made = { name: 'work', networkId: 'n-work', hostServerId: 's-1' }
  assert.deepEqual(joinMadeNetwork({ kind: 'new_private', name: 'work' }, made), { kind: 'join', networkId: 'n-work', networkName: 'work', networkKind: 'private', hostServerId: 's-1' })
  const other = { kind: 'new_private' as const, name: 'home' }
  assert.equal(joinMadeNetwork(other, made), other)
})

test('a plan follows its server from setup to saved, is rewritten in place, and sign-out clears every one', async () => {
  const store = new MemoryDurableStore()
  const plans = new NetworkPlans(store)
  await plans.set('m-1', { kind: 'new_private', name: 'work' })
  await plans.set('m-2', { kind: 'new_private', name: 'work' })
  await plans.movePlanToServer('m-1', 's-1', { kind: 'new_private', name: 'work' })
  assert.equal(await plans.get('m-1'), null)
  assert.deepEqual([...(await plans.placements()).keys()], ['s-1'])
  await plans.rewriteAll((plan) => joinMadeNetwork(plan, { name: 'work', networkId: 'n', hostServerId: 's-9' }))
  assert.equal((await plans.get('m-2'))?.kind, 'join')
  assert.equal((await plans.placementOf('s-1'))?.kind, 'join')
  await plans.clearAll()
  assert.equal(store.values.size, 0)
})
