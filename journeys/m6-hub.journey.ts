// M6, the hub: an invite becomes an account and a computer of the person's own, made step by step by the local
// provisioner from the distribution as base 0, which a phone then pairs with. A hub killed while it is making one
// carries on where it was. Once an account the operator lets publish has published a base, new computers start on it.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { HostedServer, HostedServerList, HubBase, HubError, PublishBaseResult, SignupResult } from '@ouro/contract'
import type { ProvisioningStep, Snapshot } from '@ouro/contract'
import { fastTiming } from './guardian-harness.ts'
import { freePort, waitFor } from './harness.ts'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')
const isolatedPath = (process.env.PATH ?? '').split(':').filter((entry) => !entry.includes('.claude-inbox')).join(':')
const FIRST_RELEASE_MS = 150_000

const id = randomBytes(4).toString('hex')
const dir = join(repoRoot, 'runs', `h-${id}`)
const distribution = join(dir, 'distribution')
/** Short: each computer's sockets are under it. */
const computersDir = join('/tmp', `ouro-h-${id}`)
const configPath = join(dir, 'hub.json')
let port = 0
let hub: ChildProcess | null = null
let hubOutput = ''

const git = (cwd: string, ...args: string[]) => execFileAsync('git', ['-c', 'user.name=journey', '-c', 'user.email=journey@invalid', ...args], { cwd })

/** Ouro as the hub hands it out: this working tree's server, contract and guardian, as one commit. */
async function createDistribution(): Promise<void> {
  for (const part of ['server', 'packages/contract', 'guardian']) cpSync(join(repoRoot, part), join(distribution, part), { recursive: true })
  cpSync(join(repoRoot, 'package-lock.json'), join(distribution, 'package-lock.json'))
  writeFileSync(join(distribution, '.gitignore'), 'node_modules\n')
  await git(distribution, 'init', '-q', '-b', 'main')
  await git(distribution, 'add', '-A')
  await git(distribution, 'commit', '-q', '-m', 'Ouro')
}

async function startHub(): Promise<void> {
  hubOutput = ''
  const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'hub/src/main.ts'), 'serve', configPath], {
    env: { PATH: isolatedPath, HOME: join(dir, 'home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (chunk: Buffer) => { hubOutput += chunk.toString() })
  child.stderr!.on('data', (chunk: Buffer) => { hubOutput += chunk.toString() })
  hub = child
  await waitFor('the hub to listen', () => {
    if (child.exitCode !== null) throw new Error(`the hub exited: ${hubOutput}`)
    return hubOutput.includes('"event":"listening"')
  })
}

async function killHub(): Promise<void> {
  const child = hub!
  const exited = new Promise((done) => child.once('exit', done))
  child.kill('SIGKILL')
  await exited
  hub = null
}

async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/hub/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, body: await response.json() as unknown }
}

async function invite(): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ['--no-warnings', join(repoRoot, 'hub/src/main.ts'), 'invite', configPath], { env: { PATH: isolatedPath, HOME: join(dir, 'home') } })
  return stdout.trim()
}

const stepsStarted = (serverId: string): ProvisioningStep[] =>
  hubOutput.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; serverId?: string; step?: ProvisioningStep })
    .filter((entry) => entry.event === 'step_started' && entry.serverId === serverId).map((entry) => entry.step!)

/** This run's computer processes: every one names the computers' directory. */
async function computerProcesses(): Promise<{ pid: number; command: string }[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
  return stdout.split('\n').filter((line) => line.includes(computersDir)).map((line) => {
    const [pid, ...command] = line.trim().split(/\s+/)
    return { pid: Number(pid), command: command.join(' ') }
  })
}

before(async () => {
  mkdirSync(distribution, { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  await createDistribution()
  port = await freePort()
  writeFileSync(configPath, JSON.stringify({
    dir: join(dir, 'hub'),
    port,
    distribution: { source: distribution, reference: 'main' },
    provisioner: {
      kind: 'local',
      computersDir,
      // A real install takes minutes; the journey's computers share this checkout's dependencies.
      installCommand: `ln -s ${join(repoRoot, 'node_modules')} node_modules`,
      guardian: { ourodEnv: { OURO_DEFAULT_MODEL: 'stand-in', OURO_TICK_MS: '100', OURO_INTEGRATIONS_STAND_IN_DIR: join(dir, 'accounts') }, timing: fastTiming },
      firstReleaseDeadlineMs: FIRST_RELEASE_MS,
    },
  }))
  await startHub()
})

after(async () => {
  if (hub && hub.exitCode === null) await killHub()
  for (const { pid } of await computerProcesses()) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(computersDir, { recursive: true, force: true })
})

let token = ''
let accountId = ''
let serverId = ''

test('an invite opens an account once; a wrong or used invite is refused', async () => {
  const code = await invite()
  assert.equal((await call('POST', '/signup', { body: { invite: 'aaaa-bbbb-cccc', name: 'Ada' } })).status, 403)
  const signedUp = await call('POST', '/signup', { body: { invite: code.toUpperCase(), name: 'Ada' } })
  assert.equal(signedUp.status, 200, JSON.stringify(signedUp.body))
  ;({ token, accountId } = SignupResult.parse(signedUp.body))
  const again = await call('POST', '/signup', { body: { invite: code, name: 'Eve' } })
  assert.equal(again.status, 403)
  assert.equal((again.body as { error: { code: string } }).error.code, 'invite_invalid')
  assert.equal((await call('GET', '/servers')).status, 401)
  const { servers } = HostedServerList.parse((await call('GET', '/servers', { token })).body)
  assert.equal(servers.length, 1)
  assert.equal(servers[0]!.label, "Ada's computer")
  assert.equal(servers[0]!.status.state, 'provisioning')
  serverId = servers[0]!.id
})

test('a hub killed while making the computer carries on from the step it was at, and the computer runs once', async () => {
  await waitFor('the service step', () => stepsStarted(serverId).includes('service'), 60_000)
  const stepsBeforeKill = stepsStarted(serverId)
  assert.deepEqual(stepsBeforeKill, ['create', 'upload', 'install', 'setup', 'service'])
  await killHub()
  await startHub()
  const ready = await waitFor('the computer to be ready', async () => {
    const shown = HostedServer.parse((await call('GET', `/servers/${serverId}`, { token })).body)
    if (shown.status.state === 'failed') throw new Error(`the computer failed: ${shown.status.why}\n${hubOutput}`)
    return shown.status.state === 'ready' ? shown : null
  }, FIRST_RELEASE_MS)
  assert.deepEqual(stepsStarted(serverId), ['service', 'pair'], 'the restarted hub runs no step before the one it was at')
  assert.equal(ready.status.state, 'ready')
  // Made before any base: the distribution's files as base 0, where its bases branch starts.
  const source = join(computersDir, serverId, 'source')
  const { stdout: startedOn } = await git(source, 'log', '-1', '--format=%P|%T|%(trailers:key=Ouro-Base,valueonly)', 'main')
  const { stdout: distributionTree } = await git(distribution, 'rev-parse', 'HEAD^{tree}')
  assert.equal(startedOn.trim(), `|${distributionTree.trim()}|0`)
  assert.equal((await git(source, 'rev-parse', 'ouro-base')).stdout, (await git(source, 'rev-parse', 'main')).stdout)
  const guardians = (await computerProcesses()).filter((entry) => entry.command.includes('/stable/guardian-') && entry.command.includes('src/main.ts'))
  assert.equal(guardians.length, 1, guardians.map((entry) => entry.command).join('\n'))
})

test("a phone pairs with the computer at its address, and the hub stops handing out the computer's code", async () => {
  const shown = HostedServer.parse((await call('GET', `/servers/${serverId}`, { token })).body)
  assert.equal(shown.status.state, 'ready')
  if (shown.status.state !== 'ready') return
  const { address, pairing } = shown.status
  assert.ok(pairing, 'a ready computer nobody has paired with offers a code')
  const paired = await fetch(`${address}/v2/pair`, { method: 'POST', body: JSON.stringify({ code: pairing.code, deviceName: 'journey-phone' }) })
  assert.equal(paired.status, 200, await paired.clone().text())
  const { deviceToken } = await paired.json() as { deviceToken: string }
  const snapshot = await (await fetch(`${address}/v2/snapshot`, { headers: { authorization: `Bearer ${deviceToken}` } })).json() as Snapshot
  assert.equal(snapshot.devices.length, 1)
  assert.equal(snapshot.devices[0]!.personId, snapshot.viewer.personId, 'the phone is the owner\'s')
  const afterPairing = HostedServer.parse((await call('GET', `/servers/${serverId}`, { token })).body)
  assert.deepEqual(afterPairing.status, { state: 'ready', address, pairing: null })
})

/** Waits for a computer to be ready, failing at once if it failed. */
async function readyComputer(id: string): Promise<HostedServer> {
  return await waitFor(`computer ${id} to be ready`, async () => {
    const shown = HostedServer.parse((await call('GET', `/servers/${id}`, { token })).body)
    if (shown.status.state === 'failed') throw new Error(`the computer failed: ${shown.status.why}\n${hubOutput}`)
    return shown.status.state === 'ready' ? shown : null
  }, FIRST_RELEASE_MS)
}

test('an account the operator lets publish publishes a base, and the next computer starts on it', async () => {
  writeFileSync(join(distribution, 'BASE.md'), 'Base 1, from the journey.\n')
  await git(distribution, 'add', '-A')
  await git(distribution, 'commit', '-q', '-m', 'Base 1')
  const { stdout: treeHash } = await git(distribution, 'rev-parse', 'HEAD^{tree}')
  const tar = await execFileAsync('git', ['archive', '--format=tar', 'HEAD'], { cwd: distribution, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  const publishing = { notes: 'Base 1.', treeHash: treeHash.trim(), filesTarBase64: tar.stdout.toString('base64') }

  const refused = await call('POST', '/bases', { body: publishing, token })
  assert.equal(refused.status, 403)
  assert.equal(HubError.parse(refused.body).error.code, 'not_publisher')
  await execFileAsync(process.execPath, ['--no-warnings', join(repoRoot, 'hub/src/main.ts'), 'grant-publishing', configPath, accountId], { env: { PATH: isolatedPath, HOME: join(dir, 'home') } })
  const published = await call('POST', '/bases', { body: publishing, token })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.deepEqual(PublishBaseResult.parse(published.body).base, { n: 1, notes: 'Base 1.', treeHash: treeHash.trim() })
  assert.equal(HubBase.parse((await call('GET', '/bases/latest')).body).n, 1)

  const made = await call('POST', '/servers', { body: { label: 'Work' }, token })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const work = await readyComputer(HostedServer.parse(made.body).id)
  const source = join(computersDir, work.id, 'source')
  const { stdout: startedOn } = await git(source, 'log', '-1', '--format=%P|%T|%(trailers:key=Ouro-Base,valueonly)', 'main')
  assert.equal(startedOn.trim(), `|${treeHash.trim()}|1`, 'a root commit with the base\'s files and number')
  assert.equal((await git(source, 'rev-parse', 'ouro-base')).stdout, (await git(source, 'rev-parse', 'main')).stdout)
  assert.equal((await git(source, 'show', 'main:BASE.md')).stdout, 'Base 1, from the journey.\n')
})
