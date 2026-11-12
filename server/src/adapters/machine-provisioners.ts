// Where new servers come from: an EC2 instance on the connected AWS account, or a Sprite on the connected Sprites
// account. Each is made in the hub's steps (create, upload, install, setup, service, then pair), from this server's own
// source at its current commit, which goes over as a git bundle and becomes the new server's copy of the source. Every
// step is safe to run again: the server may restart during one, and then runs it again.
//
// Long work on the machine runs as a job: a script started detached that writes its exit status to a file, which is
// polled. A job outlives the connection that started it and a restart here; one started again waits for the earlier.
//
// A machine is found again without anything recorded, so one is never left billing: a Sprite's name comes from the
// order's id, and an EC2 instance carries the order's id in its `ouro-server` tag. `create` also records what it made
// the moment it exists.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runSpriteJob, spriteLauncher } from '@ouro/contract/sprites'
import type { MadeServerInvite } from '@ouro/contract'
import type { SpritesApi } from '@ouro/contract/sprites'
import type { Ec2Api } from './ec2.ts'

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
  /**
   * A machine exists, reachable. `record` is called as soon as the machine exists, before any wait, and what it is given
   * is kept in the order's `data` at once; what `create` returns is kept too, for the steps after.
   */
  create(order: MachineOrder, record: (data: Record<string, string>) => void): Promise<Record<string, string>>
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
  /** Its server takes the invite, as its owner. */
  join(order: MachineOrder, invite: MadeServerInvite): Promise<void>
  /** The machine is gone; one already gone, or never made, is as good. Found even when `data` holds nothing. */
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

/**
 * The installers the provisioners run on a new machine, from the root of its copy of the source. Each one's header lists
 * the settings the provisioner gives it.
 */
export const INSTALLERS = { ec2: 'scripts/install-run-ubuntu.sh', sprite: 'scripts/install-run-sprite.sh' } as const

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
 * owner's phone; `paired` says whether the owner has a paired phone; `join-network` (as its home, of the kind given) and
 * `join-computer` take an invite from the server that made it.
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
const [query, key, address, code, kind] = process.argv.slice(2)
if (query === 'pair') {
  const started = await ask('POST', '/v2/commands/start_pairing', { idempotencyKey: key, input: { inviteePersonName: null } })
  process.stdout.write(JSON.stringify({ code: started.code, expiresAt: started.expiresAt }))
} else if (query === 'paired') {
  const snapshot = await ask('GET', '/v2/snapshot')
  process.stdout.write(JSON.stringify({ paired: snapshot.devices.some((device) => device.personId === snapshot.viewer.personId) }))
} else if (query === 'join-network') {
  await ask('POST', '/v2/commands/join_network', { idempotencyKey: key, input: { address, code, role: 'home', kind } })
  process.stdout.write(JSON.stringify({ joined: true }))
} else if (query === 'join-computer') {
  await ask('POST', '/v2/commands/join_computer', { idempotencyKey: key, input: { address, code } })
  process.stdout.write(JSON.stringify({ joined: true }))
} else {
  throw new Error('no query ' + query)
}
`

/** The query program's arguments for taking an invite, quoted for the shell: a network's kind last. */
const joinArguments = (order: MachineOrder, invite: MadeServerInvite): string =>
  [`join-${invite.kind}`, `made-join-${order.id}-${Date.now()}`, invite.address, invite.code, ...(invite.kind === 'network' ? [invite.networkKind] : [])]
    .map(shellQuoted).join(' ')

/** Clones the bundle as the source, at the commit, with the base branch beside it, as the hub's upload does. */
const cloneScript = (bundle: string, source: string, commit: string) => `set -euo pipefail
if [ ! -d ${source}/.git ]; then git clone --quiet ${bundle} ${source}; fi
git -C ${source} fetch --quiet origin
git -C ${source} rev-parse --verify --quiet ${commit}^{commit} > /dev/null
if [ "$(git -C ${source} rev-parse HEAD)" != ${commit} ]; then git -C ${source} checkout --quiet -B main ${commit}; fi
git -C ${source} show-ref --verify --quiet refs/heads/ouro-base || git -C ${source} branch ouro-base ${commit}
`

/**
 * What install-run-ubuntu.sh (and install-run.sh under it) is told. The public URL is given, not left to the installer's
 * own default (the same sslip.io name), so the address phones pair with is decided in one place: here.
 */
export function ec2InstallerSettings(order: MachineOrder, ip: string, settings: NewServerSettings): Record<string, string> {
  const env: Record<string, string> = {
    OURO_NEXT_ROOT: EC2_ROOT, OURO_NEXT_PUBLIC_URL: sslipAddressOf(ip), OURO_NEXT_REPO: EC2_BUNDLE, OURO_NEXT_MACHINE_NAME: machineNameOf(order.label),
  }
  if (settings.defaultModel !== null) env.OURO_NEXT_DEFAULT_MODEL = settings.defaultModel
  if (settings.baseRepo !== null) env.OURO_NEXT_BASE_REPO = settings.baseRepo
  return env
}

/**
 * What install-run-sprite.sh is told. Its own defaults are for the person's run Sprite (~/ouro-next, services
 * ouro-next-…), so a made Sprite's root and service names are given; its peer address defaults to the public URL.
 */
export function spriteInstallerSettings(order: MachineOrder, url: string, settings: NewServerSettings): Record<string, string> {
  const env: Record<string, string> = {
    OURO_NEXT_ROOT: SPRITE_ROOT, OURO_NEXT_PUBLIC_URL: url, OURO_NEXT_REPO: SPRITE_BUNDLE, OURO_NEXT_SERVICE_PREFIX: 'ouro',
    OURO_NEXT_MACHINE_NAME: machineNameOf(order.label),
  }
  if (settings.defaultModel !== null) env.OURO_NEXT_DEFAULT_MODEL = settings.defaultModel
  if (settings.baseRepo !== null) env.OURO_NEXT_BASE_REPO = settings.baseRepo
  return env
}

const settingsText = (settings: Record<string, string>) => Object.entries(settings).map(([key, value]) => `export ${key}=${shellQuoted(value)}\n`).join('')

/** A failed job's last line of output first, which is what is shown, then the rest of the log's end for the log. */
export function jobFailure(job: string, status: string, logTail: string): string {
  const last = logTail.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).at(-1) ?? 'no output'
  return `the ${job} job exited ${status}: ${last}\n${logTail}`
}

export const jobTimeout = (job: string, deadlineMs: number): string => `the ${job} job didn't end within ${Math.round(deadlineMs / 60_000)} minutes`

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

/** Runs one command on a machine by SSH, with the key and known host in `dir`, and gives its output. */
export type SshRunner = (dir: string, ip: string, command: string, input?: Buffer) => Promise<string>

export interface Ec2ProvisionerConfig {
  api: Ec2Api
  /** Where each server's SSH key and known host are kept, and which address SSH was last opened to. */
  keysDir: string
  /** `runSsh` but in tests. */
  ssh: SshRunner
  /** This server's own public IPv4 address, as the machines it makes see it: the one SSH is opened to. */
  makerAddress: () => Promise<string>
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
const SECURITY_GROUP_DESCRIPTION = 'Ouro servers: HTTPS for phones and other computers, SSH only from the servers that made them'
/** Phones and other computers reach a made server from anywhere: Caddy answers 80 (for its certificate) and 443. */
const PUBLIC_PORTS = [80, 443] as const
const SSH_PORT = 22
const ANYWHERE = '0.0.0.0/0'
/** The tag that names the order an instance was made for, so destroy finds it without a recorded id. */
export const SERVER_TAG = 'ouro-server'
/**
 * How long a check of this server's own address holds before SSH is used again. Its address can change (a restart, a
 * new lease), and SSH is still used after setup, to pair and to check pairing; a stale rule only delays those.
 */
const SSH_ACCESS_RECHECK_MS = 5 * 60_000
/** Which address each security group's SSH rule was opened to from here, kept beside the keys. */
const SSH_ACCESS_FILE = 'ssh-access.json'
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** This server's public address, from AWS's own service: what a machine it makes sees connecting. */
export async function publicAddressOfThisServer(): Promise<string> {
  const response = await fetch('https://checkip.amazonaws.com/', { signal: AbortSignal.timeout(10_000) })
  const address = (await response.text()).trim()
  if (!response.ok || !IPV4.test(address)) throw new MachineStepFailure(`couldn't find this server's public address (${response.status})`)
  return address
}

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

  async create(order: MachineOrder, record: (data: Record<string, string>) => void): Promise<Record<string, string>> {
    const { api } = this.config
    const publicKey = await this.keyOf(order)
    const securityGroupId = await this.securityGroup()
    // The client token makes this safe to ask again after a restart: AWS answers with the instance it already started.
    const instanceId = order.data.instanceId ?? await api.runInstance({
      clientToken: `ouro-${order.id}`,
      imageId: await api.latestUbuntuImage(),
      instanceType: this.config.instanceType,
      securityGroupId,
      userData: `#cloud-config\nssh_authorized_keys:\n  - ${publicKey}\n`,
      diskGb: this.config.diskGb,
      tags: { Name: `ouro-${machineNameOf(order.label)}`, [SERVER_TAG]: order.id },
    })
    record({ instanceId })
    const ip = await this.runningIp(instanceId)
    record({ instanceId, ip })
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
    await this.runJob(order, 'install', `set -euo pipefail
# The first boot's own package work holds apt's lock until it is done.
cloud-init status --wait > /dev/null 2>&1 || true
${settingsText(ec2InstallerSettings(order, this.ipOf(order), this.config.settings))}bash ${EC2_SOURCE}/${INSTALLERS.ec2} ${order.commit}
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

  async join(order: MachineOrder, invite: MadeServerInvite): Promise<void> {
    await this.ssh(order, `node ${EC2_WORK}/query.mjs ${joinArguments(order, invite)}`)
  }

  /** The recorded instance, or, when none was recorded, every live instance tagged with the order's id. */
  async destroy(order: MachineOrder): Promise<void> {
    const { api } = this.config
    const instanceIds = order.data.instanceId
      ? [order.data.instanceId]
      : (await api.instancesTagged(SERVER_TAG, order.id)).filter((instance) => instance.state !== 'terminated').map((instance) => instance.instanceId)
    for (const instanceId of instanceIds) await api.terminateInstance(instanceId)
    rmSync(join(this.config.keysDir, order.id), { recursive: true, force: true })
  }

  /** The shared group: 80 and 443 open to anyone, SSH only from this server. */
  private async securityGroup(): Promise<string> {
    const { api } = this.config
    const groupId = await api.ensureSecurityGroup(SECURITY_GROUP, SECURITY_GROUP_DESCRIPTION)
    for (const port of PUBLIC_PORTS) await api.allowIngress(groupId, port, ANYWHERE)
    // Servers made before opened SSH to everyone.
    await api.revokeIngress(groupId, SSH_PORT, ANYWHERE)
    await this.openSshTo(groupId)
    return groupId
  }

  private sshAccess: { groupId: string; checkedAt: number } | null = null

  /**
   * SSH open to this server's address now. When the address changed, the new one is let in and the one this server let
   * in before is let go; other servers' rules on the same group are left alone.
   */
  private async openSshTo(groupId: string): Promise<void> {
    const { api } = this.config
    const address = await this.config.makerAddress()
    if (!IPV4.test(address)) throw new MachineStepFailure(`this server's address ${JSON.stringify(address)} isn't an IPv4 address`)
    const cidr = `${address}/32`
    const accessFile = join(this.config.keysDir, SSH_ACCESS_FILE)
    const opened = existsSync(accessFile) ? JSON.parse(readFileSync(accessFile, 'utf8')) as Record<string, string> : {}
    if (opened[groupId] !== cidr) {
      await api.allowIngress(groupId, SSH_PORT, cidr)
      if (opened[groupId]) await api.revokeIngress(groupId, SSH_PORT, opened[groupId])
      mkdirSync(this.config.keysDir, { recursive: true, mode: 0o700 })
      writeFileSync(accessFile, JSON.stringify({ ...opened, [groupId]: cidr }), { mode: 0o600 })
    }
    this.sshAccess = { groupId, checkedAt: Date.now() }
  }

  /** Before SSH after a restart or a while: this server's address may have changed since the group was opened to it. */
  private async ensureSshAccess(): Promise<void> {
    if (this.sshAccess !== null && Date.now() - this.sshAccess.checkedAt < SSH_ACCESS_RECHECK_MS) return
    await this.openSshTo(this.sshAccess?.groupId ?? await this.config.api.ensureSecurityGroup(SECURITY_GROUP, SECURITY_GROUP_DESCRIPTION))
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
      if (Date.now() >= deadline) throw new MachineStepFailure(jobTimeout(job, deadlineMs))
      await new Promise((done) => setTimeout(done, this.config.pollIntervalMs))
    }
  }

  /** Runs a command on the order's instance as its user and gives its output; `input` goes to its standard input. */
  private async ssh(order: MachineOrder, command: string, input?: Buffer): Promise<string> {
    await this.ensureSshAccess()
    return await this.config.ssh(join(this.config.keysDir, order.id), this.ipOf(order), command, input)
  }
}

/**
 * One SSH command, with the key in `dir` and the host remembered there on first contact (a fresh instance's host key
 * isn't known beforehand; its key-only login and an SSH rule open only to this server narrow who could answer first).
 */
export const runSsh: SshRunner = (dir, ip, command, input) => {
  return new Promise<string>((resolve, reject) => {
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
/** The shared launcher (packages/contract/src/sprites/jobs.ts), with this server's tasks named `ouro-made-<job>`. */
const SPRITE_LAUNCHER = spriteLauncher('ouro-made-')

/** A Sprite's name: the API's prefix and the order's id, so a Sprite is found again after a restart, or by destroy. */
export const spriteNameOf = (prefix: string, orderId: string): string => `${prefix}${orderId}`

export class SpriteMachineProvisioner implements MachineProvisioner {
  private readonly config: SpriteMachineProvisionerConfig

  constructor(config: SpriteMachineProvisionerConfig) {
    this.config = config
  }

  async create(order: MachineOrder, record: (data: Record<string, string>) => void): Promise<Record<string, string>> {
    const { api } = this.config
    const name = this.nameOf(order)
    record({ sprite: name })
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
    await api.writeFile(name, SPRITE_SETTINGS, Buffer.from(settingsText(spriteInstallerSettings(order, sprite.url, settings))), '0600')
    await api.writeFile(name, SPRITE_QUERY, Buffer.from(queryProgram(`${SPRITE_ROOT}/home/data/local.sock`)), '0644')
  }

  async service(order: MachineOrder): Promise<void> {
    await this.runJob(this.nameOf(order), 'service', `set -euo pipefail
. ${SPRITE_SETTINGS}
bash ${SPRITE_SOURCE}/${INSTALLERS.sprite} ${order.commit}
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

  async join(order: MachineOrder, invite: MadeServerInvite): Promise<void> {
    await this.query<{ joined: boolean }>(order, 'join', `node ${SPRITE_QUERY} ${joinArguments(order, invite)}`)
  }

  async destroy(order: MachineOrder): Promise<void> {
    await this.config.api.deleteSprite(this.nameOf(order))
  }

  /** The recorded name, for a Sprite made before names came from the order's id; else the one from its id. */
  private nameOf(order: MachineOrder): string {
    return order.data.sprite ?? spriteNameOf(this.config.api.namePrefix, order.id)
  }

  private async query<T>(order: MachineOrder, job: 'pair' | 'paired' | 'join', command: string): Promise<T> {
    const name = this.nameOf(order)
    const path = `${SPRITE_WORK}/jobs/${job}`
    await this.runJob(name, job, `set -euo pipefail\n${command} > "${path}.out.partial"\nmv "${path}.out.partial" "${path}.out"\n`, this.config.deadlines.query)
    const output = await this.config.api.readFile(name, `${path}.out`)
    if (!output) throw new MachineStepFailure(`the ${job} query left no answer`)
    return JSON.parse(output.toString('utf8')) as T
  }

  private async runJob(name: string, job: string, script: string, deadlineMs: number): Promise<void> {
    const { api, pollIntervalMs } = this.config
    const outcome = await runSpriteJob({ api, sprite: name, path: `${SPRITE_WORK}/jobs/${job}`, script, launcher: SPRITE_LAUNCHER, deadlineMs, pollIntervalMs })
    switch (outcome.kind) {
      case 'succeeded': return
      case 'failed': throw new MachineStepFailure(jobFailure(job, String(outcome.status), outcome.logTail))
      case 'timed_out': throw new MachineStepFailure(jobTimeout(job, deadlineMs))
    }
  }
}
