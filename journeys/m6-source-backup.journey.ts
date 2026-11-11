// Backing up the person's changes (J-35, M6): a server whose source has commits on no base and no private copy says so; once
// GitHub is connected it makes a private repository (a stand-in GitHub answers locally), pushes the branch and the base tags
// to it, and pushes each version the guardian confirms live. Nothing of this touches a deploy.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { SourceBackup } from '@ouro/contract'
import { startStandInGitHub } from '../server/src/adapters/stand-in-github.ts'
import type { StandInGitHub } from '../server/src/adapters/stand-in-github.ts'
import { CommandFailed, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'
import { GuardianRun } from './guardian-harness.ts'

const run = new GuardianRun()
const accountsDir = join(run.dir, 'accounts')
const DEFAULT_PROTOCOL = 'server/protocols/default.md'
let github: StandInGitHub
let phone: AppClient

before(async () => {
  mkdirSync(run.dir, { recursive: true })
  github = await startStandInGitHub(join(run.dir, 'github'))
  // The computer installed Ouro at base 1, then changed something of its own.
  await run.createSource()
  await run.git('tag', '-a', '-m', 'the first base', 'base-1')
  await run.git('branch', 'ouro-base')
  run.editSource(DEFAULT_PROTOCOL, 'Work in {{folder}} unless the task says otherwise.', 'Work in {{folder}} unless the task says otherwise. Keep notes short.')
  await run.commitAll('my own wording')
  run.extraOurodEnv = { OURO_GITHUB_API_URL: github.apiUrl }
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
  phone = await run.pairDevice()
})

after(async () => {
  await run.cleanup()
  await github.close()
  rmSync(run.dir, { recursive: true, force: true })
})

const backup = async (): Promise<SourceBackup> => (await phone.snapshot()).server.sourceBackup
const head = async () => (await run.git('rev-parse', 'main')).trim()
const failureCode = async (promise: Promise<unknown>) => await promise.then(() => null, (error: unknown) => (error instanceof CommandFailed ? error.code : 'other'))

test('own changes with no private copy are flagged, and a private copy needs GitHub connected first', async () => {
  assert.deepEqual(await backup(), { state: 'not_backed_up', github: 'not_connected' })
  assert.equal(await failureCode(phone.command('create_source_backup', {})), 'github_not_connected')
  assert.equal(await failureCode(phone.command('push_source_backup', {})), 'no_source_backup')
  assert.deepEqual(await backup(), { state: 'not_backed_up', github: 'not_connected' })
})

test('connected, a private repository is made, and the branch and the base tags are pushed to it', async () => {
  mkdirSync(accountsDir, { recursive: true })
  appendFileSync(join(accountsDir, 'accepted'), 'ghp_backup\n')
  assert.equal((await phone.integration('POST', 'github/token', { token: 'ghp_backup' })).status, 200)
  assert.deepEqual(await backup(), { state: 'not_backed_up', github: 'connected' }, 'the status changes as GitHub connects, not on a later check')

  const made = await phone.command('create_source_backup', {})
  const madeStatus = made.server.sourceBackup
  assert.ok(madeStatus.state === 'backed_up' && typeof madeStatus.lastPushedAt === 'number', 'it says when the copy was last pushed')
  assert.deepEqual({ ...madeStatus, lastPushedAt: 0 }, { state: 'backed_up', repository: github.repositoryPath('ouro-next-private'), lastPushedAt: 0, behind: false, lastPushError: null })
  assert.equal(github.requestedPrivate.at(-1), true, 'the repository was asked for private')
  assert.equal(github.authorizations.at(-1), 'Bearer ghp_backup')
  const bare = github.repositoryPath('ouro-next-private')
  const git = (...args: string[]) => run.git('--git-dir', bare, ...args)
  assert.equal((await git('rev-parse', 'refs/heads/main')).trim(), await head())
  assert.equal((await git('tag', '--list')).trim(), 'base-1')
  assert.equal((await run.git('remote')).trim(), 'backup')
})

test('a version that goes live is pushed to the private copy by itself', async () => {
  const before = await backup()
  const lastPushedBefore = before.state === 'backed_up' ? before.lastPushedAt ?? 0 : 0
  run.editSource(DEFAULT_PROTOCOL, 'Keep notes short.', 'Keep notes very short.')
  const commit = await run.commitAll('shorter notes')
  const started = await run.control('POST', '/deploy', { reference: 'main', requestedBy: null }) as { id: string }
  assert.equal((await run.deploymentOutcome(started.id)).phase, 'live')
  const pushed = async () => (await run.git('--git-dir', github.repositoryPath('ouro-next-private'), 'rev-parse', 'refs/heads/main')).trim()
  await waitFor('the live version to reach the private copy', async () => await pushed() === commit, 60_000)
  await waitFor('the phone to see it backed up', async () => {
    const status = await backup()
    return status.state === 'backed_up' && !status.behind
  }, 60_000)
  const after = await backup()
  assert.ok(after.state === 'backed_up' && after.lastPushedAt !== null && after.lastPushedAt >= lastPushedBefore, 'the push time moves on')
})
