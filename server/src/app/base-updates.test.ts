import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { besideDirOf } from '../adapters/base-checkout.ts'
import type { BaseUpdateRecord } from '../domain/base-update.ts'
import { BaseUpdates } from './base-updates.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A source with base 3's merge in progress beside it, as a conflict leaves it. */
function sourceWithMergeBeside(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-base-updates-'))
  made.push(dir)
  const root = join(dir, 'source')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '-q', '-m', 'start')
  git(root, 'worktree', 'add', '-q', '-b', 'ouro-update/3', besideDirOf(root, 3))
  return root
}

function updates(root: string, record: BaseUpdateRecord) {
  const saved: BaseUpdateRecord[] = []
  const told: Array<{ name: string; text: string }> = []
  const baseUpdates = new BaseUpdates({
    sourceRoot: root,
    baseSource: null,
    guardian: null,
    now: () => 0,
    commit: (body) => body(),
    readRecord: () => saved.at(-1) ?? record,
    saveRecord: (next) => { saved.push(next) },
    offerChanged: () => {},
    publishApp: null,
    tellMasterAgent: (text) => { told.push({ name: 'master', text }) },
    tellAgent: (name, text) => { told.push({ name, text }) },
    tellOwner: () => {},
    log: () => {},
  })
  return { baseUpdates, saved, told }
}

test('dropping a conflict saves only the record in the command; the merge beside goes once the command has committed', async () => {
  const root = sourceWithMergeBeside()
  const { baseUpdates, saved, told } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: null })
  baseUpdates.drop()
  assert.deepEqual(saved, [{ state: 'idle' }])
  assert.deepEqual(told, [], 'no agent was on it')
  assert.ok(existsSync(besideDirOf(root, 3)), 'nothing is removed inside the transaction')
  await new Promise((done) => setImmediate(done))
  assert.ok(!existsSync(besideDirOf(root, 3)))
})

test('dropping a conflict an agent is resolving tells that agent to stop', () => {
  const root = sourceWithMergeBeside()
  const { baseUpdates, saved, told } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: 'master' })
  baseUpdates.drop()
  assert.deepEqual(saved, [{ state: 'idle' }])
  assert.equal(told.length, 1)
  assert.equal(told[0]!.name, 'master')
  assert.match(told[0]!.text, /base 3 was dropped.*Stop/)
})
