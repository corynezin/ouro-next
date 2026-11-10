import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { forbiddenContent, readDistributionRule } from './distribution.ts'
import type { DistributionRule } from './distribution.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-distribution-'))
  made.push(dir)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const RULE: DistributionRule = { ships: ['server'], internal: ['docs', 'CLAUDE.md'], dependencies: [], checks: [] }
const NAME = ['qu', 'ix'].join('')

test('private names are found in paths and lines, whatever their case, but not in a lockfile\'s integrity hashes', () => {
  const dir = tree({
    [`server/${NAME}-notes.txt`]: 'fine\n',
    'server/main.ts': `one\nby ${NAME.toUpperCase()}\n`,
    'package-lock.json': `{\n  "integrity": "sha512-ab${NAME}cd",\n  "resolved": "https://example.com/${NAME}"\n}\n`,
    'server/CLAUDE.md': 'for agents\n',
  })
  assert.deepEqual(forbiddenContent(dir, RULE, [NAME]).sort(), [
    `package-lock.json:3: "resolved": "https://example.com/${NAME}"`,
    'server/CLAUDE.md: an internal document (CLAUDE.md)',
    `server/${NAME}-notes.txt: a private name in its path`,
    `server/main.ts:2: by ${NAME.toUpperCase()}`,
  ].sort())
})

test('a rule must name lists of strings, all inside the source', () => {
  const rule = (value: object) => readDistributionRule(tree({ 'distribution.json': JSON.stringify(value) }))
  assert.deepEqual(rule(RULE), { kind: 'read', rule: RULE })
  assert.equal(readDistributionRule(tree({})).kind, 'unusable')
  assert.match(JSON.stringify(rule({ ...RULE, checks: 'npm test' })), /needs \\"checks\\"/)
  assert.match(JSON.stringify(rule({ ...RULE, ships: ['../elsewhere'] })), /outside the source/)
  assert.match(JSON.stringify(readDistributionRule(tree({ 'distribution.json': '{' }))), /isn't JSON/)
})
