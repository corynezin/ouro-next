// M2, phone side of the server: an agent publishes the committed app with one command, and the update route serves a
// manifest a phone can use. The export step is a stand-in for `expo export`, configured the same way a person's is.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { UPDATE_MANIFEST_PATH, UpdateManifest } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const FAKE_EXPORT = `mkdir -p {out}/b && cp app.js {out}/b/ios.js && printf '{"version":0,"fileMetadata":{"ios":{"bundle":"b/ios.js","assets":[]}}}' > {out}/metadata.json`
let run: JourneyRun
let phone: AppClient
let appDir: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=journey', '-c', 'user.email=journey@invalid', ...args], { cwd: appDir, encoding: 'utf8' })
}

function writeApp(code: string): void {
  writeFileSync(join(appDir, 'app.js'), code)
}

before(async () => {
  run = new JourneyRun({ env: { OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_APP_SOURCE: '', OURO_APP_EXPORT_COMMAND: FAKE_EXPORT, OURO_CLI_RETRY_MS: '60000' }) } })
  appDir = join(run.dir, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'app.json'), JSON.stringify({ expo: { name: 'Ouro Next', version: '0.1.0', runtimeVersion: { policy: 'appVersion' } } }))
  writeApp('globalThis.bubbles = "blue"\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'the app')
  await run.startServer()
  phone = await run.pairDevice()
  // Its own folder, apart from the app, so its scratch files don't count as uncommitted app changes.
  await phone.command('create_agent', { task: 'ready', name: 'publisher', model: null, folder: join(run.dir, 'publisher') })
  await waitFor('the agent', async () => (await phone.agent('publisher')).state.state === 'idle')
})
after(() => run.cleanup())

/** What expo-updates sends: no credential at all. */
async function manifestFor(runtimeVersion: string): Promise<Response> {
  return await fetch(`${run.url}${UPDATE_MANIFEST_PATH}`, { headers: { 'expo-platform': 'ios', 'expo-runtime-version': runtimeVersion, 'expo-protocol-version': '1', accept: 'multipart/mixed,application/expo+json,application/json' } })
}

/**
 * A phone's update cache as expo-updates keeps it: assets by key, across updates. An asset whose key it already has is
 * not downloaded again, so a key that names different bytes in another update would run stale code.
 */
class PhoneUpdateCache {
  private readonly byKey = new Map<string, Buffer>()
  downloads: string[] = []

  async apply(manifest: UpdateManifest): Promise<string> {
    for (const asset of [manifest.launchAsset, ...manifest.assets]) {
      if (this.byKey.has(asset.key)) continue
      const bytes = Buffer.from(await (await fetch(asset.url)).arrayBuffer())
      assert.equal(createHash('sha256').update(bytes).digest('base64url'), asset.hash, `${asset.url} matches its hash`)
      this.byKey.set(asset.key, bytes)
      this.downloads.push(asset.url)
    }
    return this.byKey.get(manifest.launchAsset.key)!.toString()
  }
}
const phoneCache = new PhoneUpdateCache()

async function publishAsAgent(label: string): Promise<string> {
  await phone.command('send_message', { to: 'publisher', text: standInScript({ do: 'run', command: `ouro publish --app ${appDir} > out-${label}.txt 2>&1; ouro reply "${label}: $(tr "\\n" " " < out-${label}.txt)"` }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const reply = await waitFor(`the ${label} report`, async () => (await phone.conversation('publisher')).find((message) => message.text.startsWith(`${label}:`)), 60_000)
  return reply.text
}

test('before anything is published, the route says there is no update', async () => {
  const answer = await manifestFor('0.1.0')
  assert.equal(answer.status, 204)
  assert.equal(answer.headers.get('expo-protocol-version'), '1')
})

test('an agent publishes the committed app, and a phone gets a valid manifest and the exact bundle', async () => {
  const report = await publishAsAgent('first')
  assert.match(report, /published update 1 for app version 0\.1\.0\. Tell the person to tap the banner/)

  const answer = await manifestFor('0.1.0')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('expo-protocol-version'), '1')
  const manifest = UpdateManifest.parse(await answer.json())
  assert.equal(manifest.extra.ouro.updateNumber, 1)
  assert.equal(manifest.extra.ouro.commit, git('rev-parse', 'HEAD').trim())
  assert.match(manifest.createdAt, /\.\d{3}Z$/)
  assert.ok(manifest.launchAsset.url.startsWith(run.url), 'asset URLs use the address the phone used')

  const bundle = await fetch(manifest.launchAsset.url)
  const bytes = Buffer.from(await bundle.arrayBuffer())
  assert.equal(bytes.toString(), readFileSync(join(appDir, 'app.js'), 'utf8'))
  assert.equal(createHash('sha256').update(bytes).digest('base64url'), manifest.launchAsset.hash)
  assert.equal(await phoneCache.apply(manifest), 'globalThis.bubbles = "blue"\n')

  const identity = await (await fetch(`${run.url}/v2/identity`)).json() as { latestUpdate: unknown }
  assert.deepEqual(identity.latestUpdate, { updateNumber: 1, runtimeVersion: '0.1.0' })
})

test('a later commit becomes the next number; an update for another runtime stays separate', async () => {
  writeApp('globalThis.bubbles = "black"\n')
  git('commit', '-q', '-am', 'black bubbles')
  assert.match(await publishAsAgent('second'), /published update 2/)
  const manifest = UpdateManifest.parse(await (await manifestFor('0.1.0')).json())
  assert.equal(manifest.extra.ouro.updateNumber, 2)
  assert.equal((await manifestFor('0.2.0')).status, 204, 'only phones that can run it get it')

  // The phone that ran update 1 fetches update 2's bundle and runs it, rather than reusing update 1's from its cache.
  const downloadsBefore = phoneCache.downloads.length
  assert.equal(await phoneCache.apply(manifest), 'globalThis.bubbles = "black"\n')
  assert.deepEqual(phoneCache.downloads.slice(downloadsBefore), [manifest.launchAsset.url])
})

test('uncommitted changes and a failing build are not shipped, and say so', async () => {
  writeApp('globalThis.bubbles = "red"\n')
  assert.match(await publishAsAgent('dirty'), /not shipped: the app has uncommitted changes|uncommitted/)
  git('checkout', '--', 'app.js')

  writeFileSync(join(appDir, 'app.json'), JSON.stringify({ expo: { name: 'Ouro Next', version: '0.1.0', runtimeVersion: { policy: 'appVersion' } } }))
  execFileSync('rm', [join(appDir, 'app.js')])
  git('commit', '-q', '-am', 'lose the app source')
  assert.match(await publishAsAgent('broken'), /not shipped: the app didn't build|saved in the source but hasn't reached the phone/)
  assert.equal(UpdateManifest.parse(await (await manifestFor('0.1.0')).json()).extra.ouro.updateNumber, 2, 'nothing new was published')
})

test('asset names from the URL cannot leave the update folder', async () => {
  const outside = await fetch(`${run.url}/updates/assets/1/..%2F..%2Fouro.db`)
  assert.equal(outside.status, 404)
})
