// scripts/lib/guardian-config.mjs, run as install-run.sh runs it: the guardian's configuration it writes, and that it
// leaves an unchanged one alone.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const program = join(import.meta.dirname, '..', 'scripts', 'lib', 'guardian-config.mjs')
const dir = mkdtempSync(join(tmpdir(), 'guardian-config-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const base = {
  OURO_CONFIG_HOME: '/r/home', OURO_CONFIG_SOURCE: '/r/source', OURO_CONFIG_PORT: '8080', OURO_CONFIG_LISTEN_HOST: '0.0.0.0',
  OURO_CONFIG_URL: 'https://ouro.example', OURO_CONFIG_SOCKET: "/r/home/runner-host.sock", OURO_CONFIG_MACHINE: "mac's mini",
  OURO_CONFIG_SERVICES: 'launchd', OURO_CONFIG_PEER: '', OURO_CONFIG_MODEL: '', OURO_CONFIG_BASE_REPO: '', OURO_CONFIG_APNS_KEY_FILE: '',
  OURO_CONFIG_APNS_KEY_ID: '', OURO_CONFIG_APNS_TEAM_ID: 'U2Q2D6ZQP2',
}

function run(path: string, settings: Record<string, string>): string {
  // Only PATH from this process, so nothing else in the environment reaches the program.
  const result = spawnSync(process.execPath, [program, path], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...settings } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('a Sprite or Mac configuration has no listenHost, and is byte for byte what the installer wrote before', () => {
  const path = join(dir, 'mac.json')
  assert.equal(run(path, base), 'written')
  // What the earlier inline program wrote, so a server installed before keeps its file and its guardian.
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify({
    home: '/r/home', listenPort: 8080, sourceDir: '/r/source', appSourceDir: '/r/source/apps/mobile', sourceBranch: 'main',
    machineName: "mac's mini", publicUrl: 'https://ouro.example', ourodEnv: { OURO_RUNNER_HOST_SOCKET: '/r/home/runner-host.sock' },
  }, null, 2)}\n`)
})

test('a systemd server listens on 127.0.0.1, can set up Tailscale, and passes on what it was given', () => {
  const path = join(dir, 'ubuntu.json')
  assert.equal(run(path, {
    ...base, OURO_CONFIG_SERVICES: 'systemd', OURO_CONFIG_LISTEN_HOST: '127.0.0.1', OURO_CONFIG_PEER: 'https://peer.example',
    OURO_CONFIG_MODEL: 'opus', OURO_CONFIG_BASE_REPO: 'https://github.com/o/r', OURO_CONFIG_APNS_KEY_FILE: '/r/apns/AuthKey_K1.p8', OURO_CONFIG_APNS_KEY_ID: 'K1',
  }), 'written')
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  assert.equal(config.listenHost, '127.0.0.1')
  assert.equal(config.listenPort, 8080)
  assert.deepEqual(config.ourodEnv, {
    OURO_RUNNER_HOST_SOCKET: '/r/home/runner-host.sock', OURO_TAILSCALE: 'systemd', OURO_PEER_ADDRESS: 'https://peer.example',
    OURO_DEFAULT_MODEL: 'opus', OURO_BASE_REPO: 'https://github.com/o/r',
    OURO_APNS_KEY_FILE: '/r/apns/AuthKey_K1.p8', OURO_APNS_KEY_ID: 'K1', OURO_APNS_TEAM_ID: 'U2Q2D6ZQP2',
  })
})

test('an unchanged configuration is not rewritten; a changed one is', () => {
  const path = join(dir, 'again.json')
  assert.equal(run(path, base), 'written')
  const past = new Date('2020-01-01T00:00:00Z')
  utimesSync(path, past, past)
  assert.equal(run(path, base), 'unchanged')
  assert.equal(statSync(path).mtimeMs, past.getTime(), 'the file was left alone')
  assert.equal(run(path, { ...base, OURO_CONFIG_URL: 'https://other.example' }), 'written')
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { publicUrl: string }).publicUrl, 'https://other.example')
})

test('without a path it says how to run it and writes nothing', () => {
  const result = spawnSync(process.execPath, [program], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage/)
})
