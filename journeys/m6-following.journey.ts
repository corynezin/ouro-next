// Following a branch: a person sets the machine to follow a branch of its remote, and new commits there go live by
// themselves through the usual checks. A commit that fails is skipped until a newer one comes; one that only started too
// slowly is tried again later; an agent can't choose what is followed; and following stops when it's turned off.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { GuardianRun } from './guardian-harness.ts'
import type { DeploymentRecord } from './guardian-harness.ts'
import { waitFor } from './harness.ts'

const execFileAsync = promisify(execFile)
const run = new GuardianRun()
/** The remote the person's copy came from, and another clone of it where commits are made and pushed. */
const upstream = join(run.dir, 'upstream.git')
const elsewhere = join(run.dir, 'elsewhere')
/** While this file exists, a release made slow by `slowToStart` takes longer to start than the guardian waits. */
const slowMarker = join(run.dir, 'start-slowly')

const gitIn = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-c', 'user.name=journey', '-c', 'user.email=journey@invalid', ...args], { cwd })).stdout.trim()

before(async () => {
  await run.createSource()
  await gitIn(run.dir, 'init', '-q', '--bare', '-b', 'main', upstream)
  await run.git('remote', 'add', 'origin', upstream)
  await run.git('push', '-q', 'origin', 'main')
  await gitIn(run.dir, 'clone', '-q', upstream, elsewhere)
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
})
after(() => run.cleanup())

/** A commit made elsewhere and pushed to the remote: the person's copy only learns of it by fetching. */
async function pushed(message: string, edit: (read: (path: string) => string, write: (path: string, text: string) => void) => void): Promise<string> {
  edit((path) => readFileSync(join(elsewhere, path), 'utf8'), (path, text) => writeFileSync(join(elsewhere, path), text))
  await gitIn(elsewhere, 'commit', '-q', '-am', message)
  await gitIn(elsewhere, 'push', '-q', 'origin', 'main')
  return await gitIn(elsewhere, 'rev-parse', 'HEAD')
}

const replacing = (path: string, from: string, to: string) => (read: (path: string) => string, write: (path: string, text: string) => void) => {
  const text = read(path)
  assert.ok(text.includes(from), `${path} doesn't contain the text to replace`)
  write(path, text.replace(from, to))
}

const attemptsOf = (commit: string): DeploymentRecord[] => run.deployments().filter((record) => record.commit === commit)
const endedAs = (commit: string, phase: string, timeoutMs = 150_000) => waitFor(`${commit.slice(0, 8)} ${phase}`, () => attemptsOf(commit).find((record) => record.phase === phase), timeoutMs)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const activeCommit = async () => {
  const { active } = await run.status()
  return run.deployments().findLast((record) => record.releaseId === active && record.commit !== null)?.commit
}

test('only the person chooses what this machine follows', async () => {
  const asAgent = execFileAsync(join(run.home, 'bin/ouro'), ['update', 'follow', 'main'], { env: { ...run.cliEnv(), OURO_AGENT_CREDENTIAL: 'an-agent' } })
  await assert.rejects(asAgent, (error: { stderr: string }) => /only the person can choose what this machine follows/.test(error.stderr))
  assert.match(await run.cli('update'), /^not following a branch/)

  await assert.rejects(run.cli('update', 'follow', 'main', 'nowhere'), (error: { stderr: string }) => /no remote named nowhere/.test(error.stderr))
  assert.match(await run.cli('update', 'follow', 'main'), /^following origin\/main: up to date at [0-9a-f]{8}$/m)
})

test('a commit pushed to the followed branch goes live by itself', async () => {
  const commit = await pushed('revised instructions', replacing('server/protocols/default.md', 'Work in {{folder}} unless the task says otherwise.', 'Work in {{folder}} unless the task says otherwise. (Followed.)'))
  const live = await endedAs(commit, 'live')
  assert.equal(live.requestedBy, null, 'nobody asked: the machine followed')
  assert.equal(await activeCommit(), commit)
  assert.match(await run.cli('update'), new RegExp(`up to date at ${commit.slice(0, 8)}`))
})

test("a commit that fails is skipped, not tried again, and the next one goes live", async () => {
  const broken = await pushed('a type error', replacing('server/src/app/render.ts', 'const STOP_WORDS', 'const typeError: number = "not a number"\nconst STOP_WORDS'))
  await endedAs(broken, 'build_failed')
  await pause(4_000)
  assert.equal(attemptsOf(broken).filter((record) => record.phase === 'build_failed').length, 1, 'tried once only')
  assert.match(await run.cli('update'), new RegExp(`${broken.slice(0, 8)} ended build failed here before, so it waits for a newer commit`))

  const fixed = await pushed('the type error fixed', replacing('server/src/app/render.ts', 'const typeError: number = "not a number"\n', ''))
  await endedAs(fixed, 'live')
  assert.equal(await activeCommit(), fixed)
})

test('a commit that only started too slowly is tried again later, and goes live then', async () => {
  writeFileSync(slowMarker, '')
  try {
    const slow = await pushed('slow to start while the marker is there', replacing('server/src/bin/ourod.ts', 'const startedAt = performance.now()\n', `const startedAt = performance.now()\nif (process.env.OURO_RELEASE_ID !== 'acceptance' && (await import('node:fs')).existsSync(${JSON.stringify(slowMarker)})) await new Promise((done) => setTimeout(done, 120_000))\n`))
    const rolledBack = await endedAs(slow, 'rolled_back')
    assert.equal(rolledBack.startedTooSlowly, true)
    assert.match(await run.cli('update'), new RegExp(`${slow.slice(0, 8)} didn't start in time once; tried again at`))
    rmSync(slowMarker)
    await endedAs(slow, 'live', 120_000)
    assert.deepEqual(attemptsOf(slow).filter((record) => record.endedAt !== null).map((record) => record.phase), ['rolled_back', 'live'], 'tried twice')
  } finally {
    rmSync(slowMarker, { force: true })
  }
})

test('turned off, it stays where it is', async () => {
  assert.match(await run.cli('update', 'follow', 'off'), /^not following a branch/)
  const ignored = await pushed('not followed', replacing('server/protocols/default.md', '(Followed.)', '(No longer followed.)'))
  await pause(4_000)
  assert.deepEqual(attemptsOf(ignored), [])
})
