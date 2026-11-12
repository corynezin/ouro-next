import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MachineOrder, MachineProvisioner } from '../adapters/machine-provisioners.ts'
import { MachinesFile } from '../store/machines-file.ts'
import { CommandRefused } from './failure.ts'
import { failureWhy, Machines } from './machines.ts'

function fakeProvisioner(calls: string[], options: { failAt?: string; paired?: () => boolean; failAfterMade?: boolean } = {}): MachineProvisioner {
  const step = (name: string) => async (order: MachineOrder) => {
    calls.push(`${name}:${order.data.instanceId ?? '-'}`)
    if (options.failAt === name) throw new Error(`${name} broke\nmore detail`)
  }
  return {
    create: async (order, record) => {
      calls.push(`create:${order.data.instanceId ?? '-'}`)
      if (options.failAfterMade) {
        record({ instanceId: 'i-1' })
        throw new Error('the instance i-1 is terminated')
      }
      return { instanceId: 'i-1' }
    },
    upload: step('upload'), install: step('install'), setup: step('setup'), service: step('service'),
    address: async () => 'https://1-2-3-4.sslip.io',
    startPairing: async () => { calls.push('pair'); return { code: `code-${calls.length}`, expiresAt: Date.now() + 10 * 60_000 } },
    hasPairedPhone: async () => options.paired?.() ?? false,
    destroy: async (order) => { calls.push(`destroy:${order.data.instanceId}`) },
    join: async (order, invite) => {
      calls.push(`join:${order.data.instanceId}:${invite.kind}:${invite.address}:${invite.code}`)
      if (options.failAt === 'join') throw new Error('join_network answered 403: That invite is not valid\nmore')
    },
  }
}

function machinesWith(provisioner: MachineProvisioner | null, file = new MachinesFile(join(mkdtempSync(join(tmpdir(), 'machines-')), 'machines.json')), now: () => number = Date.now) {
  return new Machines({
    file,
    providers: [{ id: 'aws', name: 'AWS', setup: 'aws', provisioner: () => provisioner, detail: () => (provisioner ? 'An EC2 t3.medium' : 'Connect AWS first.') }],
    currentCommit: async () => 'abc123', now, log: () => {},
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
  await new Promise((done) => setImmediate(done)) // the check that list started in the background
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

test('create fails after the machine exists, and remove still destroys it', async () => {
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls, { failAfterMade: true }))
  const made = await machines.create('aws', 'Work')
  await machines.start(made.id)
  assert.deepEqual((await machines.get(made.id)).status, { state: 'failed', why: 'Making the server failed at the create step: the instance i-1 is terminated' })
  await machines.remove(made.id)
  assert.deepEqual(calls, ['create:-', 'destroy:i-1'], 'what create recorded before it failed reaches destroy')
})

test('listing learns that a phone paired, without anyone asking for that server, at most every 30 seconds', async () => {
  let paired = false
  let asked = 0
  let now = 1_000_000
  const provisioner = fakeProvisioner([], { paired: () => { asked += 1; return paired } })
  const machines = machinesWith(provisioner, undefined, () => now)
  const made = await machines.create('aws', 'Work')
  await machines.start(made.id)
  paired = true
  assert.equal((await machines.list()).machines[0]!.paired, false, 'the first list answers at once and asks in the background')
  await new Promise((done) => setImmediate(done))
  assert.equal((await machines.list()).machines[0]!.paired, true)
  assert.equal(asked, 1)
  now += 60_000
  await machines.list()
  assert.equal(asked, 1, 'a paired one is not asked again')
})

test("a failure is shown by its first line, cut to fit", () => {
  assert.equal(failureWhy('upload', new Error('\n  the upload job exited 1: no space\nlog…')), 'Making the server failed at the upload step: the upload job exited 1: no space')
  assert.equal(failureWhy('create', new Error('')), 'Making the server failed at the create step: no detail')
  assert.equal(failureWhy('create', new Error('x'.repeat(400))).length, 'Making the server failed at the create step: '.length + 300)
})

test('the machines file keeps every record across a restart, oldest first, and private', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'machines-')), 'nested', 'machines.json')
  const file = new MachinesFile(path)
  file.put({ id: 'm-2', label: 'B', provider: 'sprite', createdAt: 2, commit: 'c', data: { sprite: 'ouro-made-m-2' }, progress: { state: 'failed', why: 'x', step: 'create' } })
  file.put({ id: 'm-1', label: 'A', provider: 'aws', createdAt: 1, commit: 'c', data: {}, progress: { state: 'provisioning', step: 'create' } })
  const again = new MachinesFile(path)
  assert.deepEqual(again.list().map((record) => record.id), ['m-1', 'm-2'])
  assert.equal(again.get('m-2')?.data.sprite, 'ouro-made-m-2')
  const changed = again.get('m-1')!
  changed.label = 'changed outside'
  assert.equal(again.get('m-1')!.label, 'A', 'a record handed out is a copy')
  again.delete('m-1')
  assert.deepEqual(new MachinesFile(path).list().map((record) => record.id), ['m-2'])
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('a ready server joins this one with a fresh invite, and is then named as a computer', async () => {
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls))
  const made = await machines.create('aws', 'PR Sprite 1')
  let invites = 0
  const invite = () => ({ kind: 'network' as const, networkKind: 'private' as const, address: 'https://here.example', code: `c${++invites}` })
  await assert.rejects(machines.link(made.id, invite), (error: Error) => error instanceof CommandRefused && /still being made/.test(error.message))
  assert.equal(invites, 0)
  await machines.start(made.id)
  assert.deepEqual(await machines.link(made.id, invite), { computerName: 'pr-sprite-1' })
  assert.equal(calls.at(-1), 'join:i-1:network:https://here.example:c1')
})

test('a server that fails to join says why, in a line', async () => {
  const calls: string[] = []
  const machines = machinesWith(fakeProvisioner(calls, { failAt: 'join' }))
  const made = await machines.create('aws', 'Work')
  await machines.start(made.id)
  await assert.rejects(machines.link(made.id, () => ({ kind: 'computer', address: 'https://here.example', code: 'c' })),
    (error: Error) => error instanceof CommandRefused && error.message === "Work couldn't join this server: join_network answered 403: That invite is not valid")
})
