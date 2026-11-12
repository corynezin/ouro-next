// The hub, from one configuration file.
//
//   node hub/src/main.ts serve <config.json>    answer the app, and carry on making any computer left half made
//   node hub/src/main.ts invite <config.json>   print a new one-use invite code
//   node hub/src/main.ts grant-publishing <config.json> <account id>   let an account publish and withdraw bases
//
// The configuration:
//   { "dir": "<the hub's records>", "port": 8791, "host": "127.0.0.1",
//     "distribution": { "source": "<a git repository of Ouro>", "reference": "main" },   what computers are made from
//                                                                                      until the first base
//     "provisioner": { "kind": "local", "computersDir": "<short path>", "installCommand"?: "…", "publicHost"?: "…",
//                      "guardian"?: { "ourodEnv": {…}, "timing": {…} }, "firstReleaseDeadlineMs"?: 900000 } }
//   or, for Sprites made through the Sprites API with the token in SPRITES_TOKEN (never in the file):
//     "provisioner": { "kind": "sprites", "namePrefix": "ouro-next-h-", "maxSprites": 3, "defaultModel"?: "…",
//                      "apiBase"?: "https://api.sprites.dev", "hubUrl"?: "<this hub's public URL, where computers ask for bases>",
//                      "baseRepo"?: "<a public git repository of bases, asked instead of the hub>" }
//   The hub names, lists and touches only Sprites whose names start with namePrefix, and makes no more than maxSprites.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HubBases } from './bases.ts'
import { DistributionRepository } from './distribution.ts'
import { Hub, newInviteCode } from './hub.ts'
import type { HubEvent } from './hub.ts'
import { hubHttpServer } from './http.ts'
import { DEFAULT_INSTALL_COMMAND, LocalProvisioner } from './local-provisioner.ts'
import type { LocalProvisionerConfig } from './local-provisioner.ts'
import { Provisioning } from './provisioning.ts'
import type { Provisioner } from './provisioning.ts'
import { SpriteProvisioner } from './sprite-provisioner.ts'
import { namePrefixProblem, SPRITES_API_BASE, SpritesHttpApi } from '@ouro/contract/sprites'
import { HubStore } from './store.ts'

interface HubConfig {
  dir: string
  port: number
  host: string
  distribution: { source: string; reference: string }
  provisioner:
    | ({ kind: 'local' } & Omit<LocalProvisionerConfig, 'distributionSource'>)
    | { kind: 'sprites'; namePrefix: string; maxSprites: number; defaultModel: string | null; apiBase: string; hubUrl: string | null; baseRepo: string | null }
}

interface RawProvisionerConfig extends Partial<Omit<LocalProvisionerConfig, 'distributionSource'>> {
  kind: string
  namePrefix?: string
  maxSprites?: number
  defaultModel?: string
  apiBase?: string
  hubUrl?: string
  baseRepo?: string
}

function provisionerConfigOf(raw: RawProvisionerConfig): HubConfig['provisioner'] {
  if (raw.kind === 'sprites') {
    // No defaults: which Sprites are the hub's, and how many it may make, are the operator's to say.
    if (raw.namePrefix === undefined) throw new Error('the sprites provisioner needs namePrefix')
    const problem = namePrefixProblem(raw.namePrefix)
    if (problem) throw new Error(problem)
    if (raw.maxSprites === undefined) throw new Error('the sprites provisioner needs maxSprites')
    return { kind: 'sprites', namePrefix: raw.namePrefix, maxSprites: raw.maxSprites, defaultModel: raw.defaultModel ?? null, apiBase: raw.apiBase ?? SPRITES_API_BASE, hubUrl: raw.hubUrl ?? null, baseRepo: raw.baseRepo ?? null }
  }
  if (raw.kind !== 'local') throw new Error(`no provisioner of kind ${raw.kind}`)
  if (!raw.computersDir) throw new Error('the local provisioner needs computersDir')
  return {
    kind: 'local',
    computersDir: raw.computersDir,
    installCommand: raw.installCommand ?? DEFAULT_INSTALL_COMMAND,
    publicHost: raw.publicHost ?? '127.0.0.1',
    guardian: { ourodEnv: raw.guardian?.ourodEnv ?? {}, timing: raw.guardian?.timing ?? {} },
    firstReleaseDeadlineMs: raw.firstReleaseDeadlineMs ?? 15 * 60_000,
  }
}

function loadConfig(path: string): HubConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    dir: string
    port?: number
    host?: string
    distribution: { source: string; reference?: string }
    provisioner: RawProvisionerConfig
  }
  return {
    dir: raw.dir,
    port: raw.port ?? 8791,
    host: raw.host ?? '127.0.0.1',
    distribution: { source: raw.distribution.source, reference: raw.distribution.reference ?? 'main' },
    provisioner: provisionerConfigOf(raw.provisioner),
  }
}

const openStore = (config: HubConfig): HubStore => {
  mkdirSync(config.dir, { recursive: true })
  return new HubStore(join(config.dir, 'hub.db'))
}

type LogEntry = HubEvent | { event: 'listening'; url: string } | { event: 'internal_error'; detail: string }

function log(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

/** Computers are made from the hub's own repository of starting commits. */
function provisionerOf(config: HubConfig, distributionSource: string): Provisioner {
  if (config.provisioner.kind === 'local') {
    const { kind: _, ...local } = config.provisioner
    return new LocalProvisioner({ ...local, distributionSource })
  }
  const token = process.env.SPRITES_TOKEN
  if (!token) throw new Error('the sprites provisioner needs the Sprites API token in SPRITES_TOKEN')
  return new SpriteProvisioner({
    api: new SpritesHttpApi(token, config.provisioner.namePrefix, config.provisioner.apiBase),
    maxSprites: config.provisioner.maxSprites,
    distributionSource,
    defaultModel: config.provisioner.defaultModel,
    hubUrl: config.provisioner.hubUrl,
    baseRepo: config.provisioner.baseRepo,
    pollIntervalMs: 2_000,
    deadlines: { upload: 5 * 60_000, install: 15 * 60_000, service: 20 * 60_000, query: 60_000 },
  })
}

async function serve(config: HubConfig): Promise<void> {
  const repository = new DistributionRepository(join(config.dir, 'distribution.git'), config.distribution)
  const provisioner = provisionerOf(config, repository.gitDir)
  const store = openStore(config)
  const provisioning = new Provisioning(store, provisioner, log)
  const baseRepo = config.provisioner.kind === 'sprites' ? config.provisioner.baseRepo : null
  const bases = new HubBases({ store, repository, dir: join(config.dir, 'bases'), now: Date.now, ...(baseRepo === null ? {} : { baseRepo }) })
  const distributionCommit = () => baseRepo === null ? repository.startingCommit(bases.latest()) : repository.startingCommitFromBaseRepo(baseRepo)
  const serverLimit = config.provisioner.kind === 'sprites' ? config.provisioner.maxSprites : null
  const hub = new Hub({ store, provisioner, provisioning, serverLimit, distributionCommit, now: Date.now, log })
  const server = hubHttpServer({ hub, bases }, (error) => log({ event: 'internal_error', detail: error.stack ?? error.message }))
  await new Promise<void>((listening) => server.listen(config.port, config.host, listening))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  log({ event: 'listening', url: `http://${config.host}:${port}` })
  provisioning.resumeAll()
  // Steps in flight are left: each runs again on the next start.
  const stop = () => {
    server.closeAllConnections()
    server.close(() => process.exit(0))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

const [command, configPath, accountId] = process.argv.slice(2)
const usable = configPath !== undefined && (command === 'serve' || command === 'invite' || (command === 'grant-publishing' && accountId !== undefined))
if (!usable) {
  process.stderr.write('usage: node hub/src/main.ts serve|invite <config.json>, or grant-publishing <config.json> <account id>\n')
  process.exit(2)
}
const config = loadConfig(configPath)
if (command === 'grant-publishing') {
  const store = openStore(config)
  const granted = store.grantPublishing(accountId!, Date.now())
  store.close()
  if (!granted) {
    process.stderr.write(`no account ${accountId}\n`)
    process.exit(1)
  }
} else if (command === 'invite') {
  const store = openStore(config)
  const code = newInviteCode()
  store.addInvite(code, Date.now())
  store.close()
  process.stdout.write(`${code}\n`)
} else {
  await serve(config)
}
