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

/** That source, taking bases, with base `n` already in its branch: taken another way than through the update. */
function sourceOnBase(n: number): string {
  const root = sourceWithMergeBeside()
  git(root, 'tag', `base-${n}`)
  git(root, 'branch', 'ouro-base')
  return root
}

function updates(root: string, record: BaseUpdateRecord, started: string | null = 'base-3') {
  const logged: string[] = []
  const saved: BaseUpdateRecord[] = []
  const told: Array<{ name: string; text: string }> = []
  const handedOff: Array<{ name: string; task: string }> = []
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
    handOff: (work) => { handedOff.push(work); return started },
    tellAgent: (name, text) => { told.push({ name, text }) },
    tellOwner: () => {},
    log: (event) => { logged.push(event) },
  })
  return { baseUpdates, saved, told, handedOff, logged }
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
  const { baseUpdates, saved, told } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: 'base-3' })
  baseUpdates.drop()
  assert.deepEqual(saved, [{ state: 'idle' }])
  assert.equal(told.length, 1)
  assert.equal(told[0]!.name, 'base-3')
  assert.match(told[0]!.text, /base 3 was dropped.*Stop/)
})

test('resolving a waiting conflict starts a base-<n> agent with the brief, and the record names it', () => {
  const root = sourceWithMergeBeside()
  const { baseUpdates, saved, handedOff } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: 'faster', resolver: null }, 'base-3-2')
  baseUpdates.resolve()
  assert.equal(handedOff.length, 1)
  assert.equal(handedOff[0]!.name, 'base-3')
  assert.match(handedOff[0]!.task, /^Ouro base 3 conflicts/)
  assert.deepEqual(saved, [{ state: 'conflict', n: 3, files: ['a.txt'], notes: 'faster', resolver: 'base-3-2' }], 'the name the agent was given')
  assert.throws(() => baseUpdates.resolve(), /resolving base 3 already/, 'one agent at a time')
})

test('when no agent can start, the conflict keeps waiting for the owner, who was told', () => {
  const root = sourceWithMergeBeside()
  const { baseUpdates, saved } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: null }, null)
  baseUpdates.resolve()
  assert.deepEqual(saved, [{ state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: null }])
})

test('at start, a failed update to a base the source has since taken is forgotten, and its merge beside removed', () => {
  const root = sourceOnBase(3)
  const { baseUpdates, saved, logged } = updates(root, { state: 'failed', n: 3, why: 'rolled back' })
  baseUpdates.resume()
  assert.deepEqual(saved, [{ state: 'idle' }])
  assert.ok(!existsSync(besideDirOf(root, 3)))
  assert.deepEqual(logged, ['base_update_overtaken'])
  assert.deepEqual(baseUpdates.status(), { kind: 'taker', integrated: 3, offered: null, update: { state: 'idle' } })
})

test('at start, a conflict waiting for the owner is forgotten once a later base carries it', () => {
  const root = sourceOnBase(4)
  const { baseUpdates, saved } = updates(root, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: null })
  baseUpdates.resume()
  assert.deepEqual(saved, [{ state: 'idle' }])
  assert.ok(!existsSync(besideDirOf(root, 3)))
})

test('at start, a conflict an agent is resolving, or a failure the source still lacks, stands with its merge beside', () => {
  const resolving = sourceOnBase(3)
  const onIt = updates(resolving, { state: 'conflict', n: 3, files: ['a.txt'], notes: '', resolver: 'base-3' })
  onIt.baseUpdates.resume()
  assert.deepEqual(onIt.saved, [])
  assert.ok(existsSync(besideDirOf(resolving, 3)))

  const behind = sourceOnBase(2)
  const lacking = updates(behind, { state: 'failed', n: 3, why: 'rolled back' })
  lacking.baseUpdates.resume()
  assert.deepEqual(lacking.saved, [])
  assert.ok(existsSync(besideDirOf(behind, 3)))
})
