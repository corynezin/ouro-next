import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  besideDirOf, changedBetween, commitBase, commitToDeploy, integratedBase, isMergedBeside, mergeBeside, mergeIntoPersonBranch,
  exportPersonBranch, receivedBase, removeBeside, treeHashOf, unfinishedMergeIn,
} from './base-checkout.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** A base's files, as a base source delivers them. */
function baseTree(files: Record<string, string>): string {
  const dir = folder('ouro-base-tree-')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

/** A person's source at base 0: `ouro-base` holds base 0, and main is it plus one change of their own. */
function source(): string {
  const root = join(folder('ouro-base-checkout-'), 'source')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'ouro-base')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  writeFileSync(join(root, 'server.txt'), 'server 0\n')
  mkdirSync(join(root, 'apps', 'mobile'), { recursive: true })
  writeFileSync(join(root, 'apps', 'mobile', 'app.txt'), 'app 0\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'Ouro base 0', '-m', 'Ouro-Base: 0')
  git(root, 'checkout', '-q', '-b', 'main')
  commit(root, 'mine.txt', 'my change\n')
  return root
}

function commit(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', `edit ${file}`)
}

const base1 = () => baseTree({ 'server.txt': 'server 1\n', 'apps/mobile/app.txt': 'app 0\n' })

/** Commits base `n` as published: its tree hash is its files' own. */
const receive = (root: string, n: number, treeDir: string) => commitBase(root, n, treeDir, treeHashOf(root, treeDir))

test('a copy without ouro-base takes no bases; with it, the base is what main and ouro-base share', () => {
  const plain = join(folder('ouro-plain-'), 'p')
  mkdirSync(plain)
  git(plain, 'init', '-q', '-b', 'main')
  assert.equal(integratedBase(plain), null)

  const root = source()
  assert.equal(integratedBase(root), 0)
  receive(root, 1, base1())
  assert.equal(receivedBase(root), 1)
  assert.equal(integratedBase(root), 0, 'received but not merged')
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(readFileSync(join(root, 'server.txt'), 'utf8'), 'server 0\n', 'the live checkout is untouched')
})

test('a base merged beside goes into main once live, keeping the person\'s change', () => {
  const root = source()
  receive(root, 1, base1())
  assert.deepEqual(mergeBeside(root, 1), { kind: 'merged' })
  assert.ok(isMergedBeside(root, 1))
  assert.equal(readFileSync(join(besideDirOf(root, 1), 'server.txt'), 'utf8'), 'server 1\n')

  commit(root, 'later.txt', 'made meanwhile\n')
  const live = commitToDeploy(root, 1)
  assert.ok(existsSync(join(besideDirOf(root, 1), 'later.txt')), 'what main gained meanwhile goes live too')

  const merged = mergeIntoPersonBranch(root, live)
  if (merged.kind !== 'merged') assert.fail(merged.why)
  assert.equal(git(root, 'rev-parse', 'HEAD'), live, 'main moves forward to the live commit')
  assert.equal(readFileSync(join(root, 'mine.txt'), 'utf8'), 'my change\n')
  assert.equal(integratedBase(root), 1)
  assert.equal(changedBetween(root, merged.before, live, 'apps/mobile'), false)
  assert.equal(changedBetween(root, merged.before, live, 'server.txt'), true)

  removeBeside(root, 1)
  assert.ok(!existsSync(besideDirOf(root, 1)))
  assert.ok(!git(root, 'branch', '--list', 'ouro-update/1'))
})

test('a conflict is left beside to resolve, and the update carries on only once it is committed', () => {
  const root = source()
  commit(root, 'server.txt', 'server, my way\n')
  receive(root, 1, base1())
  assert.deepEqual(mergeBeside(root, 1), { kind: 'conflicted', files: ['server.txt'] })
  assert.equal(readFileSync(join(root, 'server.txt'), 'utf8'), 'server, my way\n', 'the live checkout is untouched')

  const beside = besideDirOf(root, 1)
  assert.match(unfinishedMergeIn(beside) ?? '', /still conflicted in .*server\.txt/)
  assert.ok(!isMergedBeside(root, 1))
  writeFileSync(join(beside, 'server.txt'), 'server 1, my way\n')
  git(beside, 'add', 'server.txt')
  assert.match(unfinishedMergeIn(beside) ?? '', /isn't committed yet/)
  git(beside, 'commit', '-q', '--no-edit')
  assert.equal(unfinishedMergeIn(beside), null)
  assert.ok(isMergedBeside(root, 1))

  const live = commitToDeploy(root, 1)
  assert.equal(mergeIntoPersonBranch(root, live).kind, 'merged')
  assert.equal(readFileSync(join(root, 'server.txt'), 'utf8'), 'server 1, my way\n')
  assert.equal(integratedBase(root), 1)
})

test('a person\'s branch that moved on in a way that no longer merges stops the update before anything goes live', () => {
  const root = source()
  receive(root, 1, base1())
  mergeBeside(root, 1)
  commit(root, 'server.txt', 'server, changed meanwhile\n')
  assert.throws(() => commitToDeploy(root, 1), /main moved on and no longer merges with base 1/)
  assert.equal(unfinishedMergeIn(besideDirOf(root, 1)), null, 'the failed merge is aborted, leaving the merge beside as it was')
})

test('a base whose files aren\'t the ones published isn\'t committed', () => {
  const root = source()
  const published = treeHashOf(root, base1())
  const tampered = baseTree({ 'server.txt': 'server 1, changed on the way\n', 'apps/mobile/app.txt': 'app 0\n' })
  assert.throws(() => commitBase(root, 1, tampered, published), /base 1's files aren't the ones published/)
  assert.equal(receivedBase(root), 0, 'ouro-base is as it was')
})

test('a base\'s files are all committed, even those its own ignore rules name', () => {
  const root = source()
  const tree = baseTree({ '.gitignore': 'runs/\n', 'runs/.keep': '', 'server.txt': 'server 1\n' })
  receive(root, 1, tree)
  assert.equal(git(root, 'show', 'ouro-base:runs/.keep'), '')
})

test('a publisher exports its branch as committed, and a taker hashes the same files to the same tree', () => {
  const publisher = source()
  git(publisher, 'branch', '-D', 'ouro-base')
  writeFileSync(join(publisher, 'untracked.txt'), 'not in the base\n')
  writeFileSync(join(publisher, 'mine.txt'), 'not committed\n')
  assert.deepEqual(exportPersonBranch(publisher, folder('ouro-export-')), { kind: 'uncommitted', files: ['mine.txt'] })

  git(publisher, 'checkout', '-q', 'mine.txt')
  const exported = folder('ouro-export-')
  const result = exportPersonBranch(publisher, exported)
  assert.deepEqual(result, { kind: 'exported', commit: git(publisher, 'rev-parse', 'HEAD') })
  assert.equal(readFileSync(join(exported, 'mine.txt'), 'utf8'), 'my change\n')
  assert.ok(!existsSync(join(exported, 'untracked.txt')))

  const taker = source()
  receive(taker, 1, exported)
  assert.equal(git(taker, 'rev-parse', 'ouro-base^{tree}'), git(publisher, 'rev-parse', 'HEAD^{tree}'))
})
