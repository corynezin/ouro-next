import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NetworkPlan } from '../../core/servers/networkPlans.ts'
import { createNewServer } from './newServer.ts'
import type { NewServerPorts } from './newServer.ts'

const plan: NetworkPlan = { kind: 'new_private', name: 'work' }

function ports(overrides: Partial<NewServerPorts> = {}) {
  const kept = new Map<string, NetworkPlan>()
  const calls: string[] = []
  const all: NewServerPorts = {
    newId: () => '1',
    createHosted: async (label) => { calls.push(`hosted ${label}`); return { ok: true, id: 'h-1', label } },
    createMachine: async (provider, label) => { calls.push(`${provider} ${label}`); return { ok: true, id: 'm-1', label } },
    keepPlan: async (id, picked) => { kept.set(id, picked) },
    forgetPlan: async (id) => { kept.delete(id) },
    pair: async (target, setupId) => { calls.push(`pair ${target.url} ${target.code} ${setupId}`) },
    ...overrides,
  }
  return { all, kept, calls }
}

test('a server made on a provider or hosted is set up with its network kept under its id', async () => {
  const machine = ports()
  assert.deepEqual(await createNewServer(machine.all, { kind: 'make', where: 'aws', label: 'Work', plan }), { kind: 'setting_up', setup: { kind: 'machine', id: 'm-1', label: 'Work' } })
  assert.deepEqual(machine.kept.get('m-1'), plan)
  const hosted = ports()
  assert.deepEqual(await createNewServer(hosted.all, { kind: 'make', where: 'hosted', label: 'Work', plan: null }), { kind: 'setting_up', setup: { kind: 'hosted', id: 'h-1', label: 'Work' } })
  assert.equal(hosted.kept.size, 0)
})

test('a make that fails says why and keeps nothing', async () => {
  const failing = ports({ createMachine: async () => ({ ok: false, why: 'no room' }) })
  assert.deepEqual(await createNewServer(failing.all, { kind: 'make', where: 'aws', label: 'Work', plan }), { kind: 'failed', why: 'no room' })
  assert.equal(failing.kept.size, 0)
})

test('a server already run pairs by its link or its address and code; a failed pairing keeps no plan', async () => {
  const linked = ports()
  assert.deepEqual(await createNewServer(linked.all, { kind: 'existing', typed: 'ouronext://pair?url=https%3A%2F%2Fa.test&code=c0de', plan }), { kind: 'paired' })
  assert.deepEqual(linked.calls, ['pair https://a.test c0de pair-1'])
  assert.deepEqual(linked.kept.get('pair-1'), plan)
  const typed = ports()
  assert.deepEqual(await createNewServer(typed.all, { kind: 'existing', typed: 'https://b.test c0de', plan: null }), { kind: 'paired' })
  assert.match(typed.calls[0]!, /^pair https:\/\/b\.test\/? c0de pair-1$/)
  const failing = ports({ pair: async () => { throw new Error('code used') } })
  assert.deepEqual(await createNewServer(failing.all, { kind: 'existing', typed: 'https://b.test c0de', plan }), { kind: 'failed', why: 'code used' })
  assert.equal(failing.kept.size, 0)
  assert.equal((await createNewServer(ports().all, { kind: 'existing', typed: 'nonsense', plan })).kind, 'failed')
})
