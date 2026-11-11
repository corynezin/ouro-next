// Where one data directory keeps its files. Socket paths have a low length limit, so agent ids stay short.
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface DataPaths {
  dataDir: string
  database: string
  localSocket: string
  attachments: string
  agentDir(agentId: string): string
  journal(agentId: string): string
  runnerConfig(agentId: string, generation: number): string
  /** Short on purpose: socket paths are limited to about 100 bytes, and a data directory's path can be long. */
  runnerSocketDir: string
  runnerSocket(agentId: string, generation: number): string
  runnerLog(agentId: string): string
  /** Keys the person gave the server, mode 600. Runners read them at launch; they never go into a runner's config. */
  anthropicApiKey: string
  openrouterApiKey: string
  /** This machine's Ed25519 key, mode 600: peers know it by its public half. */
  machineKey: string
  /** The network keys this server holds, by network id; mode 600, as the machine key. */
  networkKeys: string
}

export function runnerSocketDirOf(dataDir: string): string {
  return join(tmpdir(), `ouro-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`)
}

export function dataPaths(dataDir: string): DataPaths {
  const runnerSocketDir = runnerSocketDirOf(dataDir)
  return {
    dataDir,
    database: join(dataDir, 'ouro.db'),
    localSocket: join(dataDir, 'local.sock'),
    attachments: join(dataDir, 'attachments'),
    agentDir: (agentId) => join(dataDir, 'agents', agentId),
    journal: (agentId) => join(dataDir, 'agents', agentId, 'journal.jsonl'),
    runnerConfig: (agentId, generation) => join(dataDir, 'agents', agentId, `runner-${generation}.json`),
    runnerSocketDir,
    runnerSocket: (agentId, generation) => join(runnerSocketDir, `${agentId}-${generation}.sock`),
    runnerLog: (agentId) => join(dataDir, 'agents', agentId, 'runner.log'),
    anthropicApiKey: join(dataDir, 'secrets', 'anthropic-api-key'),
    machineKey: join(dataDir, 'identity', 'machine-key.pem'),
    networkKeys: join(dataDir, 'identity', 'network-keys.json'),
    openrouterApiKey: join(dataDir, 'secrets', 'openrouter-api-key'),
  }
}
