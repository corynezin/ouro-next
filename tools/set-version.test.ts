import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextVersion, withVersion } from './set-version.ts'

test('a version steps by major, minor or patch, or is set outright', () => {
  assert.equal(nextVersion('0.5.0', 'minor'), '0.6.0')
  assert.equal(nextVersion('0.5.3', 'patch'), '0.5.4')
  assert.equal(nextVersion('0.5.3', 'major'), '1.0.0')
  assert.equal(nextVersion('0.5.3', '2.0.1'), '2.0.1')
  assert.throws(() => nextVersion('0.5', 'minor'), /isn't major.minor.patch/)
  assert.throws(() => nextVersion('0.5.0', 'bigger'), /say major, minor, patch/)
})

test('the version goes beside the name, replacing one there and keeping the layout', () => {
  assert.equal(withVersion('{\n  "name": "a",\n  "private": true\n}\n', 'a', '  ', '0.5.0'), '{\n  "name": "a",\n  "version": "0.5.0",\n  "private": true\n}\n')
  assert.equal(withVersion('{\n  "name": "a",\n  "version": "0.0.0",\n  "x": { "y": 1 }\n}\n', 'a', '  ', '0.6.0'), '{\n  "name": "a",\n  "version": "0.6.0",\n  "x": { "y": 1 }\n}\n')
  const lock = '{\n  "name": "a",\n  "packages": {\n    "server": {\n      "name": "@o/s",\n      "version": "0.0.0",\n'
  assert.match(withVersion(lock, '@o/s', '      ', '1.0.0'), /"name": "@o\/s",\n {6}"version": "1.0.0",\n$/)
  assert.throws(() => withVersion(lock, '@o/s', '  ', '1.0.0'), /no "name"/)
})
