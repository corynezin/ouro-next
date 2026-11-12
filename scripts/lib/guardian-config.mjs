// The guardian's configuration, for install-run.sh: built from the settings it is given as environment variables, and
// written to the path given as its argument only when it differs from what is there, so an unchanged server's guardian
// isn't restarted. Prints `written` or `unchanged`. A file of its own so its JavaScript is never inside shell quotes.
//
//   node scripts/lib/guardian-config.mjs <config path>
//
// Settings (all OURO_CONFIG_…): HOME, SOURCE, PORT, LISTEN_HOST, URL, SOCKET, MACHINE, SERVICES, and optionally PEER,
// MODEL, BASE_REPO, APNS_KEY_FILE with APNS_KEY_ID and APNS_TEAM_ID.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/** The guardian binds every interface unless told otherwise (guardian/src/config.ts). */
const GUARDIAN_DEFAULT_LISTEN_HOST = '0.0.0.0'

function guardianConfigText(settings) {
  const ourodEnv = { OURO_RUNNER_HOST_SOCKET: settings.SOCKET }
  // Tailscale is the Sprite way in; a machine of its own under systemd can still join the person's Tailscale network.
  // A Mac has the Tailscale app, which the person signs in to themselves.
  if (settings.SERVICES === 'sprite' || settings.SERVICES === 'systemd') ourodEnv.OURO_TAILSCALE = settings.SERVICES
  if (settings.PEER) ourodEnv.OURO_PEER_ADDRESS = settings.PEER
  if (settings.MODEL) ourodEnv.OURO_DEFAULT_MODEL = settings.MODEL
  if (settings.BASE_REPO) ourodEnv.OURO_BASE_REPO = settings.BASE_REPO
  if (settings.APNS_KEY_FILE) {
    Object.assign(ourodEnv, { OURO_APNS_KEY_FILE: settings.APNS_KEY_FILE, OURO_APNS_KEY_ID: settings.APNS_KEY_ID, OURO_APNS_TEAM_ID: settings.APNS_TEAM_ID })
  }
  // Only an address other than the guardian's default is written, so a server installed before keeps the same file.
  const listen = !settings.LISTEN_HOST || settings.LISTEN_HOST === GUARDIAN_DEFAULT_LISTEN_HOST ? {} : { listenHost: settings.LISTEN_HOST }
  const config = {
    home: settings.HOME, listenPort: Number(settings.PORT), ...listen, sourceDir: settings.SOURCE,
    appSourceDir: `${settings.SOURCE}/apps/mobile`, sourceBranch: 'main', machineName: settings.MACHINE, publicUrl: settings.URL, ourodEnv,
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

function settingsFromEnvironment(environment) {
  const prefix = 'OURO_CONFIG_'
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]))
}

function writeIfChanged(path, text) {
  let current = null
  try { current = readFileSync(path, 'utf8') } catch { /* no configuration yet */ }
  if (current === text) return 'unchanged'
  writeFileSync(`${path}.partial`, text)
  renameSync(`${path}.partial`, path)
  return 'written'
}

// Always run as a program, never imported: tests run it the way install-run.sh does.
const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: guardian-config.mjs <config path>\n')
  process.exit(2)
}
process.stdout.write(`${writeIfChanged(path, guardianConfigText(settingsFromEnvironment(process.env)))}\n`)
