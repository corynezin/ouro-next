import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NetworkKeyFile, networkSignature, networkSignatureValid, newNetworkKey } from './peer-transport.ts'

test('a network signature holds only for its network, its visiting flag and the server it was sent to', () => {
  const key = newNetworkKey()
  const signature = networkSignature(key, 'payload', 'n1', false, 'machine-b')
  assert.equal(networkSignatureValid(key, 'payload', 'n1', false, 'machine-b', signature), true)
  assert.equal(networkSignatureValid(key, 'payload', 'n1', true, 'machine-b', signature), false, 'visiting flipped')
  assert.equal(networkSignatureValid(key, 'payload', 'n1', false, 'machine-c', signature), false, 'replayed to another server')
  assert.equal(networkSignatureValid(key, 'payload', 'n2', false, 'machine-b', signature), false)
  assert.equal(networkSignatureValid(key, 'other', 'n1', false, 'machine-b', signature), false)
  assert.equal(networkSignatureValid(newNetworkKey(), 'payload', 'n1', false, 'machine-b', signature), false)
})

test('network keys are kept in a mode-600 file; one that is damaged reads as holding none and is never written over', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ouro-keys-')), 'network-keys.json')
  const keys = new NetworkKeyFile(path)
  assert.equal(keys.get('n1'), null)
  keys.set('n1', 'k1')
  keys.set('n2', 'k2')
  keys.delete('n1')
  assert.equal(keys.get('n1'), null)
  assert.equal(keys.get('n2'), 'k2')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  writeFileSync(path, '{not json')
  assert.equal(keys.get('n2'), null)
  assert.throws(() => keys.set('n3', 'k3'))
  assert.equal(readFileSync(path, 'utf8'), '{not json')
})
