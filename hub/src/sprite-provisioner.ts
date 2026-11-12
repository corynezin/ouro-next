// Computers as Sprites, made through the Sprites API. Each server gets its own Sprite, named from the server's id, set
// up by the same `scripts/install-run-sprite.sh` that sets up a run Sprite by hand. The commit goes to the Sprite as a
// git bundle, which the installer clones as the person's copy of the source.
//
// Work on the Sprite runs as jobs (packages/contract/src/sprites/jobs.ts), and every job is safe to run twice.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BASE_BRANCH } from './distribution.ts'
import type { ComputerOrder, Provisioner } from './provisioning.ts'
import type { PairingRecord } from './store.ts'
import { runSpriteJob, spriteLauncher } from '@ouro/contract/sprites'
import type { SpriteInfo, SpritesApi } from '@ouro/contract/sprites'

const execFileAsync = promisify(execFile)

export interface SpriteProvisionerConfig {
  api: SpritesApi
  /** The most Sprites under the API's name prefix there may be; past it, a computer's create step fails. */
  maxSprites: number
  /** A git repository holding the commits servers are made from. */
  distributionSource: string
  /** Sprite names are its name prefix followed by the server's id. */
  /** The model new agents use on the computer; null for the server's own default. */
  defaultModel: string | null
  /** The hub's own public URL, which its computers ask for bases; null for computers that take none. */
  hubUrl: string | null
  /** A public git repository of bases, which its computers take them from instead of the hub; null for the hub's. */
  baseRepo: string | null
  pollIntervalMs: number
  /** How long each kind of job may take before its step fails. */
  deadlines: { upload: number; install: number; service: number; query: number }
}

/** Where things are on every Sprite. */
const SPRITE_HOME = '/home/sprite'
const OURO_ROOT = `${SPRITE_HOME}/ouro`
const HUB_DIR = `${SPRITE_HOME}/ouro-hub`
const BUNDLE = `${HUB_DIR}/source.bundle`
const SETTINGS = `${HUB_DIR}/settings.env`
const QUERY_PROGRAM = `${HUB_DIR}/query.mjs`
const SOURCE = `${OURO_ROOT}/source`
/** The filesystem API's limit on one write. */
const MAX_WRITE_BYTES = 16 * 1024 * 1024

/** The shared launcher (packages/contract/src/sprites/jobs.ts), with the hub's tasks named `ouro-hub-<job>`. */
export const LAUNCHER = spriteLauncher('ouro-hub-')

const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Asks the computer's server over its local socket, as its owner, and prints the answer as JSON: `pair` starts a pairing
 * for the owner's phone; `paired` says whether the owner has a paired phone.
 */
const QUERY_PROGRAM_TEXT = `import { request } from 'node:http'
const socketPath = ${JSON.stringify(`${OURO_ROOT}/home/data/local.sock`)}
const ask = (method, path, body) => new Promise((resolve, reject) => {
  const outgoing = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
    let text = ''
    response.on('data', (chunk) => { text += chunk })
    response.on('end', () => response.statusCode < 300 ? resolve(JSON.parse(text)) : reject(new Error(method + ' ' + path + ' answered ' + response.statusCode + ': ' + text.slice(0, 500))))
  })
  outgoing.on('error', reject)
  outgoing.end(body ? JSON.stringify(body) : undefined)
})
const [query, key] = process.argv.slice(2)
if (query === 'pair') {
  const started = await ask('POST', '/v2/commands/start_pairing', { idempotencyKey: key, input: { inviteePersonName: null } })
  process.stdout.write(JSON.stringify({ code: started.code, expiresAt: started.expiresAt }))
} else if (query === 'paired') {
  const snapshot = await ask('GET', '/v2/snapshot')
  process.stdout.write(JSON.stringify({ paired: snapshot.devices.some((device) => device.personId === snapshot.viewer.personId) }))
} else {
  throw new Error('no query ' + query)
}
`

export class SpriteStepFailure extends Error {}

/** Steps that run on the Sprite, and the two questions put to its server. */
type JobName = 'upload' | 'install' | 'service' | 'pair' | 'paired'

export class SpriteProvisioner implements Provisioner {
  private readonly config: SpriteProvisionerConfig
  /** The last Sprite creation under way: each counts the Sprites only once the one before has been made. */
  private creating: Promise<unknown> = Promise.resolve()

  constructor(config: SpriteProvisionerConfig) {
    if (!Number.isInteger(config.maxSprites) || config.maxSprites < 1) throw new Error(`maxSprites must be a whole number of at least 1, not ${config.maxSprites}`)
    this.config = config
  }

  spriteNameOf(serverId: string): string {
    return `${this.config.api.namePrefix}${serverId}`
  }

  async create(order: ComputerOrder): Promise<void> {
    const { api } = this.config
    const name = this.spriteNameOf(order.serverId)
    const sprite = await api.getSprite(name) ?? await this.createWithinLimit(name)
    if (sprite.urlAuth !== 'public') await api.makeUrlPublic(name)
  }

  private createWithinLimit(name: string): Promise<SpriteInfo> {
    const creation = this.creating.then(async () => {
      const { api, maxSprites } = this.config
      const names = await api.listSpriteNames()
      if (names.length >= maxSprites) throw new SpriteStepFailure(`this hub may run ${maxSprites} computers, and all ${maxSprites} are taken`)
      return await api.createSprite(name)
    })
    this.creating = creation.catch(() => undefined)
    return creation
  }

  async upload(order: ComputerOrder): Promise<void> {
    const name = this.spriteNameOf(order.serverId)
    await this.config.api.writeFile(name, BUNDLE, await this.bundleOf(order.distributionCommit), '0644')
    await this.runJob(name, 'upload', `set -euo pipefail
if [ ! -d ${SOURCE}/.git ]; then git clone --quiet ${BUNDLE} ${SOURCE}; fi
git -C ${SOURCE} fetch --quiet origin
git -C ${SOURCE} rev-parse --verify --quiet ${order.distributionCommit}^{commit} > /dev/null
if [ "$(git -C ${SOURCE} rev-parse HEAD)" != ${order.distributionCommit} ]; then git -C ${SOURCE} checkout --quiet -B main ${order.distributionCommit}; fi
git -C ${SOURCE} show-ref --verify --quiet refs/heads/${BASE_BRANCH} || git -C ${SOURCE} branch ${BASE_BRANCH} ${order.distributionCommit}
`, this.config.deadlines.upload)
  }

  /** As the installer does it, and recorded where it looks, so the installer then leaves the dependencies alone. */
  async install(order: ComputerOrder): Promise<void> {
    await this.runJob(this.spriteNameOf(order.serverId), 'install', `set -euo pipefail
mkdir -p ${OURO_ROOT}/install
lock_hash=$(sha256sum ${SOURCE}/package-lock.json | cut -d' ' -f1)
if [ ! -d ${SOURCE}/node_modules ] || [ "$(cat ${OURO_ROOT}/install/installed-lock 2>/dev/null)" != "$lock_hash" ]; then
  (cd ${SOURCE} && npm ci --no-audit --no-fund --loglevel=error)
  echo "$lock_hash" > ${OURO_ROOT}/install/installed-lock
fi
`, this.config.deadlines.install)
  }

  /** The installer's settings, and the program the hub asks the computer's server through. */
  async setup(order: ComputerOrder): Promise<void> {
    const { api } = this.config
    const name = this.spriteNameOf(order.serverId)
    const sprite = await api.getSprite(name)
    if (!sprite) throw new SpriteStepFailure(`the Sprite ${name} is gone`)
    const settings: Record<string, string> = {
      OURO_NEXT_ROOT: OURO_ROOT,
      OURO_NEXT_PUBLIC_URL: sprite.url,
      OURO_NEXT_REPO: BUNDLE,
      OURO_NEXT_SERVICE_PREFIX: 'ouro',
    }
    if (this.config.defaultModel !== null) settings.OURO_NEXT_DEFAULT_MODEL = this.config.defaultModel
    if (this.config.baseRepo !== null) settings.OURO_NEXT_BASE_REPO = this.config.baseRepo
    else if (this.config.hubUrl !== null) settings.OURO_NEXT_HUB_URL = this.config.hubUrl
    const text = Object.entries(settings).map(([key, value]) => `export ${key}=${shellQuoted(value)}\n`).join('')
    await api.writeFile(name, SETTINGS, Buffer.from(text), '0600')
    await api.writeFile(name, QUERY_PROGRAM, Buffer.from(QUERY_PROGRAM_TEXT), '0644')
  }

  async destroy(order: ComputerOrder): Promise<void> {
    await this.config.api.deleteSprite(this.spriteNameOf(order.serverId))
  }

  /** The installer defines the services and waits for the first release to go live. */
  async service(order: ComputerOrder): Promise<void> {
    await this.runJob(this.spriteNameOf(order.serverId), 'service', `set -euo pipefail
. ${SETTINGS}
bash ${SOURCE}/scripts/install-run-sprite.sh ${order.distributionCommit}
`, this.config.deadlines.service)
  }

  async address(order: ComputerOrder): Promise<string> {
    const name = this.spriteNameOf(order.serverId)
    const sprite = await this.config.api.getSprite(name)
    if (!sprite) throw new SpriteStepFailure(`the Sprite ${name} is gone`)
    return sprite.url
  }

  async startPairing(order: ComputerOrder): Promise<PairingRecord> {
    const key = `hub-pairing-${order.serverId}-${Date.now()}`
    return await this.query<PairingRecord>(order, 'pair', `node ${QUERY_PROGRAM} pair ${key}`)
  }

  async hasPairedPhone(order: ComputerOrder): Promise<boolean> {
    return (await this.query<{ paired: boolean }>(order, 'paired', `node ${QUERY_PROGRAM} paired`)).paired
  }

  private async query<T>(order: ComputerOrder, job: 'pair' | 'paired', command: string): Promise<T> {
    const name = this.spriteNameOf(order.serverId)
    await this.runJob(name, job, `set -euo pipefail\n${command} > "${this.jobPath(job)}.out.partial"\nmv "${this.jobPath(job)}.out.partial" "${this.jobPath(job)}.out"\n`, this.config.deadlines.query)
    const output = await this.config.api.readFile(name, `${this.jobPath(job)}.out`)
    if (!output) throw new SpriteStepFailure(`the ${job} query left no answer`)
    return JSON.parse(output.toString('utf8')) as T
  }

  private jobPath(job: JobName): string {
    return `${HUB_DIR}/jobs/${job}`
  }

  private async runJob(name: string, job: JobName, script: string, deadlineMs: number): Promise<void> {
    const { api, pollIntervalMs } = this.config
    const outcome = await runSpriteJob({ api, sprite: name, path: this.jobPath(job), script, launcher: LAUNCHER, deadlineMs, pollIntervalMs })
    switch (outcome.kind) {
      case 'succeeded': return
      case 'failed': throw new SpriteStepFailure(`the ${job} job exited ${outcome.status}: ${outcome.logTail || 'no log'}`)
      case 'timed_out': throw new SpriteStepFailure(`the ${job} job didn't end within ${deadlineMs} ms: ${outcome.logTail || 'no log'}`)
    }
  }

  /** The commit as `main` in a bundle of its own history: what the installer clones and fetches. */
  private async bundleOf(commit: string): Promise<Buffer> {
    const scratch = mkdtempSync(join(tmpdir(), 'hub-bundle-'))
    try {
      await execFileAsync('git', ['init', '--quiet', '--bare', scratch])
      await execFileAsync('git', ['-C', scratch, 'fetch', '--quiet', this.config.distributionSource, `${commit}:refs/heads/main`])
      await execFileAsync('git', ['-C', scratch, 'bundle', 'create', '--quiet', join(scratch, 'source.bundle'), 'main'])
      const bundle = readFileSync(join(scratch, 'source.bundle'))
      if (bundle.length > MAX_WRITE_BYTES) throw new SpriteStepFailure(`the source is ${bundle.length} bytes as a bundle, more than one write to a Sprite takes`)
      return bundle
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}
