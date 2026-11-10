// Bases through a git repository (J-34, M6): the publisher computer publishes its live version as a commit on the main
// branch of a repository (a local bare one stands in for the public repository), and another computer, taking bases from
// the same repository, is offered it, takes it and has it live, merged into its person's own branch. A withdrawn base is
// offered no more, and the files stay in the repository.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import type { BaseStatus } from '@ouro/contract'
import { GuardianRun } from './guardian-harness.ts'
import { waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')

const id = randomBytes(4).toString('hex')
const baseDir = join(repoRoot, 'runs', `gb-${id}`)
const repoDir = join(baseDir, 'bases.git')
const repoUrl = `file://${repoDir}`

const publisher = new GuardianRun()
const taker = new GuardianRun()
let phone: AppClient

const MASTER_PROTOCOL = 'server/protocols/master.md'
const RULE = { ships: ['server', 'packages', '.gitignore'], internal: ['docs'], dependencies: ['node_modules'], checks: ['test -f server/package.json'] }

const repoGit = async (...args: string[]) => (await execFileAsync('git', ['--git-dir', repoDir, ...args])).stdout.trim()

async function refusal(run: GuardianRun, ...args: string[]): Promise<string> {
  try {
    await run.cli(...args)
  } catch (error) {
    return (error as { stderr: string }).stderr
  }
  assert.fail(`ouro ${args.join(' ')} succeeded`)
}

before(async () => {
  mkdirSync(baseDir, { recursive: true })
  await execFileAsync('git', ['init', '--quiet', '--bare', '--initial-branch=main', repoDir])
  // Both computers start from the same Ouro. The taker installed it as base 0; the publisher's live version adds a line.
  await taker.createSource()
  await taker.git('commit', '-q', '--amend', '-m', 'the starting point', '-m', 'Ouro-Base: 0')
  await taker.git('branch', 'ouro-base')
  await publisher.createSource()
  writeFileSync(join(publisher.source, 'distribution.json'), JSON.stringify(RULE))
  appendFileSync(join(publisher.source, MASTER_PROTOCOL), '\nBase 1 was here.\n')
  await publisher.commitAll('base 1')

  const privateNames = join(publisher.dir, 'private-names')
  writeFileSync(privateNames, `${['zor', 'blax'].join('')}\n`)
  publisher.extraOurodEnv = { OURO_BASE_REPO: repoUrl, OURO_BASE_REPO_PUSH_URL: repoUrl, OURO_PRIVATE_NAMES_FILE: privateNames }
  await publisher.start()
  const first = await publisher.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the publisher's first release didn't go live: ${first.reason}`)
})

after(async () => {
  await publisher.cleanup()
  await taker.cleanup()
  rmSync(baseDir, { recursive: true, force: true })
})

test('the publisher publishes its live version as the first commit on the repository\'s main branch', async () => {
  assert.equal(await publisher.cli('base', 'publish', 'the master protocol gains a line'), 'published base 1: the master protocol gains a line\n')
  assert.equal(await repoGit('log', '-1', '--format=%an <%ae>%n%B', 'main'), 'Ouro Next <bases@ouro-next.invalid>\nthe master protocol gains a line\n\nOuro-Base: 1')
  assert.equal(await publisher.cli('base', 'publish', 'again'), 'base 1 already has these files: the master protocol gains a line\n')
  assert.equal(await repoGit('rev-list', '--count', 'main'), '1')
})
/** The base as the taker's phone sees it; null while the server is switching releases and doesn't answer. */
async function takerBase(): Promise<Extract<BaseStatus, { kind: 'taker' }> | null> {
  try {
    const status = (await phone.snapshot()).server.release.base
    assert.equal(status.kind, 'taker')
    return status.kind === 'taker' ? status : null
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    return null
  }
}

test('another computer is offered the base from the repository, takes it, and has it live and in its person\'s branch', async () => {
  taker.extraOurodEnv = { OURO_BASE_REPO: repoUrl }
  await taker.start()
  const first = await taker.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the taker's first release didn't go live: ${first.reason}`)
  phone = await taker.pairDevice()

  const offered = await waitFor('base 1 to be offered', async () => (await takerBase())?.offered?.n === 1 && await takerBase())
  assert.deepEqual(offered.offered, { n: 1, notes: 'the master protocol gains a line' })
  assert.equal(offered.integrated, 0)
  await phone.command('take_base_update', { n: 1 })
  await waitFor('base 1 to be integrated', async () => {
    const status = await takerBase()
    return status?.integrated === 1 && status.update.state === 'idle'
  }, 240_000)
  const head = (await taker.git('rev-parse', 'main')).trim()
  assert.ok((await taker.status()).active!.endsWith(head.slice(0, 8)), 'the taker\'s main is the commit that went live')
  assert.match(readFileSync(join(taker.source, MASTER_PROTOCOL), 'utf8'), /Base 1 was here\./)
  assert.equal((await taker.git('show', 'ouro-base:distribution.json').catch(() => 'absent')), 'absent', 'what doesn\'t ship isn\'t in the base')
})

test('a withdrawn base is offered no more but its files stay in the repository, and withdrawing a base it hasn\'t got is refused', async () => {
  assert.equal(await publisher.cli('base', 'withdraw', '1'), 'base 1 is withdrawn: it is offered no more\n')
  assert.equal(await repoGit('log', '-1', '--format=%B', 'main'), 'Withdraw base 1\n\nOuro-Base-Withdrawn: 1')
  assert.match(await repoGit('show', 'main~1:' + MASTER_PROTOCOL), /Base 1 was here\./)
  assert.match(await refusal(publisher, 'base', 'withdraw', '9'), /there is no base 9 \(not_found\)/)
})
