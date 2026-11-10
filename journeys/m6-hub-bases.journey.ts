// Bases through the real hub (J-34, M6): the publisher computer publishes its live version to the hub as a publisher
// account, and another computer, taking bases from the same hub, is offered it, takes it and has it live, merged into
// its person's own branch. A withdrawn base is offered no more.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { HubBase, SignupResult } from '@ouro/contract'
import type { BaseStatus } from '@ouro/contract'
import { GuardianRun } from './guardian-harness.ts'
import { freePort, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')
const isolatedPath = (process.env.PATH ?? '').split(':').filter((entry) => !entry.includes('.claude-inbox')).join(':')

const id = randomBytes(4).toString('hex')
const hubDir = join(repoRoot, 'runs', `hb-${id}`)
/** Short, as the local provisioner wants; it holds only the computer sign-up starts, which never gets past installing. */
const computersDir = join('/tmp', `ouro-hb-${id}`)
const hubConfig = join(hubDir, 'hub.json')
let hubUrl = ''
let hub: ChildProcess | null = null
let hubOutput = ''

const publisher = new GuardianRun()
const taker = new GuardianRun()
let accountId = ''
let phone: AppClient

const MASTER_PROTOCOL = 'server/protocols/master.md'
const RULE = { ships: ['server', 'packages', '.gitignore'], internal: ['docs'], dependencies: ['node_modules'], checks: ['test -f server/package.json'] }

const hubMain = (...args: string[]) => execFileAsync(process.execPath, ['--no-warnings', join(repoRoot, 'hub/src/main.ts'), ...args], { env: { PATH: isolatedPath, HOME: hubDir } })

async function startHub(): Promise<void> {
  const port = await freePort()
  hubUrl = `http://127.0.0.1:${port}`
  writeFileSync(hubConfig, JSON.stringify({
    dir: join(hubDir, 'hub'),
    port,
    distribution: { source: publisher.source, reference: 'main' },
    // Signing up starts making the account's first computer; this one stops at installing, as this journey needs none.
    provisioner: { kind: 'local', computersDir, installCommand: 'false' },
  }))
  const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'hub/src/main.ts'), 'serve', hubConfig], {
    env: { PATH: isolatedPath, HOME: hubDir },
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

/** A hub account, as the person signs up with an invite; its token is the publisher computer's to publish with. */
async function signUp(): Promise<string> {
  const invite = (await hubMain('invite', hubConfig)).stdout.trim()
  const response = await fetch(`${hubUrl}/hub/v1/signup`, { method: 'POST', body: JSON.stringify({ invite, name: 'Publisher' }) })
  assert.equal(response.status, 200)
  const account = SignupResult.parse(await response.json())
  accountId = account.accountId
  return account.token
}

async function offeredByHub(): Promise<HubBase | null> {
  const response = await fetch(`${hubUrl}/hub/v1/bases/latest`)
  if (response.status === 204) return null
  return HubBase.parse(await response.json())
}

async function refusal(run: GuardianRun, ...args: string[]): Promise<string> {
  try {
    await run.cli(...args)
  } catch (error) {
    return (error as { stderr: string }).stderr
  }
  assert.fail(`ouro ${args.join(' ')} succeeded`)
}

before(async () => {
  mkdirSync(hubDir, { recursive: true })
  // Both computers start from the same Ouro. The taker installed it as base 0; the publisher's live version adds a line.
  await taker.createSource()
  await taker.git('commit', '-q', '--amend', '-m', 'the starting point', '-m', 'Ouro-Base: 0')
  await taker.git('branch', 'ouro-base')
  await publisher.createSource()
  writeFileSync(join(publisher.source, 'distribution.json'), JSON.stringify(RULE))
  appendFileSync(join(publisher.source, MASTER_PROTOCOL), '\nBase 1 was here.\n')
  await publisher.commitAll('base 1')

  await startHub()
  const tokenFile = join(publisher.dir, 'hub-token')
  writeFileSync(tokenFile, await signUp(), { mode: 0o600 })
  const privateNames = join(publisher.dir, 'private-names')
  writeFileSync(privateNames, `${['zor', 'blax'].join('')}\n`)
  publisher.extraOurodEnv = { OURO_HUB_URL: hubUrl, OURO_HUB_TOKEN_FILE: tokenFile, OURO_PRIVATE_NAMES_FILE: privateNames }
  await publisher.start()
  const first = await publisher.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the publisher's first release didn't go live: ${first.reason}`)
})

after(async () => {
  await publisher.cleanup()
  await taker.cleanup()
  if (hub && hub.exitCode === null) {
    const exited = new Promise((done) => hub!.once('exit', done))
    hub.kill('SIGKILL')
    await exited
  }
  rmSync(hubDir, { recursive: true, force: true })
  rmSync(computersDir, { recursive: true, force: true })
})

test('the publisher publishes its live version to the hub once its account may publish', async () => {
  assert.match(await refusal(publisher, 'base', 'publish', 'the first base'), /the hub doesn't let this machine's account publish bases: .*\(not_base_publisher\)/)
  assert.equal(await offeredByHub(), null)

  await hubMain('grant-publishing', hubConfig, accountId)
  assert.equal(await publisher.cli('base', 'publish', 'the master protocol gains a line'), 'published base 1: the master protocol gains a line\n')
  const offered = await offeredByHub()
  assert.deepEqual(offered, { n: 1, notes: 'the master protocol gains a line', treeHash: offered?.treeHash })
  assert.equal(await publisher.cli('base', 'publish', 'again'), 'base 1 already has these files: the master protocol gains a line\n')
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

test('another computer is offered the base by the hub, takes it, and has it live and in its person\'s branch', async () => {
  taker.extraOurodEnv = { OURO_HUB_URL: hubUrl }
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

test('a withdrawn base is offered by the hub no more, and withdrawing a base it hasn\'t got is refused', async () => {
  assert.equal(await publisher.cli('base', 'withdraw', '1'), 'base 1 is withdrawn: it is offered no more\n')
  assert.equal(await offeredByHub(), null)
  assert.match(await refusal(publisher, 'base', 'withdraw', '9'), /there is no base 9 \(not_found\)/)
})
