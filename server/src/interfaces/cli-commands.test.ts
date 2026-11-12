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
      response.setHeader('content-type', 'application/json')
      const parsed = body === '' ? {} : JSON.parse(body) as { input?: Record<string, unknown> }
      received.push({ path: `${request.method} ${request.url ?? ''}`, input: parsed.input ?? parsed })
      if (request.url?.startsWith('/v2/machines')) {
        const machine = { id: 'm-1', label: 'PR Sprite 1', provider: 'sprite', createdAt: 1, paired: false, status: { state: 'ready', address: 'https://s.example', pairing: null } }
        if (request.url === '/v2/machines/m-1/link') response.end(JSON.stringify({ computerName: 'pr-sprite-1' }))
        else if (request.method === 'POST') response.end(JSON.stringify({ ...machine, status: { state: 'provisioning', step: 'create' } }))
        else response.end(JSON.stringify({ providers: [{ id: 'sprite', name: 'Sprite', available: true, detail: 'A Sprite.', setup: null }], machines: [machine] }))
        return
      }
      const input = parsed.input!
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
let printed = ''
const run = (args: string[]) => runCli(args, environment, () => '', (text) => { printed += text })

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
    ['POST /v2/commands/create_agent', '1h', 'the task'],
    ['POST /v2/commands/create_agent', '1h', 'another task'],
    ['POST /v2/commands/create_agent', undefined, 'a plain task'],
  ])
  await assert.rejects(run(['spawn', 'bad', '--cache', 'forever', 'x']), CliFailure)
  assert.equal(received.length, 3)
})

test('ouro servers makes a server and links it by name, for agents to work there', async () => {
  received.length = 0
  printed = ''
  await run(['servers', 'new', 'sprite', 'PR', 'Sprite', '1'])
  await run(['servers', 'link', 'PR Sprite 1'])
  assert.deepEqual(received.map(({ path, input }) => [path, input]), [
    ['POST /v2/machines', { provider: 'sprite', label: 'PR Sprite 1' }],
    ['GET /v2/machines', {}],
    ['POST /v2/machines/m-1/link', {}],
  ])
  assert.match(printed, /ouro servers link m-1/)
  assert.match(printed, /ouro spawn <name>@pr-sprite-1/)
  await assert.rejects(run(['servers', 'link', 'nothing-like-it']), CliFailure)
})
