// Taking bases from a git repository (J-34, M6): a computer taking bases from a repository (a local bare one stands in for
// the public one) is offered the newest base, takes it and has it live, merged into its person's own branch. A withdrawn
// base is offered no more, and its files stay in the repository.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import type { BaseStatus } from '@ouro/contract'
import { BaseRepo } from '../server/src/adapters/base-repo-fixture.ts'
import { GuardianRun } from './guardian-harness.ts'
import { waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const baseDir = join(repoRoot, 'runs', `gb-${randomBytes(4).toString('hex')}`)
const repo = new BaseRepo(join(baseDir, 'bases.git'))
const taker = new GuardianRun()
const STARTER_PROTOCOL = 'server/protocols/starter.md'
let phone: AppClient

before(async () => {
  mkdirSync(baseDir, { recursive: true })
  // The computer installed Ouro as base 0; the repository's history grows from that commit.
  await taker.createSource()
  await taker.git('branch', 'ouro-base')
  await repo.create({ repo: taker.source, commit: (await taker.git('rev-parse', 'ouro-base')).trim() })
  // Base 1 is the same Ouro with a line added to the starter protocol.
  const tree = join(baseDir, 'base-1')
  cpSync(taker.source, tree, { recursive: true, filter: (path) => !path.includes('/.git') && !path.includes('node_modules') })
  appendFileSync(join(tree, STARTER_PROTOCOL), '\nBase 1 was here.\n')
  await repo.release(1, 'the starter protocol gains a line', tree)
  taker.extraOurodEnv = { OURO_BASE_REPO: repo.url }
  await taker.start()
  const first = await taker.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
  phone = await taker.pairDevice()
})

after(async () => {
  await taker.cleanup()
  rmSync(baseDir, { recursive: true, force: true })
})

/** The base as the phone sees it; null while the server is switching releases and doesn't answer. */
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

test('the computer is offered the base from the repository, takes it, and has it live and in its person\'s branch', async () => {
  const offered = await waitFor('base 1 to be offered', async () => (await takerBase())?.offered?.n === 1 && await takerBase())
  // The base is this source, so its version is this source's: read, not written here, since each release steps it.
  const version = (JSON.parse(readFileSync(join(repoRoot, 'server/package.json'), 'utf8')) as { version: string }).version
  assert.deepEqual(offered.offered, { n: 1, notes: 'the starter protocol gains a line', version })
  assert.equal(offered.integrated, 0)
  await phone.command('take_base_update', { n: 1 })
  await waitFor('base 1 to be integrated', async () => {
    const status = await takerBase()
    return status?.integrated === 1 && status.update.state === 'idle'
  }, 240_000)
  const head = (await taker.git('rev-parse', 'main')).trim()
  assert.ok((await taker.status()).active!.endsWith(head.slice(0, 8)), 'main is the commit that went live')
  assert.match(readFileSync(join(taker.source, STARTER_PROTOCOL), 'utf8'), /Base 1 was here\./)
})

test('a withdrawn base is offered no more, and its files stay in the repository', async () => {
  await repo.withdraw(1)
  assert.match(await repo.git(['show', `base-1:${STARTER_PROTOCOL}`]), /Base 1 was here\./)
  assert.equal((await takerBase())?.integrated, 1)
})
