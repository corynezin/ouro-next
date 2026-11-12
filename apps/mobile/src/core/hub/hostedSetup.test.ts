import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostedServer } from '@ouro/contract'
import { pairingDetails } from './hostedSetup.ts'

const server: HostedServer = { id: 'h-1', label: 'Work', createdAt: 1, primary: false, status: { state: 'provisioning', step: 'create' } }

test('a hosted server keeps its hub id and links nothing; one made here is linked with the other servers', () => {
  assert.deepEqual(pairingDetails('hub', server), { label: 'Work', hostedServerId: 'h-1', afterPairing: 'nothing' })
  assert.deepEqual(pairingDetails('made_here', server), { label: 'Work', afterPairing: 'link_with_other_servers' })
})
