import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ComputerOrder } from './provisioning.ts'
import { LAUNCHER, SpriteProvisioner, SpriteStepFailure } from './sprite-provisioner.ts'
import { SpriteNameOutOfScope, SpritesApiError, SpritesHttpApi } from '@ouro/contract/sprites'
import type { SpriteInfo, SpritesApi } from '@ouro/contract/sprites'

const dir = mkdtempSync(join(tmpdir(), 'hub-sprites-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], { cwd, encoding: 'utf8' }).trim()

const source = join(dir, 'distribution')
mkdirSync(source)
git(source, 'init', '--quiet', '-b', 'main')
writeFileSync(join(source, 'package-lock.json'), '{}')
git(source, 'add', '.')
git(source, 'commit', '--quiet', '-m', 'one')
const commit = git(source, 'rev-parse', 'HEAD')

const PREFIX = 'ouro-test-h-'

type JobOutcome = { status: number; out?: string; log?: string; pollsBeforeExit?: number }

/** One organisation's Sprites, in memory. A launched job ends as `outcomes` says, after some polls if asked. */
class FakeSpritesApi implements SpritesApi {
  readonly namePrefix = PREFIX
  /** The whole organisation's Sprites, the hub's and others. */
  readonly sprites = new Map<string, SpriteInfo>()
  readonly files = new Map<string, Buffer>()
  readonly calls: string[] = []
  outcomes: Record<string, JobOutcome> = {}
  private readonly pending = new Map<string, { outcome: JobOutcome; polls: number }>()

  async listSpriteNames(): Promise<string[]> {
    this.calls.push('list')
    const names = [...this.sprites.keys()].filter((name) => name.startsWith(PREFIX))
    // Answers late, as the API does: two creations at once would both count before either is made.
    await sleep(5)
    return names
  }
  async getSprite(name: string): Promise<SpriteInfo | null> {
    this.calls.push(`get ${name}`)
    return this.sprites.get(name) ?? null
  }
  async createSprite(name: string): Promise<SpriteInfo> {
    assert.ok(name.startsWith(PREFIX))
    this.calls.push(`create ${name}`)
    const sprite: SpriteInfo = { name, url: `https://${name}-abc.sprites.app`, urlAuth: 'public' }
    this.sprites.set(name, sprite)
    return sprite
  }
  async deleteSprite(name: string): Promise<void> {
    assert.ok(name.startsWith(PREFIX))
    this.calls.push(`delete ${name}`)
    this.sprites.delete(name)
  }
  async makeUrlPublic(name: string): Promise<SpriteInfo> {
    this.calls.push(`public ${name}`)
    const sprite = { ...this.sprites.get(name)!, urlAuth: 'public' as const }
    this.sprites.set(name, sprite)
    return sprite
  }
  async writeFile(name: string, path: string, content: Buffer): Promise<void> {
    this.files.set(`${name}:${path}`, content)
  }
  async readFile(name: string, path: string): Promise<Buffer | null> {
    const job = path.endsWith('.exit') ? this.pending.get(`${name}:${path.slice(0, -'.exit'.length)}`) : undefined
    if (job && job.polls++ >= (job.outcome.pollsBeforeExit ?? 0)) this.finish(name, path.slice(0, -'.exit'.length), job.outcome)
    return this.files.get(`${name}:${path}`) ?? null
  }
  async exec(name: string, argv: string[]): Promise<void> {
    assert.deepEqual(argv.slice(0, 4), ['bash', '-c', LAUNCHER, 'launch'])
    assert.deepEqual(argv.slice(5), ['/.sprite/api.sock', '60'], "the Sprite's own Tasks API holds it awake")
    const jobPath = argv[4]!
    const job = jobPath.split('/').at(-1)!
    this.calls.push(`job ${job}`)
    assert.ok(this.files.has(`${name}:${jobPath}.sh`), 'the job script is written before it is launched')
    this.files.delete(`${name}:${jobPath}.exit`)
    this.pending.set(`${name}:${jobPath}`, { outcome: this.outcomes[job] ?? { status: 0 }, polls: 0 })
  }
  private finish(name: string, jobPath: string, outcome: JobOutcome): void {
    this.pending.delete(`${name}:${jobPath}`)
    if (outcome.out !== undefined) this.files.set(`${name}:${jobPath}.out`, Buffer.from(outcome.out))
    this.files.set(`${name}:${jobPath}.log`, Buffer.from(outcome.log ?? ''))
    this.files.set(`${name}:${jobPath}.exit`, Buffer.from(`${outcome.status}\n`))
  }
  file(name: string, path: string): string {
    return this.files.get(`${name}:${path}`)!.toString('utf8')
  }
}

const deadlines = { upload: 1_000, install: 1_000, service: 1_000, query: 1_000 }
const newProvisioner = (api: SpritesApi, overrides: { defaultModel?: string | null; hubUrl?: string | null; baseRepo?: string | null; deadlines?: typeof deadlines; maxSprites?: number } = {}) =>
  new SpriteProvisioner({ api, maxSprites: overrides.maxSprites ?? 3, distributionSource: source, defaultModel: overrides.defaultModel ?? null, hubUrl: overrides.hubUrl ?? null, baseRepo: overrides.baseRepo ?? null, pollIntervalMs: 1, deadlines: overrides.deadlines ?? deadlines })
const order: ComputerOrder = { serverId: 'srv-1234abcd', label: "Ada's computer", distributionCommit: commit }
const NAME = `${PREFIX}srv-1234abcd`

test('every step, start to finish, on a Sprite named from the server', async () => {
  const api = new FakeSpritesApi()
  api.outcomes.pair = { status: 0, out: JSON.stringify({ code: 'abcd-efgh', expiresAt: 42 }) }
  api.outcomes.paired = { status: 0, out: JSON.stringify({ paired: true }) }
  const provisioner = newProvisioner(api, { defaultModel: 'stand-in', hubUrl: 'https://hub.test' })
  for (const step of ['create', 'upload', 'install', 'setup', 'service'] as const) await provisioner[step](order)
  assert.equal(await provisioner.address(order), `https://${NAME}-abc.sprites.app`)
  assert.deepEqual(await provisioner.startPairing(order), { code: 'abcd-efgh', expiresAt: 42 })
  assert.equal(await provisioner.hasPairedPhone(order), true)
  assert.deepEqual(api.calls.filter((call) => !call.startsWith('get ') && call !== 'list'), [`create ${NAME}`, 'job upload', 'job install', 'job service', 'job pair', 'job paired'])

  // What reaches the Sprite: the commit as `main` in a bundle, the installer's settings, and the jobs.
  const bundlePath = join(dir, 'received.bundle')
  writeFileSync(bundlePath, api.files.get(`${NAME}:/home/sprite/ouro-hub/source.bundle`)!)
  const clone = join(dir, 'clone')
  git(dir, 'clone', '--quiet', '--branch', 'main', bundlePath, clone)
  assert.equal(git(clone, 'rev-parse', 'HEAD'), commit)
  const settings = api.file(NAME, '/home/sprite/ouro-hub/settings.env')
  assert.match(settings, new RegExp(`^export OURO_NEXT_PUBLIC_URL='https://${NAME}-abc.sprites.app'$`, 'm'))
  assert.match(settings, /^export OURO_NEXT_REPO='\/home\/sprite\/ouro-hub\/source.bundle'$/m)
  assert.match(settings, /^export OURO_NEXT_DEFAULT_MODEL='stand-in'$/m)
  assert.match(settings, /^export OURO_NEXT_HUB_URL='https:\/\/hub.test'$/m, 'the computer asks this hub for bases')
  assert.match(api.file(NAME, '/home/sprite/ouro-hub/jobs/service.sh'), new RegExp(`install-run-sprite.sh ${commit}`))
  assert.match(api.file(NAME, '/home/sprite/ouro-hub/jobs/upload.sh'), new RegExp(`checkout --quiet -B main ${commit}`))
  assert.match(api.file(NAME, '/home/sprite/ouro-hub/jobs/upload.sh'), new RegExp(`\\|\\| git -C /home/sprite/ouro/source branch ouro-base ${commit}$`, 'm'))
})

test('a hub with a base repository sends its computers there for bases instead of to itself', async () => {
  const api = new FakeSpritesApi()
  const provisioner = newProvisioner(api, { hubUrl: 'https://hub.test', baseRepo: 'https://git.test/bases' })
  for (const step of ['create', 'upload', 'install', 'setup'] as const) await provisioner[step](order)
  const settings = api.file(NAME, '/home/sprite/ouro-hub/settings.env')
  assert.match(settings, /^export OURO_NEXT_BASE_REPO='https:\/\/git.test\/bases'$/m)
  assert.doesNotMatch(settings, /OURO_NEXT_HUB_URL/)
})

test('destroy deletes the server\'s Sprite, and is fine when it is already gone', async () => {
  const api = new FakeSpritesApi()
  const provisioner = newProvisioner(api)
  await provisioner.create(order)
  api.sprites.set('someone-elses-sprite', { name: 'someone-elses-sprite', url: 'https://x', urlAuth: 'public' })
  await provisioner.destroy(order)
  await provisioner.destroy(order)
  assert.deepEqual([...api.sprites.keys()], ['someone-elses-sprite'])
  assert.deepEqual(api.calls.filter((call) => call.startsWith('delete')), [`delete ${NAME}`, `delete ${NAME}`])
})

test('create is safe to run again: an existing Sprite is kept, and its URL made public if it was not', async () => {
  const api = new FakeSpritesApi()
  api.sprites.set(NAME, { name: NAME, url: 'https://kept.sprites.app', urlAuth: 'sprite' })
  const provisioner = newProvisioner(api)
  await provisioner.create(order)
  await provisioner.create(order)
  assert.deepEqual(api.calls, [`get ${NAME}`, `public ${NAME}`, `get ${NAME}`])
  assert.equal(await provisioner.address(order), 'https://kept.sprites.app')
})

test("a new Sprite is made only while the hub's Sprites are under the limit; other Sprites don't count", async () => {
  const api = new FakeSpritesApi()
  for (const name of ['ouro-next-run', 'ouro-test-hub-1', `${PREFIX}srv-aaaaaaaa`]) api.sprites.set(name, { name, url: `https://${name}.sprites.app`, urlAuth: 'public' })
  const provisioner = newProvisioner(api, { maxSprites: 2 })
  const other: ComputerOrder = { ...order, serverId: 'srv-bbbbbbbb' }
  // Two at once: the second counts the first.
  const [made, refused] = await Promise.allSettled([provisioner.create(order), provisioner.create(other)])
  assert.equal(made.status, 'fulfilled')
  assert.equal(refused.status, 'rejected')
  assert.ok(refused.status === 'rejected' && refused.reason instanceof SpriteStepFailure && refused.reason.message === 'this hub may run 2 computers, and all 2 are taken')
  assert.deepEqual(api.calls.filter((call) => call.startsWith('create ')), [`create ${NAME}`])
  // A Sprite the hub has already made is carried on with, at the limit or not.
  await provisioner.create(order)
  assert.deepEqual([...api.sprites.keys()].sort(), ['ouro-next-run', 'ouro-test-h-srv-1234abcd', 'ouro-test-h-srv-aaaaaaaa', 'ouro-test-hub-1'])
  assert.throws(() => newProvisioner(api, { maxSprites: 0 }), /maxSprites must be a whole number of at least 1/)
})

test('a job that exits non-zero fails its step with the end of its log; one that runs too long fails too', async () => {
  const api = new FakeSpritesApi()
  const provisioner = newProvisioner(api, { deadlines: { ...deadlines, install: 20 } })
  await provisioner.create(order)
  api.outcomes.upload = { status: 128, log: 'fatal: not a git repository' }
  await assert.rejects(provisioner.upload(order), (error: Error) => error instanceof SpriteStepFailure && error.message === 'the upload job exited 128: fatal: not a git repository')
  api.outcomes.install = { status: 0, pollsBeforeExit: 1_000_000 }
  await assert.rejects(provisioner.install(order), /the install job didn't end within 20 ms/)
  api.outcomes.service = { status: 0, pollsBeforeExit: 3 }
  await provisioner.service(order)
})

test('a Sprite that has gone away is a failure, not a guess', async () => {
  const provisioner = newProvisioner(new FakeSpritesApi())
  await assert.rejects(provisioner.address(order), new RegExp(`the Sprite ${NAME} is gone`))
  await assert.rejects(provisioner.setup(order), /is gone/)
})

test('the launcher runs a job detached under a renewed hold, records its exit status, and a second launch waits for the first', async (t) => {
  const jobs = join(dir, 'jobs')
  mkdirSync(jobs)
  const job = join(jobs, 'slow')
  writeFileSync(`${job}.sh`, `echo started >> ${jobs}/runs; sleep 0.3; echo ended >> ${jobs}/runs; exit 3\n`)
  // A stand-in for the Sprite's Tasks API: never this machine's own.
  const tasks: string[] = []
  const tasksApi = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      tasks.push(`${request.method} ${request.url} ${body}`.trim())
      response.writeHead(200).end('{}')
    })
  })
  const tasksSocket = join(dir, 'tasks.sock')
  await new Promise<void>((listening) => tasksApi.listen(tasksSocket, listening))
  t.after(() => tasksApi.close())
  // Asynchronous, as the launcher's own hold is answered by this process.
  const launch = () => new Promise<{ status: number | null }>((done) => {
    spawn('bash', ['-c', LAUNCHER, 'launch', job, tasksSocket, '0.1'], { stdio: 'ignore', timeout: 5_000 }).on('exit', (status) => done({ status }))
  })
  const started = Date.now()
  assert.equal((await launch()).status, 0)
  assert.ok(Date.now() - started < 250, 'the launcher returns before the job ends')
  const launchHold = 'PUT /v1/tasks/ouro-hub-slow-launch {"expire":"5m"}'
  assert.deepEqual(tasks, [launchHold], 'the launcher holds the Sprite before it returns, so the Sprite can\'t pause first')
  await sleep(50)
  assert.equal((await launch()).status, 0)
  // The jobs are detached: on a busy machine neither may have started yet, so there may be no file to read.
  const runs = () => existsSync(`${jobs}/runs`) ? readFileSync(`${jobs}/runs`, 'utf8').split('\n').filter(Boolean) : []
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && runs().length < 4) await sleep(25)
  assert.deepEqual(runs(), ['started', 'ended', 'started', 'ended'])
  const hold = 'PUT /v1/tasks/ouro-hub-slow {"expire":"5m"}'
  const letGo = 'DELETE /v1/tasks/ouro-hub-slow'
  // The second run lets go, then writes its exit status.
  while (Date.now() < deadline && !(tasks.filter((call) => call === letGo).length === 2 && existsSync(`${job}.exit`))) await sleep(25)
  assert.equal(readFileSync(`${job}.exit`, 'utf8').trim(), '3')
  assert.deepEqual(tasks.filter((call) => call !== hold && call !== letGo && call !== launchHold), [])
  assert.equal(tasks.filter((call) => call === letGo).length, 2, 'each run lets go at its end')
  assert.ok(tasks.filter((call) => call === hold).length >= 4, `each run holds and renews: ${tasks.join(', ')}`)
  assert.equal(tasks.at(-1), letGo)
})

test('the HTTP client speaks the documented API: bearer token, paths, bodies, and 404 as absence', async (t) => {
  const seen: { method: string; url: string; auth: string | undefined; type: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ method: request.method!, url: request.url!, auth: request.headers.authorization, type: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') })
      const sprite = { id: 'x', name: 'ouro-h-a', organization: 'o', url: 'https://ouro-h-a-1.sprites.app', status: 'cold', url_settings: { auth: 'public' }, created_at: '', updated_at: '' }
      const json = (body: object) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (request.url === '/v1/sprites/ouro-h-missing' || request.url!.includes('missing.txt')) return response.writeHead(404).end('{"error":"not found"}')
      if (request.url === '/v1/sprites/ouro-h-broken') return response.writeHead(500).end('boom')
      // The list as a server that ignored the prefix might give it, over two pages.
      if (request.url === '/v1/sprites?prefix=ouro-h-&max_results=50') return json({ sprites: [{ name: 'ouro-h-a' }, { name: 'ouro-hub-x' }], has_more: true, next_continuation_token: 'page 2' })
      if (request.url === '/v1/sprites?prefix=ouro-h-&max_results=50&continuation_token=page+2') return json({ sprites: [{ name: 'ouro-h-b' }], has_more: false, next_continuation_token: null })
      if (request.url!.includes('/fs/read')) return response.writeHead(200).end('file text')
      if (request.url!.includes('/exec')) return response.writeHead(200).end(Buffer.from([1, 0x68, 3, 0]))
      response.writeHead(request.method === 'POST' && request.url === '/v1/sprites' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(sprite))
    })
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  t.after(() => { server.closeAllConnections(); server.close() })
  const api = new SpritesHttpApi('token-1', 'ouro-h-', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)

  assert.equal(await api.getSprite('ouro-h-missing'), null)
  assert.deepEqual(await api.createSprite('ouro-h-a'), { name: 'ouro-h-a', url: 'https://ouro-h-a-1.sprites.app', urlAuth: 'public' })
  await api.makeUrlPublic('ouro-h-a')
  await api.writeFile('ouro-h-a', '/home/sprite/x y', Buffer.from('content'), '0600')
  assert.equal((await api.readFile('ouro-h-a', '/home/sprite/a.txt'))!.toString(), 'file text')
  assert.equal(await api.readFile('ouro-h-a', '/home/sprite/missing.txt'), null)
  await api.exec('ouro-h-a', ['bash', '-c', 'echo "$1"', 'launch', 'a&b'])
  assert.deepEqual(await api.listSpriteNames(), ['ouro-h-a', 'ouro-h-b'])
  await assert.rejects(api.getSprite('ouro-h-broken'), (error: Error) => error instanceof SpritesApiError && error.status === 500 && error.message.includes('boom'))

  assert.ok(seen.every((request) => request.auth === 'Bearer token-1'))
  assert.deepEqual(seen.map((request) => `${request.method} ${request.url}`), [
    'GET /v1/sprites/ouro-h-missing',
    'POST /v1/sprites',
    'PUT /v1/sprites/ouro-h-a',
    'PUT /v1/sprites/ouro-h-a/fs/write?path=%2Fhome%2Fsprite%2Fx+y&workingDir=%2F&mode=0600&mkdir=true',
    'GET /v1/sprites/ouro-h-a/fs/read?path=%2Fhome%2Fsprite%2Fa.txt&workingDir=%2F',
    'GET /v1/sprites/ouro-h-a/fs/read?path=%2Fhome%2Fsprite%2Fmissing.txt&workingDir=%2F',
    'POST /v1/sprites/ouro-h-a/exec?cmd=bash&cmd=-c&cmd=echo+%22%241%22&cmd=launch&cmd=a%26b&path=bash',
    'GET /v1/sprites?prefix=ouro-h-&max_results=50',
    'GET /v1/sprites?prefix=ouro-h-&max_results=50&continuation_token=page+2',
    'GET /v1/sprites/ouro-h-broken',
  ])
  assert.deepEqual(JSON.parse(seen[1]!.body), { name: 'ouro-h-a', url_settings: { auth: 'public' } })
  assert.deepEqual(JSON.parse(seen[2]!.body), { url_settings: { auth: 'public' } })
  assert.equal(seen[3]!.type, 'application/octet-stream')
  assert.equal(seen[3]!.body, 'content')

  // Sprites outside the prefix are refused before any request is made.
  const before = seen.length
  const outOfScope = (error: Error) => error instanceof SpriteNameOutOfScope
  await assert.rejects(api.getSprite('ouro-next-run'), outOfScope)
  await assert.rejects(api.getSprite('ouro-hub-x'), outOfScope)
  await assert.rejects(api.getSprite('ouro-h-'), outOfScope)
  await assert.rejects(api.createSprite('ouro-next-run'), outOfScope)
  await assert.rejects(api.makeUrlPublic('ouro-next-run'), outOfScope)
  await assert.rejects(api.writeFile('ouro-next-run', '/x', Buffer.from(''), '0644'), outOfScope)
  await assert.rejects(api.readFile('ouro-next-run', '/x'), outOfScope)
  await assert.rejects(api.exec('ouro-next-run', ['true']), outOfScope)
  assert.equal(seen.length, before)
  for (const prefix of ['', 'ouro', 'ouro-next-h', 'Ouro-h-', 'ouro--h-', 'ouro-h/-']) assert.throws(() => new SpritesHttpApi('token-1', prefix), outOfScope, prefix)
})

test('what ships in a base includes the installers and what they run and source, so a computer made from a base can set up', () => {
  const rule = JSON.parse(readFileSync(new URL('../../distribution.json', import.meta.url), 'utf8')) as { ships: string[] }
  const installers = ['install-run.sh', 'install-run-sprite.sh', 'install-run-ubuntu.sh', 'install-run-mac.sh', 'lib/install-common.sh', 'lib/guardian-config.mjs']
  for (const file of installers) {
    assert.ok(rule.ships.some((entry) => entry === 'scripts' || entry === `scripts/${file}`), `${file}: ${JSON.stringify(rule.ships)}`)
  }
})
