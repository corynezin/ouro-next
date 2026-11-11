import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DistributionRepository } from './distribution.ts'
import { HubBases } from './bases.ts'
import { HubRefusal } from './hub.ts'
import { HubStore } from './store.ts'
import type { Account } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'ouro-hub-base-repo-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.invalid', ...args], { cwd, encoding: 'utf8' }).trim()

const configured = join(dir, 'configured')
mkdirSync(configured)
git(configured, 'init', '--quiet', '-b', 'main')
writeFileSync(join(configured, 'README.md'), 'configured\n')
git(configured, 'add', '-A')
git(configured, 'commit', '--quiet', '-m', 'configured')

const baseRepo = join(dir, 'bases')
mkdirSync(baseRepo)
git(baseRepo, 'init', '--quiet', '-b', 'main')
const baseRepoUrl = `file://${baseRepo}`

let repositories = 0
const newRepository = () => new DistributionRepository(join(dir, `distribution-${++repositories}.git`), { source: configured, reference: 'main' })

const tagInRepo = (n: number, text: string, name = `base-${n}`): void => {
  writeFileSync(join(baseRepo, 'file.txt'), text)
  git(baseRepo, 'add', '-A')
  git(baseRepo, 'commit', '--quiet', '--allow-empty', '-m', `Ouro base ${n}`)
  git(baseRepo, 'tag', '-a', '-m', `notes for ${text.trim()}`, name)
}
const withdrawInRepo = (n: number): void => void git(baseRepo, 'tag', '-a', '-m', 'withdrawn', `base-${n}-withdrawn`, `base-${n}`)

const commitMessage = (repository: DistributionRepository, commit: string) => execFileSync('git', ['--git-dir', repository.gitDir, 'log', '-1', '--format=%B', commit], { encoding: 'utf8' }).trim()
const fileOf = (repository: DistributionRepository, commit: string) => execFileSync('git', ['--git-dir', repository.gitDir, 'show', `${commit}:file.txt`], { encoding: 'utf8' })

test('computers start on the repository\'s newest base tag not withdrawn, and on the configured distribution before its first', async () => {
  const repository = newRepository()
  // No tags yet, and a lightweight one is no release.
  writeFileSync(join(baseRepo, 'file.txt'), 'untagged\n')
  git(baseRepo, 'add', '-A')
  git(baseRepo, 'commit', '--quiet', '-m', 'before bases')
  git(baseRepo, 'tag', 'base-1')
  assert.equal(commitMessage(repository, await repository.startingCommitFromBaseRepo(baseRepoUrl)).endsWith('Ouro-Base: 0'), true)
  git(baseRepo, 'tag', '-d', 'base-1')

  tagInRepo(1, 'one\n')
  tagInRepo(2, 'two\n')
  const onTwo = await repository.startingCommitFromBaseRepo(baseRepoUrl)
  assert.equal(commitMessage(repository, onTwo), 'Ouro base 2')
  assert.equal(fileOf(repository, onTwo), 'two\n')

  withdrawInRepo(2)
  const onOne = await repository.startingCommitFromBaseRepo(baseRepoUrl)
  assert.equal(fileOf(repository, onOne), 'one\n')
  assert.equal(execFileSync('git', ['--git-dir', repository.gitDir, 'cat-file', '-t', onTwo], { encoding: 'utf8' }).trim(), 'commit', 'the commit promised earlier is kept')

  tagInRepo(10, 'ten\n')
  assert.equal(fileOf(repository, await repository.startingCommitFromBaseRepo(baseRepoUrl)), 'ten\n')
  withdrawInRepo(10)
  withdrawInRepo(1)
  assert.match(commitMessage(repository, await repository.startingCommitFromBaseRepo(baseRepoUrl)), /Ouro-Base: 0$/)
})

test('a repository that can\'t be reached is an error, not a start on another base', async () => {
  await assert.rejects(newRepository().startingCommitFromBaseRepo(`file://${join(dir, 'nowhere')}`))
})

test('a hub whose computers take bases from a repository takes no publishing of its own', async () => {
  const store = new HubStore(join(dir, 'hub.db'))
  const account: Account = { id: 'a', name: 'a', createdAt: 1 }
  store.addInvite('invite', 1)
  store.signUp('invite', account, 'hash', { id: 'srv', accountId: 'a', label: 'a', primary: true, createdAt: 1, distributionCommit: 'c0ffee' }, null)
  store.grantPublishing('a', 1)
  const bases = new HubBases({ store, repository: newRepository(), dir: join(dir, 'hub-bases'), now: () => 1, baseRepo: baseRepoUrl })
  await assert.rejects(bases.publish(account, { notes: 'x', treeHash: 'y', filesTarBase64: '' }), (error) => error instanceof HubRefusal && /take their bases from a git repository/.test(error.message))
  assert.throws(() => bases.withdraw(account, 1), HubRefusal)
  store.close()
})
