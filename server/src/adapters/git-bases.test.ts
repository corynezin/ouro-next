import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { gitBasePublishTarget, gitBaseSource } from './git-bases.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-git-bases-test-'))
  made.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function bareRepo(): { url: string; dir: string } {
  const dir = join(folder(), 'bases.git')
  mkdirSync(dir)
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main')
  return { url: `file://${dir}`, dir }
}

function treeHashOf(dir: string): string {
  const scratch = folder()
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_WORK_TREE: dir, GIT_DIR: join(scratch, 'git') }
  mkdirSync(env.GIT_DIR)
  execFileSync('git', ['init', '--quiet', '--bare', env.GIT_DIR], { env: process.env })
  execFileSync('git', ['add', '--all', '--force', '.'], { env, cwd: dir })
  return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
}

/** The files, and the git tree hash they have. */
function tree(files: Record<string, string>): { dir: string; hash: string } {
  const dir = folder()
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return { dir, hash: treeHashOf(dir) }
}

const publishInput = (notes: string, files: Record<string, string>) => {
  const { dir, hash } = tree(files)
  return { notes, treeHash: hash, treeDir: dir }
}

test('an empty repository offers nothing', async () => {
  const repo = bareRepo()
  assert.equal(await gitBaseSource(repo.url).latest(), null)
  assert.equal(await gitBasePublishTarget(repo.url).latest(), null)
})

test('published bases are numbered commits on main that a reader gets over the source, and the same files again publish nothing', async () => {
  const repo = bareRepo()
  const target = gitBasePublishTarget(repo.url)
  const source = gitBaseSource(repo.url)

  const first = await target.publish(publishInput('the first\n\nwith detail', { 'server.txt': 'one\n' }))
  assert.deepEqual(first.base.n, 1)
  assert.equal(first.alreadyPublished, false)
  const again = await target.publish(publishInput('the first, retried', { 'server.txt': 'one\n' }))
  assert.deepEqual(again, { base: first.base, alreadyPublished: true })
  const second = await target.publish(publishInput('the second', { 'server.txt': 'two\n', 'more.txt': 'extra\n' }))
  assert.equal(second.base.n, 2)
  assert.deepEqual(await source.latest(), second.base)
  assert.deepEqual(await source.latest(), { n: 2, notes: 'the second', treeHash: second.base.treeHash })

  assert.equal(git(repo.dir, 'log', '--format=%an <%ae>', 'main').split('\n')[0], 'Ouro Next <bases@ouro-next.invalid>')
  assert.equal(git(repo.dir, 'log', '-1', '--format=%B', 'main'), 'the second\n\nOuro-Base: 2')
  assert.deepEqual((await source.latest())?.notes, 'the second')
  assert.equal((await gitBaseSource(repo.url).latest())?.treeHash, git(repo.dir, 'rev-parse', 'main^{tree}'))

  const into = folder()
  await source.fetch(1, into)
  assert.equal(readFileSync(join(into, 'server.txt'), 'utf8'), 'one\n')
  await assert.rejects(source.fetch(3, folder()), /base 3 isn't in/)
})

test('fetch writes the files with their modes, and notes keep their own paragraphs', async () => {
  const repo = bareRepo()
  const target = gitBasePublishTarget(repo.url)
  const { dir } = tree({ 'run.sh': '#!/bin/sh\n' })
  execFileSync('chmod', ['755', join(dir, 'run.sh')])
  // The mode is part of the tree, so the hash is read after it is set.
  const treeHash = treeHashOf(dir)
  const published = await target.publish({ notes: 'line one\n\nline two', treeHash, treeDir: dir })
  assert.equal(published.base.notes, 'line one\n\nline two')
  assert.equal((await gitBaseSource(repo.url).latest())?.notes, 'line one\n\nline two')
  const into = folder()
  await gitBaseSource(repo.url).fetch(1, into)
  assert.ok((statSync(join(into, 'run.sh')).mode & 0o111) !== 0)
  await assert.rejects(target.publish({ notes: 'wrong', treeHash: tree({ x: '1' }).hash, treeDir: dir }), /hash to/)
})

test('a withdrawn base is no longer the latest but its files stay fetchable, and numbers keep rising', async () => {
  const repo = bareRepo()
  const target = gitBasePublishTarget(repo.url)
  const source = gitBaseSource(repo.url)
  await target.publish(publishInput('one', { 'a.txt': '1' }))
  await target.publish(publishInput('two', { 'a.txt': '2' }))

  assert.equal((await target.withdraw(2))?.n, 2)
  assert.equal((await source.latest())?.n, 1)
  assert.equal(git(repo.dir, 'log', '-1', '--format=%B', 'main'), 'Withdraw base 2\n\nOuro-Base-Withdrawn: 2')
  const commitsAfterWithdraw = git(repo.dir, 'rev-list', '--count', 'main')
  assert.equal((await target.withdraw(2))?.n, 2, 'withdrawing again is the same answer')
  assert.equal(git(repo.dir, 'rev-list', '--count', 'main'), commitsAfterWithdraw, 'and adds no commit')
  assert.equal(await target.withdraw(9), null)

  const into = folder()
  await source.fetch(2, into)
  assert.equal(readFileSync(join(into, 'a.txt'), 'utf8'), '2')
  // The same files as the withdrawn base are a new base, not the withdrawn one again.
  const republished = await target.publish(publishInput('two again', { 'a.txt': '2' }))
  assert.equal(republished.base.n, 3)
  assert.equal(republished.alreadyPublished, false)
  assert.equal((await source.latest())?.n, 3)

  await target.withdraw(3)
  await target.withdraw(1)
  assert.equal(await source.latest(), null)
})

test('a push is never forced: a repository that moved on refuses the publish', async () => {
  const repo = bareRepo()
  const target = gitBasePublishTarget(repo.url)
  await target.publish(publishInput('one', { 'a.txt': '1' }))
  // A hook stands in for another publisher pushing between this one's read and push.
  const hook = join(repo.dir, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\necho "refusing: moved on" >&2\nexit 1\n', { mode: 0o755 })
  await assert.rejects(target.publish(publishInput('two', { 'a.txt': '2' })), /push failed|refusing/)
  assert.equal((await gitBaseSource(repo.url).latest())?.n, 1)
})
