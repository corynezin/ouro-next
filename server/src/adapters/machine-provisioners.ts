// Where new servers come from: an EC2 instance on the connected AWS account, or a Sprite on the connected Sprites
// account. Each is made in the hub's steps (create, upload, install, setup, service, then pair), from this server's own
// source at its current commit, which goes over as a git bundle and becomes the new server's copy of the source. Every
// step is safe to run again: the server may restart during one, and then runs it again.
//
// Long work on the machine runs as a job: a script started detached that writes its exit status to a file, which is
// polled. A job outlives the connection that started it and a restart here; one started again waits for the earlier.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Ec2Api } from './ec2.ts'
import type { SpritesApi } from './sprites-api.ts'

const execFileAsync = promisify(execFile)

/** What a provisioner is told about the server to make. `data` is what its own steps recorded, such as an instance id. */
export interface MachineOrder {
  id: string
  label: string
  commit: string
  data: Readonly<Record<string, string>>
}

export interface PairingCode { code: string; expiresAt: number }

export interface MachineProvisioner {
  /** A machine exists, reachable. What it returns is kept in the order's `data` for the steps after. */
  create(order: MachineOrder): Promise<Record<string, string>>
  /** The source at the order's commit is on it. */
  upload(order: MachineOrder): Promise<void>
  install(order: MachineOrder): Promise<void>
  setup(order: MachineOrder): Promise<void>
  /** Its server runs and answers at its address. */
  service(order: MachineOrder): Promise<void>
  /** Where phones reach its server. */
  address(order: MachineOrder): Promise<string>
  startPairing(order: MachineOrder): Promise<PairingCode>
  hasPairedPhone(order: MachineOrder): Promise<boolean>
  /** The machine is gone; one already gone, or never made, is as good. */
  destroy(order: MachineOrder): Promise<void>
}

export class MachineStepFailure extends Error {}

/** What every new server is set up with, from this one's own settings. */
export interface NewServerSettings {
  /** The git repository the source comes from: this server's copy of the source. */
  sourceRoot: string
  defaultModel: string | null
  baseRepo: string | null
}

/** The name a new server gives itself, from its label: what the person's other computers call it. */
export const machineNameOf = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server'

const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** The commit as `main` in a bundle of its own history: what the installer clones and fetches. */
export async function bundleOf(sourceRoot: string, commit: string): Promise<Buffer> {
  const scratch = mkdtempSync(join(tmpdir(), 'ouro-bundle-'))
  try {
    await execFileAsync('git', ['init', '--quiet', '--bare', scratch])
    await execFileAsync('git', ['-C', scratch, 'fetch', '--quiet', sourceRoot, `${commit}:refs/heads/main`])
    await execFileAsync('git', ['-C', scratch, 'bundle', 'create', '--quiet', join(scratch, 'source.bundle'), 'main'])
    return readFileSync(join(scratch, 'source.bundle'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The commit this server's source is at, which new servers are made from. */
export async function currentCommitOf(sourceRoot: string): Promise<string> {
  return (await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).stdout.trim()
}

/**
 * Asks the new server over its local socket, as its owner, and prints the answer as JSON: `pair` starts a pairing for the
 * owner's phone; `paired` says whether the owner has a paired phone.
 */
const queryProgram = (socketPath: string) => `import { request } from 'node:http'
const socketPath = ${JSON.stringify(socketPath)}
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

/** Clones the bundle as the source, at the commit, with the base branch beside it, as the hub's upload does. */
const cloneScript = (bundle: string, source: string, commit: string) => `set -euo pipefail
if [ ! -d ${source}/.git ]; then git clone --quiet ${bundle} ${source}; fi
git -C ${source} fetch --quiet origin
git -C ${source} rev-parse --verify --quiet ${commit}^{commit} > /dev/null
if [ "$(git -C ${source} rev-parse HEAD)" != ${commit} ]; then git -C ${source} checkout --quiet -B main ${commit}; fi
git -C ${source} show-ref --verify --quiet refs/heads/ouro-base || git -C ${source} branch ouro-base ${commit}
`

const settingsText = (settings: Record<string, string>) => Object.entries(settings).map(([key, value]) => `export ${key}=${shellQuoted(value)}\n`).join('')

/** A failed job's last line of output first, which is what is shown, then the rest of the log's end for the log. */
export function jobFailure(job: string, status: string, logTail: string): string {
  const last = logTail.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).at(-1) ?? 'no output'
  return `the ${job} job exited ${status}: ${last}\n${logTail}`
}

/** Waits until the server answers its identity at the address, as a phone would reach it. */
async function waitForAnswer(address: string, deadlineMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  let last = 'no answer yet'
  for (;;) {
    try {
      const response = await fetch(`${address}/v2/identity`, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) return
      last = `it answered ${response.status}`
    } catch (error) {
      last = (error as Error).message
    }
    if (Date.now() >= deadline) throw new MachineStepFailure(`${address} didn't answer within ${Math.round(deadlineMs / 60_000)} minutes (${last})`)
    await new Promise((done) => setTimeout(done, pollMs))
  }
}

// ---- EC2 ----

export interface Ec2ProvisionerConfig {
  api: Ec2Api
  /** Where each server's SSH key and known host are kept. */
  keysDir: string
  settings: NewServerSettings
  instanceType: string
  diskGb: number
  pollIntervalMs: number
  deadlines: { create: number; ssh: number; upload: number; install: number; service: number }
}

const EC2_USER = 'ubuntu'
const EC2_HOME = `/home/${EC2_USER}`
const EC2_ROOT = `${EC2_HOME}/ouro`
const EC2_WORK = `${EC2_HOME}/ouro-made`
const EC2_SOURCE = `${EC2_ROOT}/source`
const EC2_BUNDLE = `${EC2_WORK}/source.bundle`
export const SECURITY_GROUP = 'ouro-servers'

/** `launch <job>` starts `<job>.sh` detached, holding `<job>.lock`, and writes `<job>.exit` when it ends. */
const PLAIN_LAUNCHER = String.raw`rm -f "$1.exit"
setsid bash -c 'exec 9>"$0.lock"; flock 9; bash "$0.sh" > "$0.log" 2>&1; echo $? > "$0.exit.partial"; mv "$0.exit.partial" "$0.exit"' "$1" < /dev/null > /dev/null 2>&1 &
`

/** The public name the installer gives the machine when told none: its IP, dashed, under sslip.io. */
export const sslipAddressOf = (ip: string): string => `https://${ip.replaceAll('.', '-')}.sslip.io`

export class Ec2Provisioner implements MachineProvisioner {
  private readonly config: Ec2ProvisionerConfig

  constructor(config: Ec2ProvisionerConfig) {
    this.config = config
  }

  async create(order: MachineOrder): Promise<Record<string, string>> {
    const { api } = this.config
    const publicKey = await this.keyOf(order)
    const instanceId = order.data.instanceId ?? await api.runInstance({
      clientToken: `ouro-${order.id}`,
      imageId: await api.latestUbuntuImage(),
      instanceType: this.config.instanceType,
      securityGroupId: await api.ensureSecurityGroup(SECURITY_GROUP, 'Ouro servers: HTTPS for phones and other computers, SSH for the server that made them', [22, 80, 443]),
      userData: `#cloud-config\nssh_authorized_keys:\n  - ${publicKey}\n`,
      diskGb: this.config.diskGb,
      tags: { Name: `ouro-${machineNameOf(order.label)}`, 'ouro-server': order.id },
    })
    const ip = await this.runningIp(instanceId)
    await this.waitForSsh({ ...order, data: { ...order.data, ip } })
    return { instanceId, ip }
  }

  async upload(order: MachineOrder): Promise<void> {
    await this.ssh(order, `mkdir -p ${EC2_WORK}/jobs && cat > ${EC2_BUNDLE}.partial && mv ${EC2_BUNDLE}.partial ${EC2_BUNDLE}`, await bundleOf(this.config.settings.sourceRoot, order.commit))
    await this.ssh(order, `cat > ${EC2_WORK}/launch.sh`, Buffer.from(PLAIN_LAUNCHER))
    await this.runJob(order, 'upload', cloneScript(EC2_BUNDLE, EC2_SOURCE, order.commit), this.config.deadlines.upload)
  }

  /** The installer puts on what Ouro needs, HTTPS in front of it, and the server as systemd services, and waits for it. */
  async install(order: MachineOrder): Promise<void> {
    const { settings } = this.config
    const env: Record<string, string> = { OURO_NEXT_ROOT: EC2_ROOT, OURO_NEXT_REPO: EC2_BUNDLE, OURO_NEXT_SERVICE_PREFIX: 'ouro', OURO_NEXT_MACHINE_NAME: machineNameOf(order.label) }
    if (settings.defaultModel !== null) env.OURO_NEXT_DEFAULT_MODEL = settings.defaultModel
    if (settings.baseRepo !== null) env.OURO_NEXT_BASE_REPO = settings.baseRepo
    await this.runJob(order, 'install', `set -euo pipefail
# The first boot's own package work holds apt's lock until it is done.
cloud-init status --wait > /dev/null 2>&1 || true
${settingsText(env)}bash ${EC2_SOURCE}/scripts/install-run-ubuntu.sh ${order.commit}
`, this.config.deadlines.install)
  }

  async setup(order: MachineOrder): Promise<void> {
    await this.ssh(order, `cat > ${EC2_WORK}/query.mjs`, Buffer.from(queryProgram(`${EC2_ROOT}/home/data/local.sock`)))
  }

  /** Caddy's certificate can take a minute after the server is up. */
  async service(order: MachineOrder): Promise<void> {
    await waitForAnswer(sslipAddressOf(this.ipOf(order)), this.config.deadlines.service, this.config.pollIntervalMs)
  }

  async address(order: MachineOrder): Promise<string> {
    return sslipAddressOf(this.ipOf(order))
  }

  async startPairing(order: MachineOrder): Promise<PairingCode> {
    const key = `made-pairing-${order.id}-${Date.now()}`
    return JSON.parse(await this.ssh(order, `node ${EC2_WORK}/query.mjs pair ${key}`)) as PairingCode
  }

  async hasPairedPhone(order: MachineOrder): Promise<boolean> {
    return (JSON.parse(await this.ssh(order, `node ${EC2_WORK}/query.mjs paired`)) as { paired: boolean }).paired
  }

  async destroy(order: MachineOrder): Promise<void> {
    if (order.data.instanceId) await this.config.api.terminateInstance(order.data.instanceId)
    rmSync(join(this.config.keysDir, order.id), { recursive: true, force: true })
  }

  private ipOf(order: MachineOrder): string {
    const ip = order.data.ip
    if (!ip) throw new MachineStepFailure('the instance has no address recorded')
    return ip
  }

  /** The order's own SSH key, made once: its public half goes on the instance when it is made. */
  private async keyOf(order: MachineOrder): Promise<string> {
    const dir = join(this.config.keysDir, order.id)
    const key = join(dir, 'ssh-key')
    if (!existsSync(`${key}.pub`)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      rmSync(key, { force: true })
      await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `ouro-${order.id}`, '-f', key])
    }
    return readFileSync(`${key}.pub`, 'utf8').trim()
  }

  private async runningIp(instanceId: string): Promise<string> {
    const deadline = Date.now() + this.config.deadlines.create
    for (;;) {
      const instance = await this.config.api.describeInstance(instanceId)
      if (instance && ['shutting-down', 'terminated', 'stopping', 'stopped'].includes(instance.state)) throw new MachineStepFailure(`the instance ${instanceId} is ${instance.state}`)
      if (instance?.state === 'running' && instance.publicIp) return instance.publicIp
      if (Date.now() >= deadline) throw new MachineStepFailure(`the instance ${instanceId} wasn't running with a public IP in time (it is ${instance?.state ?? 'not listed yet'})`)
      await new Promise((done) => setTimeout(done, this.config.pollIntervalMs))
    }
  }

  private async waitForSsh(order: MachineOrder): Promise<void> {
    const deadline = Date.now() + this.config.deadlines.ssh
    for (;;) {
      try {
        await this.ssh(order, 'true')
        return
      } catch (error) {
        if (Date.now() >= deadline) throw new MachineStepFailure(`couldn't reach ${this.ipOf(order)} by SSH: ${(error as Error).message}`)
      }
      await new Promise((done) => setTimeout(done, this.config.pollIntervalMs))
    }
  }

  private async runJob(order: MachineOrder, job: string, script: string, deadlineMs: number): Promise<void> {
    const path = `${EC2_WORK}/jobs/${job}`
    await this.ssh(order, `mkdir -p ${EC2_WORK}/jobs && cat > ${path}.sh`, Buffer.from(script))
    await this.ssh(order, `bash ${EC2_WORK}/launch.sh ${path}`)
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const exit = await this.ssh(order, `cat ${path}.exit 2>/dev/null || true`).catch(() => '')
      if (exit.trim() !== '') {
        if (exit.trim() === '0') return
        throw new MachineStepFailure(jobFailure(job, exit.trim(), await this.ssh(order, `tail -c 1500 ${path}.log`).catch(() => '')))
      }
      if (Date.now() >= deadline) throw new MachineStepFailure(`the ${job} job didn't end within ${Math.round(deadlineMs / 60_000)} minutes`)
      await new Promise((done) => setTimeout(done, this.config.pollIntervalMs))
    }
  }

  /** Runs a command on the order's instance as its user and gives its output; `input` goes to its standard input. */
  private ssh(order: MachineOrder, command: string, input?: Buffer): Promise<string> {
    return runSsh(join(this.config.keysDir, order.id), this.ipOf(order), command, input)
  }
}

/** One SSH command, with the key in `dir` and the host remembered there on first contact. */
export function runSsh(dir: string, ip: string, command: string, input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-i', join(dir, 'ssh-key'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', `${EC2_USER}@${ip}`, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new MachineStepFailure(`ssh ${command.split(' ')[0]} exited ${code}: ${stderr.trim().slice(-500) || stdout.trim().slice(-500)}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

// ---- Sprites ----

export interface SpriteMachineProvisionerConfig {
  api: SpritesApi
  settings: NewServerSettings
  pollIntervalMs: number
  deadlines: { upload: number; install: number; service: number; query: number }
}

const SPRITE_HOME = '/home/sprite'
const SPRITE_ROOT = `${SPRITE_HOME}/ouro`
const SPRITE_WORK = `${SPRITE_HOME}/ouro-made`
const SPRITE_BUNDLE = `${SPRITE_WORK}/source.bundle`
const SPRITE_SETTINGS = `${SPRITE_WORK}/settings.env`
const SPRITE_QUERY = `${SPRITE_WORK}/query.mjs`
const SPRITE_SOURCE = `${SPRITE_ROOT}/source`
const SPRITE_TASKS_SOCKET = '/.sprite/api.sock'
const HOLD_RENEW_SECONDS = 60

/**
 * The hub's launcher (hub/src/sprite-provisioner.ts): as PLAIN_LAUNCHER, and while the job runs it holds the Sprite awake
 * through its Tasks API, since a Sprite with no session open pauses and would freeze the job.
 */
const SPRITE_LAUNCHER = String.raw`rm -f "$1.exit" "$1.out"
curl -sS --max-time 20 --unix-socket "$2" -X PUT -H "content-type: application/json" -d "{\"expire\":\"5m\"}" "http://sprite/v1/tasks/ouro-made-$(basename "$1")-launch" > /dev/null 2>&1 || true
setsid bash -c '
exec 9>"$0.lock"; flock 9
task="http://sprite/v1/tasks/ouro-made-$(basename "$0")"
hold() { curl -sS --max-time 20 --unix-socket "$1" -X PUT -H "content-type: application/json" -d "{\"expire\":\"5m\"}" "$task" > /dev/null 2>&1; }
hold "$@"
(trap exit TERM; while sleep "$2" & wait $!; do hold "$@"; done) & renewer=$!
bash "$0.sh" > "$0.log" 2>&1; status=$?
kill "$renewer"; wait "$renewer"
curl -sS --unix-socket "$1" -X DELETE "$task" > /dev/null 2>&1
echo "$status" > "$0.exit.partial"; mv "$0.exit.partial" "$0.exit"' "$1" "$2" "$3" < /dev/null > /dev/null 2>&1 &`

/** A Sprite's name: the API's prefix, the label, and a few random letters so two of the same label differ. */
export const spriteNameFor = (prefix: string, label: string): string => `${prefix}${machineNameOf(label).slice(0, 20)}-${randomBytes(2).toString('hex')}`

export class SpriteMachineProvisioner implements MachineProvisioner {
  private readonly config: SpriteMachineProvisionerConfig

  constructor(config: SpriteMachineProvisionerConfig) {
    this.config = config
  }

  async create(order: MachineOrder): Promise<Record<string, string>> {
    const { api } = this.config
    const name = order.data.sprite ?? spriteNameFor(api.namePrefix, order.label)
    const sprite = await api.getSprite(name) ?? await api.createSprite(name)
    if (sprite.urlAuth !== 'public') await api.makeUrlPublic(name)
    return { sprite: name }
  }

  async upload(order: MachineOrder): Promise<void> {
    const name = this.nameOf(order)
    await this.config.api.writeFile(name, SPRITE_BUNDLE, await bundleOf(this.config.settings.sourceRoot, order.commit), '0644')
    await this.runJob(name, 'upload', cloneScript(SPRITE_BUNDLE, SPRITE_SOURCE, order.commit), this.config.deadlines.upload)
  }

  async install(order: MachineOrder): Promise<void> {
    await this.runJob(this.nameOf(order), 'install', `set -euo pipefail
mkdir -p ${SPRITE_ROOT}/install
lock_hash=$(sha256sum ${SPRITE_SOURCE}/package-lock.json | cut -d' ' -f1)
if [ ! -d ${SPRITE_SOURCE}/node_modules ] || [ "$(cat ${SPRITE_ROOT}/install/installed-lock 2>/dev/null)" != "$lock_hash" ]; then
  (cd ${SPRITE_SOURCE} && npm ci --no-audit --no-fund --loglevel=error)
  echo "$lock_hash" > ${SPRITE_ROOT}/install/installed-lock
fi
`, this.config.deadlines.install)
  }

  async setup(order: MachineOrder): Promise<void> {
    const { api, settings } = this.config
    const name = this.nameOf(order)
    const sprite = await api.getSprite(name)
    if (!sprite) throw new MachineStepFailure(`the Sprite ${name} is gone`)
    const env: Record<string, string> = {
      OURO_NEXT_ROOT: SPRITE_ROOT, OURO_NEXT_PUBLIC_URL: sprite.url, OURO_NEXT_REPO: SPRITE_BUNDLE, OURO_NEXT_SERVICE_PREFIX: 'ouro',
      OURO_NEXT_MACHINE_NAME: machineNameOf(order.label),
    }
    if (settings.defaultModel !== null) env.OURO_NEXT_DEFAULT_MODEL = settings.defaultModel
    if (settings.baseRepo !== null) env.OURO_NEXT_BASE_REPO = settings.baseRepo
    await api.writeFile(name, SPRITE_SETTINGS, Buffer.from(settingsText(env)), '0600')
    await api.writeFile(name, SPRITE_QUERY, Buffer.from(queryProgram(`${SPRITE_ROOT}/home/data/local.sock`)), '0644')
  }

  async service(order: MachineOrder): Promise<void> {
    await this.runJob(this.nameOf(order), 'service', `set -euo pipefail
. ${SPRITE_SETTINGS}
bash ${SPRITE_SOURCE}/scripts/install-run-sprite.sh ${order.commit}
`, this.config.deadlines.service)
  }

  async address(order: MachineOrder): Promise<string> {
    const name = this.nameOf(order)
    const sprite = await this.config.api.getSprite(name)
    if (!sprite) throw new MachineStepFailure(`the Sprite ${name} is gone`)
    return sprite.url
  }

  async startPairing(order: MachineOrder): Promise<PairingCode> {
    return await this.query<PairingCode>(order, 'pair', `node ${SPRITE_QUERY} pair made-pairing-${order.id}-${Date.now()}`)
  }

  async hasPairedPhone(order: MachineOrder): Promise<boolean> {
    return (await this.query<{ paired: boolean }>(order, 'paired', `node ${SPRITE_QUERY} paired`)).paired
  }

  async destroy(order: MachineOrder): Promise<void> {
    if (order.data.sprite) await this.config.api.deleteSprite(order.data.sprite)
  }

  private nameOf(order: MachineOrder): string {
    const name = order.data.sprite
    if (!name) throw new MachineStepFailure('the Sprite has no name recorded')
    return name
  }

  private async query<T>(order: MachineOrder, job: 'pair' | 'paired', command: string): Promise<T> {
    const name = this.nameOf(order)
    const path = `${SPRITE_WORK}/jobs/${job}`
    await this.runJob(name, job, `set -euo pipefail\n${command} > "${path}.out.partial"\nmv "${path}.out.partial" "${path}.out"\n`, this.config.deadlines.query)
    const output = await this.config.api.readFile(name, `${path}.out`)
    if (!output) throw new MachineStepFailure(`the ${job} query left no answer`)
    return JSON.parse(output.toString('utf8')) as T
  }

  private async runJob(name: string, job: string, script: string, deadlineMs: number): Promise<void> {
    const { api, pollIntervalMs } = this.config
    const path = `${SPRITE_WORK}/jobs/${job}`
    await api.writeFile(name, `${path}.sh`, Buffer.from(script), '0755')
    await api.exec(name, ['bash', '-c', SPRITE_LAUNCHER, 'launch', path, SPRITE_TASKS_SOCKET, String(HOLD_RENEW_SECONDS)])
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const exit = await api.readFile(name, `${path}.exit`)
      if (exit) {
        const status = Number(exit.toString('utf8').trim())
        if (status === 0) return
        const log = await api.readFile(name, `${path}.log`).catch(() => null)
        throw new MachineStepFailure(jobFailure(job, String(status), log ? log.toString('utf8').slice(-1500) : ''))
      }
      if (Date.now() >= deadline) throw new MachineStepFailure(`the ${job} job didn't end within ${Math.round(deadlineMs / 60_000)} minutes`)
      await new Promise((done) => setTimeout(done, pollIntervalMs))
    }
  }
}
