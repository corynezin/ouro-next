import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  besideDirOf, branchHas, changedBetween, commitToDeploy, integratedBase, isMergedBeside, mergeBeside, mergeIntoPersonBranch,
  receivedBase, removeBeside, trackBase, unfinishedMergeIn,
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

/** A person's source at base 0: `ouro-base` is the commit before any base tag, and main is it plus one change of their own. */
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
  git(root, 'commit', '-q', '-m', 'the starting point')
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

/**
 * Releases base `n` as the base repository does: a commit of `treeDir`'s files on top of the history `root` shares, tagged
 * `base-<n>`; fetched into `root`, whose `ouro-base` then tracks it. Returns the commit.
 */
function receive(root: string, n: number, treeDir: string): string {
  const upstream = join(folder('ouro-base-upstream-'), 'upstream')
  git(folder('ouro-base-clone-'), 'clone', '-q', '--branch', 'ouro-base', root, upstream)
  for (const entry of readdirSync(upstream).filter((name) => name !== '.git')) rmSync(join(upstream, entry), { recursive: true })
  cpSync(treeDir, upstream, { recursive: true })
  git(upstream, 'add', '--all')
  git(upstream, '-c', 'user.name=Ouro', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', `Ouro base ${n}`)
  git(upstream, '-c', 'user.name=Ouro', '-c', 'user.email=o@example.com', 'tag', '-a', '-m', `base ${n}`, `base-${n}`)
  git(root, 'fetch', '-q', '--no-tags', upstream, `refs/tags/base-${n}:refs/tags/base-${n}`)
  trackBase(root, n)
  return git(root, 'rev-parse', `base-${n}^{commit}`)
}

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

test('a base whose commit the branch already has is not a base to merge, and ouro-base only follows tags that are fetched', () => {
  const root = source()
  const commit1 = receive(root, 1, base1())
  assert.equal(branchHas(root, commit1), false)
  git(root, 'merge', '-q', '--no-edit', commit1)
  assert.equal(branchHas(root, commit1), true)
  assert.equal(integratedBase(root), 1)
  assert.throws(() => trackBase(root, 2), /base 2's tag isn't in/)
  assert.equal(receivedBase(root), 1)
})
