import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MachineOrder, MachineProvisioner } from '../adapters/machine-provisioners.ts'
import type { SpritesAccount } from '../adapters/sprites-account.ts'
import { MachinesFile } from '../store/machines-file.ts'
import { CommandRefused } from './failure.ts'
import { Machines } from './machines.ts'

const noSprites: SpritesAccount = { token: () => null, status: async () => ({ status: 'not_connected' }), setToken: async () => ({ accepted: true }), disconnect: () => {} }

function fakeProvisioner(calls: string[], options: { failAt?: string; paired?: () => boolean } = {}): MachineProvisioner {
  const step = (name: string) => async (order: MachineOrder) => {
    calls.push(`${name}:${order.data.instanceId ?? '-'}`)
    if (options.failAt === name) throw new Error(`${name} broke\nmore detail`)
  }
  return {
    create: async (order) => { await step('create')(order); return { instanceId: 'i-1' } },
    upload: step('upload'), install: step('install'), setup: step('setup'), service: step('service'),
    address: async () => 'https://1-2-3-4.sslip.io',
    startPairing: async () => { calls.push('pair'); return { code: `code-${calls.length}`, expiresAt: Date.now() + 10 * 60_000 } },
    hasPairedPhone: async () => options.paired?.() ?? false,
    destroy: async (order) => { calls.push(`destroy:${order.data.instanceId}`) },
  }
}

function machinesWith(provisioner: MachineProvisioner | null, file = new MachinesFile(join(mkdtempSync(join(tmpdir(), 'machines-')), 'machines.json'))) {
  return new Machines({
    file, sprites: noSprites,
    providers: [{ id: 'aws', name: 'AWS', setup: 'aws', provisioner: () => provisioner, detail: () => (provisioner ? 'An EC2 t3.medium' : 'Connect AWS first.') }],
    currentCommit: async () => 'abc123', now: Date.now, log: () => {},
  })
}

test('a server is made step by step, what create records reaches the later steps, and it ends ready with a code', async () => {
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls))
  const made = await machines.create('aws', ' Work ')
  assert.equal(made.label, 'Work')
  await machines.start(made.id)
  assert.deepEqual(calls, ['create:-', 'upload:i-1', 'install:i-1', 'setup:i-1', 'service:i-1', 'pair'])
  const ready = await machines.get(made.id)
  assert.equal(ready.status.state, 'ready')
  assert.ok(ready.status.state === 'ready' && ready.status.address === 'https://1-2-3-4.sslip.io' && ready.status.pairing?.code === 'code-6')
})

test('a failed step is shown with its first line, and nothing after it runs', async () => {
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls, { failAt: 'install' }))
  const made = await machines.create('aws', 'Work')
  await machines.start(made.id)
  assert.deepEqual(calls, ['create:-', 'upload:i-1', 'install:i-1'])
  const failed = await machines.get(made.id)
  assert.deepEqual(failed.status, { state: 'failed', why: 'Making the server failed at the install step: install broke' })
  await machines.remove(made.id)
  assert.deepEqual(calls.at(-1), 'destroy:i-1')
  assert.equal((await machines.list()).machines.length, 0)
})

test('once a phone has paired, the server is listed as paired, so its machine can still be destroyed', async () => {
  let paired = false
  const machines = machinesWith(fakeProvisioner([], { paired: () => paired }))
  const made = await machines.create('aws', 'Work')
  await machines.start(made.id)
  assert.equal((await machines.list()).machines.length, 1)
  paired = true
  const shown = await machines.get(made.id)
  assert.ok(shown.status.state === 'ready' && shown.status.pairing === null && shown.paired)
  assert.deepEqual((await machines.list()).machines.map((machine) => [machine.id, machine.paired]), [[made.id, true]])
})

test("a provider that isn't connected is listed as such and refuses to make one", async () => {
  const machines = machinesWith(null)
  assert.deepEqual((await machines.list()).providers, [{ id: 'aws', name: 'AWS', available: false, detail: 'Connect AWS first.', setup: 'aws' }])
  await assert.rejects(machines.create('aws', 'Work'), (error) => error instanceof CommandRefused && error.message === 'Connect AWS first.')
  await assert.rejects(machines.create('gcp', 'Work'), (error) => error instanceof CommandRefused && error.code === 'not_found')
})

test('a server being made when the server stopped carries on from its step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machines-'))
  const file = new MachinesFile(join(dir, 'machines.json'))
  file.put({ id: 'm-1', label: 'Work', provider: 'aws', createdAt: 1, commit: 'abc', data: { instanceId: 'i-9' }, progress: { state: 'provisioning', step: 'setup' } })
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls), new MachinesFile(join(dir, 'machines.json')))
  machines.resumeAll()
  await machines.start('m-1')
  assert.deepEqual(calls, ['setup:i-9', 'service:i-9', 'pair'])
})
