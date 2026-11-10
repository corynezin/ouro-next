import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { folderBases } from '../adapters/base-source.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { publishBase, withdrawBase } from './base-publishing.ts'
import type { BasePublisher } from './base-publishing.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-publishing-'))
  made.push(dir)
  return dir
}

/** Built here, not written out, so this file holds no private name for a real publish to find. */
const PRIVATE_NAME = ['Zor', 'blax'].join('')

const RULE = { ships: ['server', 'package.json'], internal: ['docs'], dependencies: ['node_modules'], checks: ['test -f server/server.txt'] }

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], { encoding: 'utf8' }).trim()

/** Writes `files` into the source and commits them; returns the commit. */
function commit(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'change')
  return git(root, 'rev-parse', 'HEAD')
}

function source(): string {
  const root = folder()
  git(root, 'init', '-q', '-b', 'main')
  commit(root, {
    'distribution.json': JSON.stringify(RULE),
    'server/server.txt': 'server\n',
    'package.json': '{}\n',
    'notes/plan.md': 'not shipped\n',
  })
  return root
}

/** A guardian whose live release is whatever the source's branch is now. */
const liveIs = (commitOf: () => string | null): GuardianClient => ({
  confirmedLiveCommit: async () => commitOf(),
  deploy: async () => { throw new Error('not used') },
  deployment: async () => null,
})

function publisher(root: string | null = source()): BasePublisher & { root: string; bases: string } {
  const bases = folder()
  const privateNamesFile = join(folder(), 'private-names')
  writeFileSync(privateNamesFile, `${PRIVATE_NAME}\n\n`)
  return {
    root: root ?? '',
    bases,
    sourceRoot: root,
    target: folderBases(bases),
    guardian: liveIs(() => root === null ? null : git(root, 'rev-parse', 'HEAD')),
    privateNamesFile,
  }
}

test('only a machine with a source, a target, a guardian, private names and no ouro-base publishes', async () => {
  await assert.rejects(publishBase(publisher(null), 'notes'), { code: 'not_base_publisher' })
  await assert.rejects(publishBase({ ...publisher(), target: null }, 'notes'), { code: 'not_base_publisher' })
  await assert.rejects(publishBase({ ...publisher(), guardian: null }, 'notes'), { code: 'not_base_publisher' })
  await assert.rejects(publishBase({ ...publisher(), privateNamesFile: null }, 'notes'), { code: 'not_base_publisher', message: /private names/ })

  const taker = publisher()
  git(taker.root, 'branch', 'ouro-base')
  await assert.rejects(publishBase(taker, 'notes'), { code: 'not_base_publisher', message: /takes bases/ })
  assert.equal(await taker.target?.latest(), null)
})

test('what ships is cut by the distribution rule and checked, and the same files again publish nothing new', async () => {
  const machine = publisher()
  const published = await publishBase(machine, 'the first')
  assert.deepEqual({ n: published.base.n, notes: published.base.notes, alreadyPublished: published.alreadyPublished }, { n: 1, notes: 'the first', alreadyPublished: false })
  const tree = join(machine.bases, '1', 'tree')
  assert.deepEqual(execFileSync('find', ['.', '-type', 'f'], { cwd: tree, encoding: 'utf8' }).split('\n').filter(Boolean).sort(), ['./package.json', './server/server.txt'])

  // A check that would fail shows the same files aren't checked again.
  commit(machine.root, { 'distribution.json': JSON.stringify({ ...RULE, checks: ['false'] }) })
  const again = await publishBase(machine, 'retried')
  assert.deepEqual({ n: again.base.n, notes: again.base.notes, alreadyPublished: again.alreadyPublished }, { n: 1, notes: 'the first', alreadyPublished: true })
})

test('only the live version publishes', async () => {
  const machine = publisher()
  const deployed = git(machine.root, 'rev-parse', 'HEAD')
  commit(machine.root, { 'server/server.txt': 'not deployed yet\n' })
  await assert.rejects(publishBase({ ...machine, guardian: liveIs(() => deployed) }, 'notes'), { code: 'base_not_live', message: /deploy it first/ })
  await assert.rejects(publishBase({ ...machine, guardian: liveIs(() => null) }, 'notes'), { code: 'base_not_live', message: /no version is confirmed live/ })
  assert.equal(await machine.target?.latest(), null)
})

test('uncommitted changes, an unusable rule, private content and failed checks each stop the publish', async () => {
  const machine = publisher()
  writeFileSync(join(machine.root, 'server', 'server.txt'), 'changed\n')
  await assert.rejects(publishBase(machine, 'notes'), { code: 'base_source_uncommitted' })
  git(machine.root, 'checkout', '-q', '.')

  commit(machine.root, { 'distribution.json': '{"ships": ["server"]}' })
  await assert.rejects(publishBase(machine, 'notes'), { code: 'distribution_rule_unusable', message: /"internal"/ })
  commit(machine.root, { 'distribution.json': JSON.stringify({ ...RULE, ships: ['server', 'missing'] }) })
  await assert.rejects(publishBase(machine, 'notes'), { code: 'distribution_rule_unusable', message: /missing/ })
  commit(machine.root, { 'distribution.json': JSON.stringify(RULE) })

  commit(machine.root, { 'server/docs/inside.md': 'internal\n' })
  await assert.rejects(publishBase(machine, 'notes'), { code: 'base_private_content', message: /server\/docs\/inside\.md: an internal document/ })
  git(machine.root, 'rm', '-q', '-r', 'server/docs')
  git(machine.root, '-c', 'user.name=t', 'commit', '-q', '-m', 'drop')

  commit(machine.root, { 'server/hello.ts': `const owner = "${PRIVATE_NAME.toLowerCase()}"\n` })
  await assert.rejects(publishBase(machine, 'notes'), { code: 'base_private_content', message: /server\/hello\.ts:1: const owner = "/ })
  commit(machine.root, { 'server/hello.ts': 'const owner = "someone"\n' })

  commit(machine.root, { 'distribution.json': JSON.stringify({ ...RULE, checks: ['echo checking; echo broken >&2; exit 3'] }) })
  await assert.rejects(publishBase(machine, 'notes'), { code: 'base_checks_failed', message: /checking\nbroken/ })
  assert.equal(await machine.target?.latest(), null)
})

test('checks run on a copy of what ships, with dependencies linked from the source', async () => {
  const machine = publisher()
  mkdirSync(join(machine.root, 'node_modules', 'tool'), { recursive: true })
  writeFileSync(join(machine.root, '.gitignore'), 'node_modules/\n')
  commit(machine.root, { 'distribution.json': JSON.stringify({ ...RULE, checks: ['test -d node_modules/tool', 'test ! -e notes', 'touch server/made.txt'] }) })
  const published = await publishBase(machine, 'checked')
  assert.equal(published.alreadyPublished, false)
  assert.deepEqual(execFileSync('find', ['.', '-type', 'f'], { cwd: join(machine.bases, '1', 'tree'), encoding: 'utf8' }).split('\n').filter(Boolean).sort(), ['./package.json', './server/server.txt'])
})

test('a withdrawn base is offered no more, and the next base is numbered past it', async () => {
  const machine = publisher()
  await publishBase(machine, 'the first')
  await assert.rejects(withdrawBase(machine, 2), { code: 'not_found' })
  await assert.rejects(withdrawBase({ ...machine, target: null }, 1), { code: 'not_base_publisher' })
  assert.equal((await withdrawBase(machine, 1)).n, 1)
  assert.equal((await withdrawBase(machine, 1)).n, 1)
  assert.equal(await machine.target?.latest(), null)

  commit(machine.root, { 'server/server.txt': 'fixed\n' })
  assert.equal((await publishBase(machine, 'the fix')).base.n, 2)
})
