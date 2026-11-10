// ouro-runner-host: a stable service whose only job is to start runners when ourod asks. On a Sprite, restarting a
// service kills every process under it, detached or not, so runners must not live under the guardian's service, or a
// guardian restart would end every agent's work. Like the guardian, it uses only the Node standard library and is never
// replaced by a release.
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, openSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute } from 'node:path'

export interface SpawnRequest {
  /** The release's runner entry point. */
  entry: string
  configPath: string
  logPath: string
  env: Record<string, string>
}

export class SpawnRefused extends Error {}

/** Only runners: node, a runner entry inside the releases or source this host serves, and its config. */
export function validateSpawnRequest(body: unknown, allowedRoots: readonly string[]): SpawnRequest {
  const request = body as Partial<SpawnRequest>
  for (const field of ['entry', 'configPath', 'logPath'] as const) {
    if (typeof request[field] !== 'string' || !isAbsolute(request[field]!)) throw new SpawnRefused(`${field} must be an absolute path`)
  }
  if (!request.entry!.endsWith('/server/src/bin/ouro-runner.ts')) throw new SpawnRefused('only runners are started here')
  if (!allowedRoots.some((root) => request.entry!.startsWith(`${root}/`))) throw new SpawnRefused('that runner is outside the releases this host serves')
  if (request.entry!.includes('/../')) throw new SpawnRefused('paths must be plain')
  if (typeof request.env !== 'object' || request.env === null) throw new SpawnRefused('env is required')
  return request as SpawnRequest
}

export function startRunnerHost(socketPath: string, allowedRoots: readonly string[]): void {
  if (existsSync(socketPath)) rmSync(socketPath)
  const server = createServer((incoming, outgoing) => {
    const reply = (status: number, body: object) => {
      outgoing.writeHead(status, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify(body))
    }
    if (incoming.method !== 'POST' || incoming.url !== '/spawn') return reply(404, { error: 'no such endpoint' })
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      let request: SpawnRequest
      try {
        request = validateSpawnRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), allowedRoots)
      } catch (error) {
        return reply(400, { error: (error as Error).message })
      }
      const logFd = openSync(request.logPath, 'a')
      try {
        // Its own process group, so ourod can kill a runner and everything under it without touching the rest.
        const child = spawn(process.execPath, ['--no-warnings', request.entry, request.configPath], { detached: true, stdio: ['ignore', logFd, logFd], env: request.env })
        child.on('error', () => {})
        child.unref()
        reply(200, { pid: child.pid ?? null })
      } finally {
        closeSync(logFd)
      }
    })
  })
  server.listen(socketPath, () => chmodSync(socketPath, 0o600))
  console.log(JSON.stringify({ event: 'runner_host_listening', socketPath, at: Date.now() }))
}

// `node runner-host.ts <socket> <allowed-root>...`
if (process.argv[1]?.endsWith('runner-host.ts') && process.argv[2]) {
  startRunnerHost(process.argv[2], process.argv.slice(3))
}
