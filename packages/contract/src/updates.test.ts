import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUpdateManifest, parseUpdateMarkUrl, UpdateManifest, updateMarkOf } from './updates.ts'

const update = {
  id: '0b6c6f1e-8a2a-4a51-9a39-2f3c3e2f5a10',
  createdAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 0, 0)),
  runtimeVersion: '0.1.0',
  updateNumber: 3,
  commit: 'abc123',
  machineId: 'machine-1',
  launchAsset: { hash: 'A'.repeat(43), url: 'http://example.invalid/updates/assets/3/bundle.js' },
  assets: [],
}

test('a built manifest validates, and keeps milliseconds even when they are zero', () => {
  const manifest = buildUpdateManifest(update)
  assert.equal(manifest.createdAt, '2026-11-09T12:00:00.000Z')
  assert.deepEqual(UpdateManifest.parse(JSON.parse(JSON.stringify(manifest))), manifest)
})

test('a timestamp without milliseconds is refused: it crashes expo-updates natively', () => {
  const manifest = buildUpdateManifest(update)
  assert.equal(UpdateManifest.safeParse({ ...manifest, createdAt: '2026-11-09T12:00:00Z' }).success, false)
})

test('unknown fields, bad hashes and non-uuid ids are refused', () => {
  const manifest = buildUpdateManifest(update)
  assert.equal(UpdateManifest.safeParse({ ...manifest, surprise: true }).success, false)
  assert.equal(UpdateManifest.safeParse({ ...manifest, id: 'update-3' }).success, false)
  assert.equal(UpdateManifest.safeParse({ ...manifest, launchAsset: { ...manifest.launchAsset, hash: 'short' } }).success, false)
  assert.throws(() => buildUpdateManifest({ ...update, launchAsset: { ...update.launchAsset, url: 'not a url' } }))
})

test("a key is its content hash, so expo-updates can never mistake one update's bundle for another's", () => {
  const first = buildUpdateManifest(update)
  const second = buildUpdateManifest({ ...update, updateNumber: 4, launchAsset: { ...update.launchAsset, hash: 'B'.repeat(43) } })
  assert.equal(first.launchAsset.key, first.launchAsset.hash)
  assert.notEqual(second.launchAsset.key, first.launchAsset.key)
  assert.equal(UpdateManifest.safeParse({ ...first, launchAsset: { ...first.launchAsset, key: 'bundle' } }).success, false)
})

test('an update mark round-trips, and other links are not marks', () => {
  const mark = updateMarkOf(12, 'm a/b')
  const url = /\]\((.*)\)$/.exec(mark)![1]!
  assert.match(mark, /^\[update 12\]\(ouro:\/\/update\/12\?computer=/)
  assert.deepEqual(parseUpdateMarkUrl(url), { updateNumber: 12, machineId: 'm a/b' })
  assert.equal(parseUpdateMarkUrl('https://example.com'), null)
  assert.equal(parseUpdateMarkUrl('ouro://update/0?computer=x'), null)
})

test('a manifest names the computer that published it', () => {
  assert.equal(buildUpdateManifest(update).extra.ouro.machineId, 'machine-1')
})
