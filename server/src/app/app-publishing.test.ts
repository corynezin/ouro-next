import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { NotPublished, publishCommittedApp } from './app-publishing.ts'
import type { RegisterUpdateInput } from './app-updates.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' })

/** A committed app in a repository's `apps/mobile`, as a person's source has it. */
function app(runtimeVersion: unknown = { policy: 'appVersion' }): string {
  const root = mkdtempSync(join(tmpdir(), 'ouro-publishing-'))
  made.push(root)
  const dir = join(root, 'apps/mobile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { version: '1.2.3', runtimeVersion } }))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'the app')
  return dir
}

const EXPORT = `mkdir -p {out}/b && echo bundle > {out}/b/ios.js`

function recorder(): { register: (input: RegisterUpdateInput) => Promise<{ updateNumber: number; runtimeVersion: string }>; registered: (RegisterUpdateInput & { bundle: string })[] } {
  const registered: (RegisterUpdateInput & { bundle: string })[] = []
  return {
    registered,
    register: async (input) => {
      registered.push({ ...input, bundle: readFileSync(join(input.exportDir, 'b/ios.js'), 'utf8') })
      return { updateNumber: registered.length, runtimeVersion: '1.2.3' }
    },
  }
}

test('the committed app is exported where the command is told to and registered with its commit and runtime', async () => {
  const dir = app()
  const { register, registered } = recorder()
  assert.deepEqual(await publishCommittedApp(dir, EXPORT, register, () => {}), { updateNumber: 1, runtimeVersion: '1.2.3' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.bundle, 'bundle\n')
  assert.equal(registered[0]!.runtimeVersion, '1.2.3')
  assert.equal(registered[0]!.commit, git(dir, 'rev-parse', 'HEAD').trim())
  assert.ok(!existsSync(registered[0]!.exportDir), 'the export is removed once registered')
})

test('what stops the phone getting the app is a NotPublished that says why, and nothing is registered', async () => {
  const { register, registered } = recorder()
  const dir = app()
  writeFileSync(join(dir, 'new.txt'), 'uncommitted\n')
  await assert.rejects(publishCommittedApp(dir, EXPORT, register, () => {}), (error) => error instanceof NotPublished && /uncommitted changes/.test(error.message))
  rmSync(join(dir, 'new.txt'))

  await assert.rejects(publishCommittedApp(join(dir, 'nowhere'), EXPORT, register, () => {}), (error) => error instanceof NotPublished && /has no app\.json/.test(error.message))
  await assert.rejects(publishCommittedApp(dir, 'echo nope >&2; exit 3', register, () => {}), (error) => error instanceof NotPublished && /the app didn't build: .*nope/.test(error.message))
  await assert.rejects(publishCommittedApp(app('someday'), EXPORT, async () => { throw new Error('the server said no') }, () => {}), (error) => error instanceof NotPublished && error.message === 'the server said no')
  assert.equal(registered.length, 0)
})
