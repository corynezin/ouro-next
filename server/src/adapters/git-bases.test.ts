import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { BaseRepo } from './base-repo-fixture.ts'
import { gitBaseSource } from './git-bases.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-git-bases-test-'))
  made.push(dir)
  return dir
}

async function bareRepo(): Promise<BaseRepo> {
  const repo = new BaseRepo(join(folder(), 'bases.git'))
  await repo.create()
  return repo
}

function files(contents: Record<string, string>): string {
  const dir = folder()
  for (const [name, text] of Object.entries(contents)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text) }
  return dir
}

const tagsOf = (root: string) => execFileSync('git', ['-C', root, 'tag', '--list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)

test('an empty repository, and one with only a lightweight tag, offer nothing', async () => {
  const repo = await bareRepo()
  assert.equal(await gitBaseSource(repo.url).latest(), null)
  const commit = await repo.release(1, 'one', files({ 'a.txt': '1' }))
  await repo.git(['tag', '-d', 'base-1'])
  await repo.git(['tag', 'base-1', commit])
  assert.equal(await gitBaseSource(repo.url).latest(), null, 'a lightweight tag is not a release')
})

test('the newest annotated tag is the latest base: its commit, and its message as the notes with their paragraphs', async () => {
  const repo = await bareRepo()
  const source = gitBaseSource(repo.url)
  await repo.release(1, 'the first\n\nwith detail', files({ 'a.txt': '1' }))
  const second = await repo.release(2, 'the second', files({ 'a.txt': '2' }))
  await repo.release(10, 'the tenth', files({ 'a.txt': '10' }))
  assert.deepEqual(await source.latest(), { n: 10, notes: 'the tenth', version: null, commit: await repo.git(['rev-parse', 'base-10^{commit}']) })
  await repo.withdraw(10)
  assert.deepEqual(await source.latest(), { n: 2, notes: 'the second', version: null, commit: second })
  await repo.withdraw(2)
  assert.equal((await source.latest())?.notes, 'the first\n\nwith detail')
})

test("a base's version is the one in its server/package.json, when it has one", async () => {
  const repo = await bareRepo()
  await repo.release(1, 'versioned', files({ 'server/package.json': '{\n  "name": "@ouro/server",\n  "version": "0.6.0"\n}\n' }))
  assert.equal((await gitBaseSource(repo.url).latest())?.version, '0.6.0')
  await repo.release(2, 'placeholder', files({ 'server/package.json': '{ "name": "@ouro/server", "version": "0.0.0" }' }))
  assert.equal((await gitBaseSource(repo.url).latest())?.version, null, '0.0.0 is no version')
})

test('numbers rise past withdrawn bases, and a withdrawal of every base leaves nothing offered', async () => {
  const repo = await bareRepo()
  await repo.release(1, 'one', files({ 'a.txt': '1' }))
  await repo.withdraw(1)
  assert.equal(await gitBaseSource(repo.url).latest(), null)
  await repo.release(2, 'two', files({ 'a.txt': '1' }))
  assert.equal((await gitBaseSource(repo.url).latest())?.n, 2)
})

test('fetching brings every base tag, withdrawn ones too, and their history, into a copy of the source', async () => {
  const repo = await bareRepo()
  await repo.release(1, 'one', files({ 'a.txt': '1' }))
  const second = await repo.release(2, 'two', files({ 'a.txt': '2' }))
  await repo.withdraw(2)
  const root = folder()
  execFileSync('git', ['init', '-q', root])
  await gitBaseSource(repo.url).fetchTagsInto(root)
  assert.deepEqual(tagsOf(root), ['base-1', 'base-2', 'base-2-withdrawn'])
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'base-2^{commit}'], { encoding: 'utf8' }).trim(), second)
  await gitBaseSource(repo.url).fetchTagsInto(root)
})

test('a repository that can\'t be reached is an error, not no base', async () => {
  await assert.rejects(gitBaseSource(`file://${join(folder(), 'nowhere')}`).latest(), /git ls-remote failed/)
})
