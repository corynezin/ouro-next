import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HubBase, HubError, PublishBaseResult, SignupResult, WithdrawBaseResult } from '@ouro/contract'
import { HubBases } from './bases.ts'
import { DistributionRepository } from './distribution.ts'
import { Hub, HubRefusal } from './hub.ts'
import { hubHttpServer } from './http.ts'
import { Provisioning } from './provisioning.ts'
import type { Provisioner } from './provisioning.ts'
import { HubStore } from './store.ts'
import type { Account } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-bases-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], { cwd, encoding: 'utf8' }).trim()

let made = 0

/** The configured distribution, before the first base: one commit with some history behind it. */
const configured = join(dir, 'configured')
mkdirSync(configured)
git(configured, 'init', '--quiet', '-b', 'main')
writeFileSync(join(configured, 'README.md'), 'before\n')
git(configured, 'add', '-A')
git(configured, 'commit', '--quiet', '-m', 'earlier')
writeFileSync(join(configured, 'README.md'), 'configured\n')
git(configured, 'commit', '--quiet', '-am', 'configured')

const newRepository = (n: number) => new DistributionRepository(join(dir, `distribution-${n}.git`), { source: configured, reference: 'main' })

/**
 * Files as a publisher sends them: a commit exported with `git archive`, and the commit's own tree as the hash every
 * taker computes. One of them an ignore rule would leave out, and one is executable.
 */
function filesOf(contents: Record<string, string>): { tar: Buffer; treeHash: string } {
  const repo = join(dir, `repo-${++made}`)
  mkdirSync(repo)
  git(repo, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '*.log\n')
  writeFileSync(join(repo, 'kept.log'), 'ignored by the rules, but part of the base\n')
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts', 'run.sh'), 'echo run\n')
  chmodSync(join(repo, 'scripts', 'run.sh'), 0o755)
  for (const [name, content] of Object.entries(contents)) writeFileSync(join(repo, name), content)
  git(repo, 'add', '-A', '-f')
  git(repo, 'commit', '--quiet', '-m', 'base')
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo })
  return { tar, treeHash: git(repo, 'rev-parse', 'HEAD^{tree}') }
}

const publishing = (notes: string, files: { tar: Buffer; treeHash: string }) => ({ notes, treeHash: files.treeHash, filesTarBase64: files.tar.toString('base64') })

let stores = 0

function newBases() {
  const n = ++stores
  const store = new HubStore(join(dir, `hub-${n}.db`))
  const accounts: Account[] = []
  const addAccount = (name: string): Account => {
    const account: Account = { id: `account-${name}`, name, createdAt: 1 }
    store.addInvite(`invite-${name}`, 1)
    store.signUp(`invite-${name}`, account, `token-hash-${name}`, { id: `srv-${name}`, accountId: account.id, label: name, primary: true, createdAt: 1, distributionCommit: 'c0ffee' }, null)
    accounts.push(account)
    return account
  }
  const publisher = addAccount('publisher')
  assert.equal(store.grantPublishing(publisher.id, 1), true)
  const other = addAccount('other')
  const repository = newRepository(n)
  const bases = new HubBases({ store, repository, dir: join(dir, `bases-${n}`), now: () => 2 })
  return { store, bases, repository, publisher, other }
}

const refusedWith = (code: string) => (error: unknown) => error instanceof HubRefusal && error.code === code

test('a base published is offered, its files kept as sent, and the same files again make nothing new', async () => {
  const { bases, publisher } = newBases()
  assert.equal(bases.latest(), null)
  const one = filesOf({ 'README.md': 'one\n' })
  assert.deepEqual(await bases.publish(publisher, publishing('First.', one)), { base: { n: 1, notes: 'First.', treeHash: one.treeHash }, alreadyPublished: false })
  assert.deepEqual(bases.latest(), { n: 1, notes: 'First.', treeHash: one.treeHash })
  assert.deepEqual(readFileSync(bases.filesOf(1)), one.tar)
  assert.deepEqual(await bases.publish(publisher, publishing('First, retried.', one)), { base: { n: 1, notes: 'First.', treeHash: one.treeHash }, alreadyPublished: true })
  const two = filesOf({ 'README.md': 'two\n' })
  assert.equal((await bases.publish(publisher, publishing('Second.', two))).base.n, 2)
  assert.equal(bases.latest()!.n, 2)
})

test("a withdrawn base isn't offered, keeps its files and its number, and its files can be published again as a new base", async () => {
  const { bases, publisher } = newBases()
  const one = filesOf({ 'README.md': 'one\n' })
  const two = filesOf({ 'README.md': 'two\n' })
  await bases.publish(publisher, publishing('First.', one))
  await bases.publish(publisher, publishing('Second.', two))
  assert.deepEqual(bases.withdraw(publisher, 2), { base: { n: 2, notes: 'Second.', treeHash: two.treeHash } })
  assert.deepEqual(bases.withdraw(publisher, 2), { base: { n: 2, notes: 'Second.', treeHash: two.treeHash } }, 'withdrawing again is the same')
  assert.equal(bases.latest()!.n, 1)
  assert.deepEqual(readFileSync(bases.filesOf(2)), two.tar)
  assert.deepEqual(await bases.publish(publisher, publishing('Second, fixed.', two)), { base: { n: 3, notes: 'Second, fixed.', treeHash: two.treeHash }, alreadyPublished: false })
  bases.withdraw(publisher, 1)
  bases.withdraw(publisher, 3)
  assert.equal(bases.latest(), null)
  assert.equal((await bases.publish(publisher, publishing('Again.', one))).base.n, 4, 'numbers only rise')
})

test("only a publisher publishes or withdraws, and files that aren't the tree named are refused", async () => {
  const { bases, publisher, other } = newBases()
  const one = filesOf({ 'README.md': 'one\n' })
  await assert.rejects(bases.publish(other, publishing('Mine.', one)), refusedWith('not_publisher'))
  const two = filesOf({ 'README.md': 'two\n' })
  await assert.rejects(bases.publish(publisher, { ...publishing('Wrong.', one), treeHash: two.treeHash }), (error: Error) => refusedWith('invalid_request')(error) && error.message === `These files are the tree ${one.treeHash}, not ${two.treeHash}.`)
  await assert.rejects(bases.publish(publisher, { ...publishing('Not a tar.', one), filesTarBase64: Buffer.from('not a tar').toString('base64') }), refusedWith('invalid_request'))
  assert.equal(bases.latest(), null)
  await bases.publish(publisher, publishing('First.', one))
  assert.throws(() => bases.withdraw(other, 1), refusedWith('not_publisher'))
  assert.throws(() => bases.withdraw(publisher, 2), refusedWith('not_found'))
  assert.throws(() => bases.filesOf(2), refusedWith('not_found'))
  assert.equal(bases.latest()!.n, 1)
})

test('publishes at once each get a number of their own, and the same files at once make one base', async () => {
  const { bases, publisher } = newBases()
  const one = filesOf({ 'README.md': 'one\n' })
  const two = filesOf({ 'README.md': 'two\n' })
  const different = await Promise.all([bases.publish(publisher, publishing('A.', one)), bases.publish(publisher, publishing('B.', two))])
  assert.deepEqual(different.map((result) => result.base.n).sort(), [1, 2])
  for (const [result, files] of [[different[0]!, one], [different[1]!, two]] as const) assert.deepEqual(readFileSync(bases.filesOf(result.base.n)), files.tar)
  const three = filesOf({ 'README.md': 'three\n' })
  const same = await Promise.all([bases.publish(publisher, publishing('C.', three)), bases.publish(publisher, publishing('C, twice.', three))])
  assert.deepEqual(same[0]!.base, same[1]!.base)
  assert.equal(same[0]!.base.n, 3)
  assert.deepEqual(same.map((result) => result.alreadyPublished).sort(), [false, true])
})

/** A starting commit as a computer's copy of the source gets it: its parents, tree and base trailer. */
function commitShape(repository: DistributionRepository, commit: string): { parents: string; tree: string; base: string } {
  const [parents, tree, base] = git(dir, '--git-dir', repository.gitDir, 'log', '-1', '--format=%P|%T|%(trailers:key=Ouro-Base,valueonly)', commit).split('|')
  return { parents: parents!, tree: tree!, base: base! }
}

test('computers start from the base offered, as a root commit with its base number; before the first base, from the configured distribution as base 0', async () => {
  const { bases, repository, publisher } = newBases()
  const beforeBases = await repository.startingCommit(bases.latest())
  assert.deepEqual(commitShape(repository, beforeBases), { parents: '', tree: git(configured, 'rev-parse', 'HEAD^{tree}'), base: '0' })
  const atOnce = await Promise.all([repository.startingCommit(null), repository.startingCommit(null)])
  assert.deepEqual(atOnce, [beforeBases, beforeBases], 'made once, for every computer asked for meanwhile')

  const one = filesOf({ 'README.md': 'one\n' })
  await bases.publish(publisher, publishing('First.', one))
  const fromOne = await repository.startingCommit(bases.latest())
  assert.deepEqual(commitShape(repository, fromOne), { parents: '', tree: one.treeHash, base: '1' })
  const two = filesOf({ 'README.md': 'two\n' })
  await bases.publish(publisher, publishing('Second.', two))
  assert.deepEqual(commitShape(repository, await repository.startingCommit(bases.latest())), { parents: '', tree: two.treeHash, base: '2' })
  bases.withdraw(publisher, 2)
  assert.equal(await repository.startingCommit(bases.latest()), fromOne, 'a withdrawn base is no longer started from')

  // A computer's copy, as the provisioners make it: the commit on main, and ouro-base there too.
  const copy = join(dir, `copy-${made}`)
  mkdirSync(copy)
  git(copy, 'init', '--quiet', '-b', 'main')
  git(copy, 'fetch', '--quiet', '--no-tags', repository.gitDir, fromOne)
  git(copy, 'checkout', '--quiet', '-B', 'main', fromOne)
  assert.equal(readFileSync(join(copy, 'README.md'), 'utf8'), 'one\n')
  assert.equal(git(copy, 'log', '--format=%s'), 'Ouro base 1')
})

/** Computers made instantly: only sign-up is needed here. */
const instantProvisioner: Provisioner = {
  create: async () => {},
  upload: async () => {},
  install: async () => {},
  setup: async () => {},
  service: async () => {},
  address: async () => 'http://127.0.0.1:1',
  startPairing: async () => ({ code: 'aaaa-bbbb', expiresAt: 9e15 }),
  hasPairedPhone: async () => false,
  destroy: async () => {},
}

test('over HTTP: anyone reads bases; a publisher publishes and withdraws with its token; refusals in the contract shape', async (t) => {
  const store = new HubStore(join(dir, `hub-${++stores}.db`))
  const provisioning = new Provisioning(store, instantProvisioner, () => {})
  const hub = new Hub({ store, provisioner: instantProvisioner, provisioning, serverLimit: null, distributionCommit: async () => 'c0ffee', now: () => 1, log: () => {} })
  const bases = new HubBases({ store, repository: newRepository(stores), dir: join(dir, `bases-${stores}`), now: () => 2 })
  const internal: Error[] = []
  const server = hubHttpServer({ hub, bases }, (error) => internal.push(error))
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  t.after(() => { server.closeAllConnections(); server.close() })
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1`
  const call = (method: string, path: string, body?: unknown, token?: string) => fetch(`${root}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const errorOf = async (response: Response) => HubError.parse(await response.json()).error.code

  store.addInvite('aaaa-bbbb-cccc', 1)
  store.addInvite('dddd-eeee-ffff', 1)
  const publisher = SignupResult.parse(await (await call('POST', '/signup', { invite: 'aaaa-bbbb-cccc', name: 'Ada' })).json())
  const other = SignupResult.parse(await (await call('POST', '/signup', { invite: 'dddd-eeee-ffff', name: 'Eve' })).json())
  await provisioning.settled()
  store.grantPublishing(publisher.accountId, 1)

  const none = await call('GET', '/bases/latest')
  assert.equal(none.status, 204)
  assert.equal(await none.text(), '')
  const one = filesOf({ 'README.md': 'one\n' })
  const unsigned = await call('POST', '/bases', publishing('First.', one))
  assert.equal(unsigned.status, 401)
  const notPublisher = await call('POST', '/bases', publishing('First.', one), other.token)
  assert.equal(notPublisher.status, 403)
  assert.equal(await errorOf(notPublisher), 'not_publisher')
  const incomplete = await call('POST', '/bases', { notes: 'First.', treeHash: one.treeHash }, publisher.token)
  assert.equal(incomplete.status, 400)
  const published = await call('POST', '/bases', publishing('First.', one), publisher.token)
  assert.equal(published.status, 200)
  assert.deepEqual(PublishBaseResult.parse(await published.json()), { base: { n: 1, notes: 'First.', treeHash: one.treeHash }, alreadyPublished: false })

  assert.deepEqual(HubBase.parse(await (await call('GET', '/bases/latest')).json()), { n: 1, notes: 'First.', treeHash: one.treeHash })
  const files = await call('GET', '/bases/1/files')
  assert.equal(files.status, 200)
  assert.equal(files.headers.get('content-type'), 'application/x-tar')
  assert.deepEqual(Buffer.from(await files.arrayBuffer()), one.tar)
  for (const missing of ['2', '0', '01', 'abc']) {
    const response = await call('GET', `/bases/${missing}/files`)
    assert.equal(response.status, 404, missing)
    assert.equal(await errorOf(response), 'not_found')
  }

  assert.equal((await call('POST', '/bases/1/withdraw', undefined, other.token)).status, 403)
  assert.equal((await call('POST', '/bases/2/withdraw', undefined, publisher.token)).status, 404)
  const withdrawn = await call('POST', '/bases/1/withdraw', undefined, publisher.token)
  assert.deepEqual(WithdrawBaseResult.parse(await withdrawn.json()), { base: { n: 1, notes: 'First.', treeHash: one.treeHash } })
  assert.equal((await call('GET', '/bases/latest')).status, 204)
  assert.equal((await call('GET', '/bases/1/files')).status, 200, "a withdrawn base's files stay")
  assert.deepEqual(internal, [])
})
