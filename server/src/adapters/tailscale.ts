// The Tailscale port: install it on this host, start its login, read where it stands, and take it off again.
// On a machine with systemd (an EC2 server) it comes from Tailscale's own package repository, its daemon a systemd service.
// On a Sprite it runs as root through sudo, its daemon a Sprite service. Removing logs out with the daemon up, then lets the
// service manager stop the daemon with SIGTERM, so it undoes its own network changes; never pkill or `tailscaled --cleanup`.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What Tailscale itself says. `stopped`: installed, but its daemon isn't up or it isn't signed in. */
export type TailscaleObservation =
  | { kind: 'not_installed' }
  | { kind: 'stopped' }
  | { kind: 'needs_login'; loginUrl: string }
  | { kind: 'running'; ip: string | null }

/** A step that didn't work. The message is fit to show the person. */
export class TailscaleStepFailed extends Error {}

export interface TailscaleHost {
  observe(): Promise<TailscaleObservation>
  /** Saves a restore point, then installs the tools and starts the daemon as a service. */
  install(): Promise<void>
  /** Starts `tailscale up` and leaves it running: it finishes the login once the person approves the link. */
  startLogin(hostname: string): Promise<void>
  /** Logs out, stops the daemon and removes everything installed. */
  remove(): Promise<void>
}

/**
 * Whether this server is one Ouro sets Tailscale up on. A person's own computer joins their network by itself.
 * `neededForComputers`: whether it reaches linked computers only over Tailscale (a Sprite); a server with its own public
 * address (an EC2 instance) reaches them without it, and connects only for the person's other devices.
 */
export type TailscaleSetup = { kind: 'set_up_here'; host: TailscaleHost; neededForComputers: boolean } | { kind: 'not_needed' }

/** Tailscale names hosts with letters, digits and hyphens. */
export function tailscaleHostnameOf(machineName: string): string {
  const cleaned = machineName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `ouro-${cleaned || 'server'}`.slice(0, 63)
}

const CLI = '/usr/local/bin/tailscale'
const DAEMON = '/usr/local/sbin/tailscaled'
const SOCKET = '/var/run/tailscale/tailscaled.sock'
const SERVICE = 'tailscaled'
const ARCH: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' }

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new TailscaleStepFailed(String(stderr || error.message).trim().slice(-300)))
      else resolve(stdout)
    })
  })
}

const bash = (script: string, timeoutMs: number) => run('bash', ['-euc', script], timeoutMs)

/** `sprite-env` reports a refusal as an error event in its output and still exits 0. */
async function spriteEnv(args: string[], timeoutMs = 60_000): Promise<void> {
  const output = await run('sprite-env', args, timeoutMs)
  if (output.includes('"type":"error"')) throw new TailscaleStepFailed(`sprite-env ${args.slice(0, 2).join(' ')} refused: ${output.trim().slice(-300)}`)
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What `tailscale status` says, through the CLI at `cli`. */
async function observeThrough(cli: string): Promise<TailscaleObservation> {
  if (!existsSync(cli)) return { kind: 'not_installed' }
  let status: { BackendState?: unknown; AuthURL?: unknown; TailscaleIPs?: unknown }
  try {
    status = JSON.parse(await run('sudo', [cli, 'status', '--json'], 10_000)) as typeof status
  } catch {
    return { kind: 'stopped' } // the daemon isn't up
  }
  if (status.BackendState === 'Running') {
    const ips = Array.isArray(status.TailscaleIPs) ? status.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : []
    return { kind: 'running', ip: ips.find((ip) => ip.includes('.')) ?? null }
  }
  if (typeof status.AuthURL === 'string' && status.AuthURL !== '') return { kind: 'needs_login', loginUrl: status.AuthURL }
  return { kind: 'stopped' }
}

/** Starts `tailscale up` once the daemon's socket is there, and leaves it running for the person's approval. */
async function startLoginThrough(cli: string, hostname: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && !existsSync(SOCKET); attempt++) await delay(500)
  if (!existsSync(SOCKET)) throw new TailscaleStepFailed('the Tailscale daemon did not start')
  spawn('sudo', [cli, 'up', `--hostname=${hostname}`, '--accept-dns=false'], { detached: true, stdio: 'ignore' }).unref()
}

/** The package's CLI, and the files its repository adds to apt. */
const SYSTEMD_CLI = '/usr/bin/tailscale'
const APT_FILES = '/etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg'

/** On a Linux machine with systemd and passwordless sudo, such as an EC2 server: Tailscale's own package and service. */
export function systemdTailscale(): TailscaleHost {
  return {
    observe: () => observeThrough(SYSTEMD_CLI),

    async install() {
      if (!existsSync(SYSTEMD_CLI)) {
        await bash(`d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
curl -fsSL https://tailscale.com/install.sh -o "$d/install.sh"
sudo sh "$d/install.sh"`, 300_000)
      }
      await run('sudo', ['systemctl', 'enable', '--now', SERVICE], 60_000)
    },

    startLogin: (hostname) => startLoginThrough(SYSTEMD_CLI, hostname),

    async remove() {
      await run('sudo', [SYSTEMD_CLI, 'logout'], 20_000).catch(() => {}) // already logged out, or never installed
      await bash(`sudo systemctl disable --now ${SERVICE} 2>/dev/null || true
if dpkg -s tailscale >/dev/null 2>&1; then sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y tailscale; fi
sudo rm -f ${APT_FILES}
sudo rm -rf /var/lib/tailscale`, 120_000)
    },
  }
}

export function spriteTailscale(): TailscaleHost {
  return {
    observe: () => observeThrough(CLI),

    async install() {
      try {
        await spriteEnv(['checkpoints', 'create', '--comment', 'before Tailscale'], 180_000)
      } catch {
        throw new TailscaleStepFailed('could not save a restore point, so Tailscale was not installed')
      }
      const arch = ARCH[process.arch]
      if (!arch) throw new TailscaleStepFailed(`no Tailscale build for ${process.arch}`)
      if (!existsSync(CLI) || !existsSync(DAEMON)) {
        await bash(`d=$(mktemp -d); cd "$d"
v=$(curl -fsS 'https://pkgs.tailscale.com/stable/?mode=json' | node -p 'JSON.parse(require("fs").readFileSync(0)).Tarballs.${arch}')
curl -fsSL "https://pkgs.tailscale.com/stable/$v" -o ts.tgz
[ "$(sha256sum ts.tgz | cut -d' ' -f1)" = "$(curl -fsSL "https://pkgs.tailscale.com/stable/$v.sha256")" ]
tar xzf ts.tgz
sudo install -m755 "\${v%.tgz}/tailscale" ${CLI}
sudo install -m755 "\${v%.tgz}/tailscaled" ${DAEMON}
sudo mkdir -p /var/lib/tailscale /var/run/tailscale
rm -rf "$d"`, 180_000)
      }
      await spriteEnv(['services', 'delete', SERVICE]).catch(() => {}) // a daemon service left from an earlier attempt
      await spriteEnv(['services', 'create', SERVICE, '--cmd', '/usr/bin/sudo', '--args',
        [DAEMON, '--state=/var/lib/tailscale/tailscaled.state', `--socket=${SOCKET}`].join(','), '--dir', '/tmp', '--no-stream'])
    },

    startLogin: (hostname) => startLoginThrough(CLI, hostname),

    async remove() {
      await run('sudo', [CLI, 'logout'], 20_000).catch(() => {}) // already logged out, or never installed
      await spriteEnv(['services', 'delete', SERVICE]).catch(() => {}) // no such service
      await bash(`for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x tailscaled >/dev/null || break; sleep 1; done
if pgrep -x tailscaled >/dev/null; then echo 'Tailscale would not stop' >&2; exit 1; fi
sudo rm -rf ${CLI} ${DAEMON} /var/lib/tailscale /var/run/tailscale`, 30_000)
    },
  }
}

interface StandInTailscaleState {
  installed: boolean
  loginStartedAs: string | null
  connected: boolean
}

/**
 * For journeys: Tailscale as files in `dir`, touching no network. A login is approved once `dir/approved` exists. A step
 * fails with the text of `dir/fail-install`, `dir/fail-login` or `dir/fail-remove` when that file exists.
 */
export function standInTailscale(dir: string): TailscaleHost {
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  const read = (): StandInTailscaleState => existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8')) as StandInTailscaleState
    : { installed: false, loginStartedAs: null, connected: false }
  const write = (state: StandInTailscaleState) => writeFileSync(statePath, JSON.stringify(state))
  const failIfAsked = (step: 'install' | 'login' | 'remove') => {
    const path = join(dir, `fail-${step}`)
    if (existsSync(path)) throw new TailscaleStepFailed(readFileSync(path, 'utf8').trim())
  }

  return {
    async observe() {
      const state = read()
      if (!state.installed) return { kind: 'not_installed' }
      if (state.loginStartedAs !== null && existsSync(join(dir, 'approved'))) write({ ...state, loginStartedAs: null, connected: true })
      if (read().connected) return { kind: 'running', ip: '100.64.0.7' }
      if (state.loginStartedAs !== null) return { kind: 'needs_login', loginUrl: `https://login.tailscale.invalid/a/${state.loginStartedAs}` }
      return { kind: 'stopped' }
    },
    async install() {
      failIfAsked('install')
      write({ ...read(), installed: true })
    },
    async startLogin(hostname) {
      failIfAsked('login')
      write({ ...read(), loginStartedAs: hostname })
    },
    async remove() {
      failIfAsked('remove')
      write({ installed: false, loginStartedAs: null, connected: false })
    },
  }
}
