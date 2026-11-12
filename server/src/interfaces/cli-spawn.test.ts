import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { CliFailure, promptCacheLifetimeFlag, runCli } from './cli.ts'

const root = mkdtempSync(join(tmpdir(), 'ouro-cli-spawn-'))
const socketPath = join(root, 'local.sock')
const received: { path: string; input: Record<string, unknown> }[] = []
let server: Server

before(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const input = (JSON.parse(body) as { input: Record<string, unknown> }).input
      received.push({ path: request.url ?? '', input })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ agent: { name: input.name ?? 'made-up', folder: '/work' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
})
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

const environment = { OURO_SOCKET: socketPath, OURO_AGENT_CREDENTIAL: 'credential' }
const run = (args: string[]) => runCli(args, environment, () => '', () => {})

test("--cache takes 5m or 1h, and absent leaves the choice to the server's default", () => {
  assert.equal(promptCacheLifetimeFlag(undefined), undefined)
  assert.equal(promptCacheLifetimeFlag('5m'), '5m')
  assert.equal(promptCacheLifetimeFlag('1h'), '1h')
  assert.throws(() => promptCacheLifetimeFlag('2h'), CliFailure)
})

test('ouro spawn and ouro new pass the prompt cache lifetime on', async () => {
  received.length = 0
  await run(['spawn', 'helper', '--cache', '1h', '--model', 'opus', 'the task'])
  await run(['new', '--cache', '1h', 'another task'])
  await run(['spawn', 'plain', 'a plain task'])
  assert.deepEqual(received.map(({ path, input }) => [path, input.promptCacheLifetime, input.task]), [
    ['/v2/commands/create_agent', '1h', 'the task'],
    ['/v2/commands/create_agent', '1h', 'another task'],
    ['/v2/commands/create_agent', undefined, 'a plain task'],
  ])
  await assert.rejects(run(['spawn', 'bad', '--cache', 'forever', 'x']), CliFailure)
  assert.equal(received.length, 3)
})
