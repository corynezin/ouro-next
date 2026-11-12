// The provisioners against a fake EC2 API, a fake Sprites API and a fake SSH: no machine is made and no cloud is called.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { SpriteInfo, SpritesApi } from '@ouro/contract/sprites'
import type { Ec2Api, Ec2Instance, RunInstanceRequest } from './ec2.ts'
import {
  Ec2Provisioner, ec2InstallerSettings, INSTALLERS, jobFailure, MachineStepFailure, SERVER_TAG, SpriteMachineProvisioner, spriteInstallerSettings, spriteNameOf,
} from './machine-provisioners.ts'
import type { MachineOrder, SshRunner } from './machine-provisioners.ts'

const dir = mkdtempSync(join(tmpdir(), 'provisioners-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const repoRoot = join(import.meta.dirname, '../../..')

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], { cwd, encoding: 'utf8' }).trim()
const source = join(dir, 'source')
mkdirSync(source)
git(source, 'init', '--quiet', '-b', 'main')
writeFileSync(join(source, 'package-lock.json'), '{}')
git(source, 'add', '.')
git(source, 'commit', '--quiet', '-m', 'one')
const commit = git(source, 'rev-parse', 'HEAD')
const settings = { sourceRoot: source, defaultModel: 'stand-in-model', baseRepo: null }

const order = (data: Record<string, string> = {}): MachineOrder => ({ id: 'm-0a1b2c3d', label: "Sam's Work", commit, data })

// ---- EC2 ----

class FakeEc2Api implements Ec2Api {
  readonly calls: string[] = []
  readonly instances = new Map<string, Ec2Instance & { tags: Record<string, string> }>()
  /** What describeInstance answers, in turn, for a new instance; the last one stays. */
  states: Ec2Instance['state'][] = ['pending', 'running']
  private described = 0

  async latestUbuntuImage() { return 'ami-1' }
  async ensureSecurityGroup(name: string) { this.calls.push(`group ${name}`); return 'sg-1' }
  async allowIngress(groupId: string, port: number, cidr: string) { this.calls.push(`allow ${groupId} ${port} ${cidr}`) }
  async revokeIngress(groupId: string, port: number, cidr: string) { this.calls.push(`revoke ${groupId} ${port} ${cidr}`) }
  async runInstance(request: RunInstanceRequest) {
    this.calls.push(`run ${request.clientToken}`)
    this.instances.set('i-1', { instanceId: 'i-1', state: 'pending', publicIp: null, tags: request.tags })
    return 'i-1'
  }
  async describeInstance(instanceId: string) {
    const instance = this.instances.get(instanceId)
    if (!instance) return null
    const state = this.states[Math.min(this.described++, this.states.length - 1)]!
    return { instanceId, state, publicIp: state === 'running' ? '54.1.2.3' : null }
  }
  async instancesTagged(key: string, value: string) {
    this.calls.push(`tagged ${key}=${value}`)
    return [...this.instances.values()].filter((instance) => instance.tags[key] === value)
  }
  async terminateInstance(instanceId: string) { this.calls.push(`terminate ${instanceId}`) }
}

type JobEnd = { status: number; log?: string; never?: boolean }

/** SSH to one instance: files written with `cat >`, jobs launched and ending as `jobs` says, and the pairing queries. */
function fakeSsh(jobs: Record<string, JobEnd> = {}) {
  const files = new Map<string, string>()
  const commands: string[] = []
  const ended = new Set<string>()
  const ssh: SshRunner = async (_dir, ip, command, input) => {
    commands.push(command)
    assert.equal(ip, '54.1.2.3')
    const written = /cat > (\S+?)(\.partial)?( &&.*)?$/.exec(command)
    if (written) { files.set(written[1]!, input?.toString('utf8') ?? ''); return '' }
    const launched = /^bash \S+\/launch\.sh (\S+)$/.exec(command)
    if (launched) { ended.add(launched[1]!); return '' }
    const exit = /^cat (\S+)\.exit/.exec(command)
    if (exit) {
      const job = jobs[exit[1]!.split('/').at(-1)!] ?? { status: 0 }
      return ended.has(exit[1]!) && !job.never ? `${job.status}\n` : ''
    }
    const log = /^tail -c 1500 (\S+)\.log$/.exec(command)
    if (log) return jobs[log[1]!.split('/').at(-1)!]?.log ?? ''
    if (command.includes('query.mjs paired')) return JSON.stringify({ paired: true })
    if (command.includes('query.mjs pair ')) return JSON.stringify({ code: 'code-1', expiresAt: 42 })
    if (command === 'true') return ''
    throw new Error(`unexpected command ${command}`)
  }
  return { ssh, files, commands }
}

function ec2With(api: Ec2Api, ssh: SshRunner, options: { keysDir?: string; makerAddress?: string } = {}) {
  return new Ec2Provisioner({
    api, ssh, keysDir: options.keysDir ?? mkdtempSync(join(dir, 'keys-')), makerAddress: async () => options.makerAddress ?? '203.0.113.7',
    settings, instanceType: 't3.medium', diskGb: 30, pollIntervalMs: 1,
    deadlines: { create: 1_000, ssh: 1_000, upload: 1_000, install: 1_000, service: 1_000 },
  })
}

test('an EC2 server: SSH opened only to this server, the instance recorded as soon as it exists, then every step', async () => {
  const api = new FakeEc2Api()
  const { ssh, files, commands } = fakeSsh()
  const provisioner = ec2With(api, ssh)
  const recorded: Record<string, string>[] = []
  const data = await provisioner.create(order(), (made) => recorded.push(made))
  assert.deepEqual(data, { instanceId: 'i-1', ip: '54.1.2.3' })
  assert.deepEqual(recorded, [{ instanceId: 'i-1' }, { instanceId: 'i-1', ip: '54.1.2.3' }])
  assert.deepEqual(api.calls, [
    'group ouro-servers', 'allow sg-1 80 0.0.0.0/0', 'allow sg-1 443 0.0.0.0/0', 'revoke sg-1 22 0.0.0.0/0', 'allow sg-1 22 203.0.113.7/32', 'run ouro-m-0a1b2c3d',
  ])
  assert.equal(api.instances.get('i-1')!.tags[SERVER_TAG], 'm-0a1b2c3d', 'destroy can find it by its tag')

  const made = order(data)
  for (const step of ['upload', 'install', 'setup'] as const) await provisioner[step](made)
  const install = files.get('/home/ubuntu/ouro-made/jobs/install.sh')!
  assert.match(install, new RegExp(`bash /home/ubuntu/ouro/source/scripts/install-run-ubuntu.sh ${commit}$`, 'm'))
  assert.match(install, /^export OURO_NEXT_PUBLIC_URL='https:\/\/54-1-2-3.sslip.io'$/m)
  assert.match(install, /^export OURO_NEXT_MACHINE_NAME='sam-s-work'$/m)
  assert.match(install, /^export OURO_NEXT_DEFAULT_MODEL='stand-in-model'$/m)
  assert.ok(files.has('/home/ubuntu/ouro-made/query.mjs'))
  assert.deepEqual(await provisioner.startPairing(made), { code: 'code-1', expiresAt: 42 })
  assert.equal(await provisioner.hasPairedPhone(made), true)
  assert.ok(commands.some((command) => command.startsWith('node /home/ubuntu/ouro-made/query.mjs pair made-pairing-m-0a1b2c3d-')))
})

test('an instance that stops while being made fails create, and was recorded first', async () => {
  const api = new FakeEc2Api()
  api.states = ['pending', 'terminated']
  const recorded: Record<string, string>[] = []
  await assert.rejects(ec2With(api, fakeSsh().ssh).create(order(), (made) => recorded.push(made)),
    (error: Error) => error instanceof MachineStepFailure && error.message === 'the instance i-1 is terminated')
  assert.deepEqual(recorded, [{ instanceId: 'i-1' }])
})

test('an instance that never runs fails create at its deadline, saying what state it was in', async () => {
  const api = new FakeEc2Api()
  api.states = ['pending']
  await assert.rejects(ec2With(api, fakeSsh().ssh).create(order(), () => {}), /wasn't running with a public IP in time \(it is pending\)/)
})

test('create asked again after a restart starts no second instance', async () => {
  const api = new FakeEc2Api()
  api.instances.set('i-1', { instanceId: 'i-1', state: 'pending', publicIp: null, tags: {} })
  await ec2With(api, fakeSsh().ssh).create(order({ instanceId: 'i-1' }), () => {})
  assert.equal(api.calls.filter((call) => call.startsWith('run ')).length, 0)
})

test('destroy terminates the recorded instance, or finds live ones by their tag when none was recorded', async () => {
  const api = new FakeEc2Api()
  const provisioner = ec2With(api, fakeSsh().ssh)
  await provisioner.destroy(order({ instanceId: 'i-9' }))
  assert.deepEqual(api.calls, ['terminate i-9'])

  api.calls.length = 0
  api.instances.set('i-live', { instanceId: 'i-live', state: 'running', publicIp: null, tags: { [SERVER_TAG]: 'm-0a1b2c3d' } })
  api.instances.set('i-gone', { instanceId: 'i-gone', state: 'terminated', publicIp: null, tags: { [SERVER_TAG]: 'm-0a1b2c3d' } })
  api.instances.set('i-other', { instanceId: 'i-other', state: 'running', publicIp: null, tags: { [SERVER_TAG]: 'm-other' } })
  await provisioner.destroy(order())
  assert.deepEqual(api.calls, ['tagged ouro-server=m-0a1b2c3d', 'terminate i-live'])
})

test("when this server's address changes, SSH is opened to the new one and closed to the one it opened before", async () => {
  const keysDir = mkdtempSync(join(dir, 'keys-'))
  const first = new FakeEc2Api()
  await ec2With(first, fakeSsh().ssh, { keysDir, makerAddress: '203.0.113.7' }).create(order(), () => {})
  const later = new FakeEc2Api()
  await ec2With(later, fakeSsh().ssh, { keysDir, makerAddress: '198.51.100.9' }).hasPairedPhone(order({ instanceId: 'i-1', ip: '54.1.2.3' }))
  assert.deepEqual(later.calls, ['group ouro-servers', 'allow sg-1 22 198.51.100.9/32', 'revoke sg-1 22 203.0.113.7/32'])
  const again = new FakeEc2Api()
  await ec2With(again, fakeSsh().ssh, { keysDir, makerAddress: '198.51.100.9' }).hasPairedPhone(order({ instanceId: 'i-1', ip: '54.1.2.3' }))
  assert.deepEqual(again.calls, ['group ouro-servers'], 'an address already let in is left as it is')
})

test("a job that fails says its last line first; one that doesn't end fails at its deadline", async () => {
  const made = order({ instanceId: 'i-1', ip: '54.1.2.3' })
  const failing = ec2With(new FakeEc2Api(), fakeSsh({ install: { status: 2, log: 'step 1\nE: no space left\n' } }).ssh)
  await assert.rejects(failing.install(made), (error: Error) => error instanceof MachineStepFailure && error.message.startsWith('the install job exited 2: E: no space left\n'))
  const stuck = new Ec2Provisioner({
    api: new FakeEc2Api(), ssh: fakeSsh({ install: { status: 0, never: true } }).ssh, keysDir: mkdtempSync(join(dir, 'keys-')), makerAddress: async () => '203.0.113.7',
    settings, instanceType: 't3.medium', diskGb: 30, pollIntervalMs: 1, deadlines: { create: 1, ssh: 1, upload: 1, install: 120_000 / 4_000, service: 1 },
  })
  await assert.rejects(stuck.install(made), /the install job didn't end within 0 minutes/)
  assert.equal(jobFailure('upload', '1', ''), 'the upload job exited 1: no output\n')
})

// ---- Sprites ----

const PREFIX = 'ouro-made-'

class FakeSpritesApi implements SpritesApi {
  readonly namePrefix = PREFIX
  readonly sprites = new Map<string, SpriteInfo>()
  readonly files = new Map<string, Buffer>()
  readonly calls: string[] = []
  failMakingPublic = false

  async listSpriteNames() { return [...this.sprites.keys()] }
  async getSprite(name: string) { return this.sprites.get(name) ?? null }
  async createSprite(name: string) {
    this.calls.push(`create ${name}`)
    // As the API can: made, but not yet public.
    const sprite: SpriteInfo = { name, url: `https://${name}.sprites.app`, urlAuth: 'sprite' }
    this.sprites.set(name, sprite)
    return sprite
  }
  async makeUrlPublic(name: string) {
    if (this.failMakingPublic) throw new Error('the Sprites API answered 503')
    const sprite = { ...this.sprites.get(name)!, urlAuth: 'public' as const }
    this.sprites.set(name, sprite)
    return sprite
  }
  async deleteSprite(name: string) { this.calls.push(`delete ${name}`); this.sprites.delete(name) }
  async writeFile(name: string, path: string, content: Buffer) { this.files.set(`${name}:${path}`, content) }
  async readFile(name: string, path: string) { return this.files.get(`${name}:${path}`) ?? null }
  /** Every job ends at once, well; a query leaves its answer. */
  async exec(name: string, argv: string[]) {
    const path = argv[4]!
    const job = path.split('/').at(-1)!
    this.calls.push(`job ${job}`)
    if (job === 'pair') this.files.set(`${name}:${path}.out`, Buffer.from(JSON.stringify({ code: 'c', expiresAt: 1 })))
    if (job === 'paired') this.files.set(`${name}:${path}.out`, Buffer.from(JSON.stringify({ paired: false })))
    this.files.set(`${name}:${path}.exit`, Buffer.from('0\n'))
  }
}

const spriteWith = (api: SpritesApi) => new SpriteMachineProvisioner({ api, settings, pollIntervalMs: 1, deadlines: { upload: 1_000, install: 1_000, service: 1_000, query: 1_000 } })
const SPRITE = spriteNameOf(PREFIX, 'm-0a1b2c3d')

test('a Sprite is named from the order, recorded before it is made, and made only once across a restart', async () => {
  const api = new FakeSpritesApi()
  const recorded: Record<string, string>[] = []
  assert.deepEqual(await spriteWith(api).create(order(), (made) => recorded.push(made)), { sprite: SPRITE })
  assert.deepEqual(recorded, [{ sprite: SPRITE }])
  // A restart before what create returned was saved: the same name, so the same Sprite.
  await spriteWith(api).create(order(), () => {})
  assert.deepEqual(api.calls, [`create ${SPRITE}`])
  assert.equal(api.sprites.get(SPRITE)!.urlAuth, 'public')
})

test('a Sprite whose create failed after it was made is still destroyed, found by its name', async () => {
  const api = new FakeSpritesApi()
  api.failMakingPublic = true
  await assert.rejects(spriteWith(api).create(order(), () => {}), /503/)
  await spriteWith(api).destroy(order())
  assert.deepEqual(api.calls, [`create ${SPRITE}`, `delete ${SPRITE}`])
  assert.equal(api.sprites.size, 0)
})

test('a Sprite made before names came from the order is found by its recorded name', async () => {
  const api = new FakeSpritesApi()
  await spriteWith(api).destroy(order({ sprite: 'ouro-made-work-1f2e' }))
  assert.deepEqual(api.calls, ['delete ouro-made-work-1f2e'])
})

test("a Sprite's steps write the installer's settings and run it, and its server is asked through jobs", async () => {
  const api = new FakeSpritesApi()
  const provisioner = spriteWith(api)
  const data = await provisioner.create(order(), () => {})
  const made = order(data)
  for (const step of ['upload', 'install', 'setup', 'service'] as const) await provisioner[step](made)
  const env = api.files.get(`${SPRITE}:/home/sprite/ouro-made/settings.env`)!.toString('utf8')
  assert.match(env, new RegExp(`^export OURO_NEXT_PUBLIC_URL='https://${SPRITE}.sprites.app'$`, 'm'))
  assert.match(env, /^export OURO_NEXT_MACHINE_NAME='sam-s-work'$/m)
  assert.match(env, /^export OURO_NEXT_SERVICE_PREFIX='ouro'$/m)
  assert.match(api.files.get(`${SPRITE}:/home/sprite/ouro-made/jobs/service.sh`)!.toString('utf8'), new RegExp(`install-run-sprite.sh ${commit}$`, 'm'))
  assert.deepEqual(await provisioner.startPairing(made), { code: 'c', expiresAt: 1 })
  assert.equal(await provisioner.hasPairedPhone(made), false)
})

// ---- What the provisioners and the installers agree on ----

/** The settings an installer reads: the `OURO_NEXT_…` names in its header comment. */
const headerSettings = (script: string) => new Set(readFileSync(join(repoRoot, script), 'utf8').split('\nset -euo pipefail')[0]!.match(/OURO_NEXT_[A-Z_]+/g) ?? [])

/**
 * An installer and every file it runs or sources, followed from `"$here/…"` and `"$script_dir/…"` (both the scripts
 * folder): install-run.sh, lib/install-common.sh, lib/guardian-config.mjs and so on.
 */
function installerFiles(script: string, seen = new Set<string>()): Set<string> {
  if (seen.has(script)) return seen
  seen.add(script)
  if (!existsSync(join(repoRoot, script))) return seen
  for (const match of readFileSync(join(repoRoot, script), 'utf8').matchAll(/"\$(?:here|script_dir)\/([^"$]+)"/g)) installerFiles(`scripts/${match[1]!}`, seen)
  return seen
}

test('every installer a provisioner runs, and every file it runs in turn, is in the repository and travels in the bundle', () => {
  // The new machine gets the commit as a git bundle: only tracked files reach it.
  const tracked = new Set(execFileSync('git', ['ls-files', 'scripts'], { cwd: repoRoot, encoding: 'utf8' }).split('\n'))
  for (const installer of Object.values(INSTALLERS)) {
    const files = installerFiles(installer)
    for (const file of ['scripts/install-run.sh', 'scripts/lib/install-common.sh', 'scripts/lib/guardian-config.mjs']) assert.ok(files.has(file), `${installer} doesn't reach ${file}`)
    for (const file of files) {
      assert.ok(existsSync(join(repoRoot, file)), `${file}, run by ${installer}, is missing`)
      assert.ok(tracked.has(file), `${file}, run by ${installer}, isn't tracked, so no bundle carries it`)
    }
  }
})

test('every setting a provisioner gives an installer is one that installer, or install-run.sh under it, reads', () => {
  const core = headerSettings('scripts/install-run.sh')
  const withBase = { ...settings, baseRepo: 'https://git.test/bases' }
  for (const [script, given] of [
    [INSTALLERS.ec2, ec2InstallerSettings(order(), '54.1.2.3', withBase)],
    [INSTALLERS.sprite, spriteInstallerSettings(order(), 'https://x.sprites.app', withBase)],
  ] as const) {
    const read = new Set([...headerSettings(script), ...core])
    for (const name of Object.keys(given)) assert.ok(read.has(name), `${script} doesn't read ${name}`)
  }
})
