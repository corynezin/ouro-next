import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import type { SourceBackup } from '@ouro/contract'
import { httpGitHubApi } from '../adapters/github-api.ts'
import type { GuardianClient } from '../adapters/guardian-client.ts'
import { startStandInGitHub } from '../adapters/stand-in-github.ts'
import type { StandInGitHub } from '../adapters/stand-in-github.ts'
import { CommandRefused } from './failure.ts'
import { SourceBackupKeeper } from './source-backup.ts'
import type { SourceBackupConfig } from './source-backup.ts'

const made: string[] = []
let github: StandInGitHub
// A new GitHub account for each test, so that the names it has are the ones the test gave it.
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-stand-in-github-'))
  made.push(dir)
  github = await startStandInGitHub(dir)
})
afterEach(async () => {
  await github.close()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function commit(root: string, file: string): void {
  writeFileSync(join(root, file), `${file}\n`)
  git(root, 'add', file)
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `add ${file}`)
}

/** A person's source: a base-1 commit that `ouro-base` is at and `base-1` tags, and `main` on it; two more commits when `own`. */
function source(own: number): string {
  const root = join(mkdtempSync(join(tmpdir(), 'ouro-backup-source-')), 'source')
  made.push(join(root, '..'))
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'base.txt')
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'tag', '-a', '-m', 'one', 'base-1')
  git(root, 'branch', 'ouro-base')
  for (let i = 0; i < own; i++) commit(root, `mine-${i}.txt`)
  return root
}

interface Fixture {
  keeper: SourceBackupKeeper
  keeperConfig: SourceBackupConfig
  root: string
  changes: number
  liveCommit: { value: string | null }
  clock: { now: number }
  githubConnected: { value: boolean }
}

function fixture(own: number, retryDelaysMs: number[] = [0, 0]): Fixture {
  const root = source(own)
  const state: Fixture = { root, changes: 0, liveCommit: { value: null }, clock: { now: 0 }, githubConnected: { value: true }, keeper: null as never, keeperConfig: null as never }
  const guardian = { confirmedLiveCommit: async () => state.liveCommit.value } as GuardianClient
  state.keeperConfig = {
    sourceRoot: root,
    baseRepositoryName: 'ouro-next',
    firstPushRetryDelaysMs: retryDelaysMs,
    api: httpGitHubApi(github.apiUrl),
    githubToken: async () => (state.githubConnected.value ? 'stand-in-token' : null),
    githubState: () => (state.githubConnected.value ? 'connected' : 'not_connected'),
    guardian,
    now: () => state.clock.now,
    changed: () => { state.changes++ },
    log: () => {},
  }
  state.keeper = new SourceBackupKeeper(state.keeperConfig)
  return state
}

const statusOf = (f: Fixture): SourceBackup => f.keeper.status()
const tagsIn = (bare: string) => git(bare, 'tag', '--list').split('\n').filter(Boolean)

test('the source is not backed up only when it has commits on no base', () => {
  assert.deepEqual(statusOf(fixture(0)), { state: 'nothing_to_back_up' })
  assert.deepEqual(statusOf(fixture(2)), { state: 'not_backed_up', github: 'connected' })
  const f = fixture(2)
  f.githubConnected.value = false
  f.keeper.refresh()
  assert.deepEqual(statusOf(f), { state: 'not_backed_up', github: 'not_connected' })
  // A commit that is in a base's history is on that base: merged base commits don't count as the person's.
  git(f.root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'tag', '-a', '-m', 'two', 'base-2', 'HEAD', '-f')
  f.keeper.refresh()
  assert.deepEqual(statusOf(f), { state: 'nothing_to_back_up' })
})

test('a copy that takes no bases has nothing to back up', async () => {
  const f = fixture(2)
  git(f.root, 'branch', '-D', 'ouro-base')
  f.keeper.refresh()
  assert.deepEqual(statusOf(f), { state: 'not_applicable' })
  await assert.rejects(f.keeper.create(), (error) => error instanceof CommandRefused && error.code === 'source_backup_not_applicable')
})

test('making the backup creates a private repository, makes it the backup remote and pushes the branch and the base tags', async () => {
  const f = fixture(2)
  await f.keeper.create()
  assert.deepEqual(statusOf(f), { state: 'backed_up', repository: github.repositoryPath('ouro-next-private'), lastPushedAt: 0, behind: false, lastPushError: null })
  assert.equal(github.requestedPrivate.at(-1), true)
  assert.ok(github.authorizations.at(-1)?.startsWith('Bearer '))
  const bare = github.repositoryPath('ouro-next-private')
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), git(f.root, 'rev-parse', 'HEAD'))
  assert.deepEqual(tagsIn(bare), ['base-1'])
  assert.ok(f.changes > 0, 'the server entity is told it changed')
  await f.keeper.create()
  assert.equal(statusOf(f).state, 'backed_up', 'doing it again finds the backup')
})

test('while the copy is made the status says so, a second request is refused, and the push time is kept', async () => {
  const f = fixture(1)
  f.clock.now = 1_234
  const seen: string[] = []
  const first = f.keeper.create()
  seen.push(statusOf(f).state)
  await assert.rejects(f.keeper.create(), (error) => error instanceof CommandRefused && error.code === 'source_backup_in_progress')
  await first
  assert.deepEqual(seen, ['making_private_copy'])
  assert.deepEqual(statusOf(f), { state: 'backed_up', repository: github.repositoryPath('ouro-next-private'), lastPushedAt: 1_234, behind: false, lastPushError: null })
  const restarted = new SourceBackupKeeper(f.keeperConfig).status()
  assert.equal(restarted.state === 'backed_up' && restarted.lastPushedAt, 1_234, 'the push time is in the source, not in memory')
})

test('the private copy is never named as the base repository: a taken name gets the next number, and none free is an error that leaves no backup', async () => {
  github.takeName('ouro-next-private')
  const f = fixture(1)
  await f.keeper.create()
  assert.equal(git(github.repositoryPath('ouro-next-private-2'), 'rev-parse', 'refs/heads/main'), git(f.root, 'rev-parse', 'HEAD'))
  assert.deepEqual(statusOf(f), { state: 'backed_up', repository: github.repositoryPath('ouro-next-private-2'), lastPushedAt: 0, behind: false, lastPushError: null })
  assert.equal(github.requestedNames.includes('ouro-next'), false, 'the base repository\'s name is never asked for')
  for (let n = 2; n <= 20; n++) github.takeName(`ouro-next-private-${n}`)
  const g = fixture(1)
  await assert.rejects(g.keeper.create(), (error) => error instanceof CommandRefused && /already has repositories named ouro-next-private to ouro-next-private-20/.test(error.message))
  assert.equal(statusOf(g).state, 'not_backed_up')
})

test('a repository GitHub just made may refuse the first pushes: they are tried again, and the copy is made', async () => {
  github.refuseFirstPushesOfNewRepositories(2)
  const f = fixture(1)
  await f.keeper.create()
  assert.deepEqual(statusOf(f), { state: 'backed_up', repository: github.repositoryPath('ouro-next-private'), lastPushedAt: 0, behind: false, lastPushError: null })
  assert.equal(git(github.repositoryPath('ouro-next-private'), 'rev-parse', 'refs/heads/main'), git(f.root, 'rev-parse', 'HEAD'))
})

test('a first push that keeps being refused shows a plain reason, and git\'s own output goes to the log', async () => {
  github.refuseFirstPushesOfNewRepositories(10)
  const logged: { event: string; fields: Record<string, unknown> }[] = []
  const f = fixture(1)
  f.keeper = new SourceBackupKeeper({ ...f.keeperConfig, log: (event, fields) => logged.push({ event, fields }) })
  await assert.rejects(f.keeper.create(), (error) => error instanceof CommandRefused && error.code === 'push_failed' && !/refused|rejected|remote/i.test(error.message))
  const status = statusOf(f)
  assert.equal(status.state === 'backed_up' && status.lastPushError !== null && !/refused|rejected|remote/i.test(status.lastPushError), true)
  assert.ok(logged.some((entry) => entry.event === 'source_push_refused' && /remote rejected/.test(String(entry.fields.gitOutput))), 'the raw output is in the log')
})

test('without GitHub connected nothing is made, and pushing before there is a backup is refused', async () => {
  const f = fixture(1)
  f.githubConnected.value = false
  await assert.rejects(f.keeper.create(), (error) => error instanceof CommandRefused && error.code === 'github_not_connected')
  assert.equal(git(f.root, 'remote').trim(), '')
  assert.equal(await f.keeper.pushNow().then(() => 'pushed', (error: CommandRefused) => error.code), 'no_source_backup')
})

test('only a version the guardian confirmed live is pushed after a deploy, and a failed push waits before trying again', async () => {
  const f = fixture(1)
  await f.keeper.create()
  const bare = github.repositoryPath('ouro-next-private')
  commit(f.root, 'later.txt')
  const head = git(f.root, 'rev-parse', 'HEAD')
  f.clock.now = 20_000
  f.liveCommit.value = null
  f.keeper.tick()
  await settle()
  assert.notEqual(git(bare, 'rev-parse', 'refs/heads/main'), head, 'not confirmed live: not pushed')
  assert.equal((statusOf(f) as { behind: boolean }).behind, true)

  f.liveCommit.value = head
  f.clock.now = 40_000
  f.keeper.tick()
  await settle()
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), head)
  assert.equal((statusOf(f) as { behind: boolean }).behind, false)

  // The backup's copy of a base tag moved on: the push is refused, shown, and tried again only a minute later.
  const other = git(f.root, 'rev-parse', 'HEAD~1')
  git(bare, 'tag', '-f', 'base-1', other)
  commit(f.root, 'again.txt')
  f.liveCommit.value = git(f.root, 'rev-parse', 'HEAD')
  f.clock.now = 60_000
  f.keeper.tick()
  await settle()
  const failed = statusOf(f)
  assert.equal(failed.state === 'backed_up' && failed.lastPushError !== null, true)
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), head, 'the failed push left the backup as it was')
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000))
