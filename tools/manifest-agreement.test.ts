// The guardian repeats the manifest rules on purpose (see guardian/src/manifest-check.ts). This keeps the copies equal. It lives in tools/
// because releases ship the contract without the guardian.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manifestProblem } from '../guardian/src/manifest-check.ts'
import { buildUpdateManifest, UpdateManifest } from '../packages/contract/src/updates.ts'

const good = buildUpdateManifest({
  id: '0b6c6f1e-8a2a-4a51-9a39-2f3c3e2f5a10',
  createdAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 0, 0)),
  runtimeVersion: '0.1.0',
  updateNumber: 3,
  commit: null,
  launchAsset: { hash: 'A'.repeat(43), url: 'http://example.invalid/updates/assets/3/bundle.js' },
  assets: [{ contentType: 'image/png', fileExtension: '.png', hash: 'B'.repeat(43), url: 'http://example.invalid/updates/assets/3/icon.png' }],
})

const cases: [string, unknown][] = [
  ['good', good],
  ['no milliseconds', { ...good, createdAt: '2026-11-09T12:00:00Z' }],
  ['unknown field', { ...good, extra2: {} }],
  ['bad id', { ...good, id: 'x' }],
  ['empty runtime', { ...good, runtimeVersion: '' }],
  ['launch asset not JS', { ...good, launchAsset: { ...good.launchAsset, contentType: 'text/plain' } }],
  ['short hash', { ...good, launchAsset: { ...good.launchAsset, hash: 'abc' } }],
  ['relative url', { ...good, launchAsset: { ...good.launchAsset, url: '/bundle.js' } }],
  ['bad asset', { ...good, assets: [{ key: 'x' }] }],
  ['launch key is a name, not its hash', { ...good, launchAsset: { ...good.launchAsset, key: 'bundle' } }],
  ['asset key is not its hash', { ...good, assets: [{ ...good.assets[0]!, key: 'C'.repeat(43) }] }],
  ['bad extension', { ...good, assets: [{ ...good.assets[0]!, fileExtension: 'png' }] }],
  ['metadata not strings', { ...good, metadata: { a: 1 } }],
  ['no update number', { ...good, extra: { ouro: { commit: null } } }],
  ['not an object', 'manifest'],
]

test('the guardian and the contract agree on every case', () => {
  for (const [name, manifest] of cases) {
    assert.equal(manifestProblem(manifest) === null, UpdateManifest.safeParse(manifest).success, name)
  }
  assert.equal(manifestProblem(good), null)
})
