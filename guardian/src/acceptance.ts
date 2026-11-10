// The offline check every candidate passes before it can go live: the candidate's own code, on a private data directory,
// with the stand-in model, driven from here through its real interfaces. The candidate has no say in what this asks.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { manifestProblem } from './manifest-check.ts'
import { fetchManifest } from './probe.ts'

const execFileAsync = promisify(execFile)

export class AcceptanceFailure extends Error {}

interface HttpAnswer {
  status: number
  body: unknown
}

function httpCall(socketPath: string, method: string, path: string, token: string | null, body: object | null): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body))
    const outgoing = request({ socketPath, method, path, timeout: 15_000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: response.statusCode ?? 0, body: text.length > 0 ? JSON.parse(text) as unknown : null })
        } catch {
          resolve({ status: response.statusCode ?? 0, body: text })
        }
      })
    })
    outgoing.on('timeout', () => outgoing.destroy(new Error(`${method} ${path} timed out`)))
    outgoing.on('error', reject)
    outgoing.end(payload ?? undefined)
  })
}

async function pollUntil<T>(what: string, deadlineAt: number, check: () => Promise<T | null | undefined | false>): Promise<T> {
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > deadlineAt) throw new AcceptanceFailure(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

interface MessageShape { id: string; from: string; text: string; deliveries: { state: { state: string } }[] }

/**
 * Publishing works, and what it serves can't crash a phone: an update registered through the candidate's own route must
 * come back as a manifest that passes the guardian's check, with a launch asset whose bytes match its hash.
 */
async function checkPhoneUpdates(workDir: string, localSocket: string, appSocket: string): Promise<void> {
  const target = { socketPath: appSocket, credential: '', timeoutMs: 15_000 }
  const none = await fetchManifest(target, 'acceptance-runtime')
  if (none.status !== 204 || none.protocolVersion !== '1') throw new AcceptanceFailure(`with no update, the manifest route answered ${none.status} (protocol ${none.protocolVersion}), not 204 with protocol 1`)

  const exportDir = join(workDir, 'export')
  mkdirSync(join(exportDir, 'bundles'), { recursive: true })
  const bundle = Buffer.from('globalThis.ouroAcceptance = true\n')
  writeFileSync(join(exportDir, 'bundles', 'ios.js'), bundle)
  writeFileSync(join(exportDir, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { ios: { bundle: 'bundles/ios.js', assets: [] } } }))
  const registered = await httpCall(localSocket, 'POST', '/v2/internal/updates', null, { exportDir, runtimeVersion: 'acceptance-runtime', commit: null })
  if (registered.status !== 200) throw new AcceptanceFailure(`registering a phone update answered ${registered.status}: ${JSON.stringify(registered.body).slice(0, 300)}`)

  const answer = await fetchManifest(target, 'acceptance-runtime')
  if (answer.status !== 200) throw new AcceptanceFailure(`the manifest for a published update answered ${answer.status}`)
  let manifest: { launchAsset: { url: string; hash: string } }
  try {
    manifest = JSON.parse(answer.body) as typeof manifest
  } catch {
    throw new AcceptanceFailure('the update manifest is not JSON')
  }
  const problem = manifestProblem(manifest)
  if (problem) throw new AcceptanceFailure(`the update manifest would crash phones: ${problem}`)
  const assetPath = new URL(manifest.launchAsset.url).pathname
  const served = await httpCall(appSocket, 'GET', assetPath, null, null)
  if (served.status !== 200) throw new AcceptanceFailure(`the update's bundle answered ${served.status}`)
  const expected = createHash('sha256').update(bundle).digest('base64url')
  if (manifest.launchAsset.hash !== expected) throw new AcceptanceFailure("the manifest's bundle hash doesn't match the bundle")
}

export interface AcceptanceInput {
  releaseDir: string
  workDir: string
  deadlineMs: number
  env: Record<string, string>
}

/** Resolves if the candidate behaves. Rejects with an AcceptanceFailure saying which behaviour it lacks. */
export async function runAcceptance(input: AcceptanceInput): Promise<void> {
  rmSync(input.workDir, { recursive: true, force: true })
  mkdirSync(input.workDir, { recursive: true })
  const dataDir = join(input.workDir, 'd')
  const appSocket = join(input.workDir, 'a.sock')
  const localSocket = join(dataDir, 'local.sock')
  const projectDir = join(input.workDir, 'project')
  mkdirSync(projectDir)
  const deadlineAt = Date.now() + input.deadlineMs
  const ourodEntry = join(input.releaseDir, 'server/src/bin/ourod.ts')
  const cliEntry = join(input.releaseDir, 'server/src/bin/ouro.ts')

  let output = ''
  const startOurod = () => {
    const child = spawn(process.execPath, ['--no-warnings', ourodEntry], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: input.workDir,
        OURO_DATA: dataDir,
        OURO_APP_LISTEN: `unix:${appSocket}`,
        OURO_MACHINE_NAME: 'acceptance',
        OURO_DEFAULT_MODEL: 'stand-in',
        OURO_DEFAULT_FOLDER: projectDir,
        OURO_RELEASE_ID: 'acceptance',
        OURO_TICK_MS: '100',
        // The check runs stand-in agents only: it must not depend on whether this machine is signed in to Claude, which
        // would hold every agent if it isn't.
        OURO_INTEGRATIONS_STAND_IN_DIR: join(input.workDir, 'accounts'),
        // A check beside the live server, briefly: the guardian holds the host while it deploys.
        OURO_HOST_HOLD: 'none',
        ...input.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    return child
  }

  const stopRunners = async () => {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }))
    for (const line of stdout.split('\n')) {
      if (!line.includes(join(dataDir, 'agents'))) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    }
  }

  let ourod = startOurod()
  const stopOurod = async () => {
    if (ourod.exitCode !== null) return
    const exited = new Promise((done) => ourod.once('exit', done))
    ourod.kill('SIGKILL')
    await exited
  }

  let passed = false
  try {
    const identity = await pollUntil('the server to answer', deadlineAt, async () => {
      if (ourod.exitCode !== null) throw new AcceptanceFailure(`the server exited with ${ourod.exitCode}: ${output.slice(-500)}`)
      const answer = await httpCall(appSocket, 'GET', '/v2/identity', null, null)
      return answer.status === 200 ? answer.body as { machineName: string } : null
    }).catch((error: Error) => {
      throw new AcceptanceFailure(`it didn't start: ${error.message}; ${output.slice(-500)}`)
    })
    if (identity.machineName !== 'acceptance') throw new AcceptanceFailure('it answered with the wrong identity')

    const noToken = await httpCall(appSocket, 'GET', '/v2/snapshot', null, null)
    if (noToken.status !== 401) throw new AcceptanceFailure(`it answered ${noToken.status} to an unauthenticated read, not 401`)

    const paired = await execFileAsync(process.execPath, ['--no-warnings', cliEntry, 'pair'], { env: { PATH: process.env.PATH ?? '', OURO_SOCKET: localSocket, OURO_CLI_RETRY_MS: '5000' } }).catch((error: Error) => {
      throw new AcceptanceFailure(`the command-line client couldn't start pairing: ${error.message}`)
    })
    const code = /code: (\S+)/.exec(paired.stdout)?.[1]
    if (!code) throw new AcceptanceFailure('pairing gave no code')
    const pairing = await httpCall(appSocket, 'POST', '/v2/pair', null, { code, deviceName: 'acceptance' })
    if (pairing.status !== 200) throw new AcceptanceFailure(`pairing failed with ${pairing.status}`)
    const token = (pairing.body as { deviceToken: string }).deviceToken
    const reused = await httpCall(appSocket, 'POST', '/v2/pair', null, { code, deviceName: 'again' })
    if (reused.status === 200) throw new AcceptanceFailure('a pairing code worked twice')

    await checkPhoneUpdates(input.workDir, localSocket, appSocket)

    const command = async (name: string, commandInput: object, key: string): Promise<unknown> => {
      const answer = await httpCall(appSocket, 'POST', `/v2/commands/${name}`, token, { idempotencyKey: key, input: commandInput })
      if (answer.status !== 200) throw new AcceptanceFailure(`${name} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`)
      return answer.body
    }

    const script = JSON.stringify([
      { do: 'run', command: 'echo effect > effect.txt' },
      { do: 'run', command: 'ouro reply "task done"' },
    ])
    await command('create_agent', { task: `standin:${script}`, name: 'acceptance-agent', model: null, folder: null }, 'acceptance-create')

    const snapshotAnswer = async () => (await httpCall(appSocket, 'GET', '/v2/snapshot', token, null)).body as {
      agents: { name: string; state: { state: string } }[]
      chats: { id: string; kind: string; members: { address: string }[] }[]
    }
    const chatId = await pollUntil('the agent\'s direct chat', deadlineAt, async () => {
      const snapshot = await snapshotAnswer()
      return snapshot.chats.find((chat) => chat.kind === 'direct' && chat.members.some((member) => member.address === 'acceptance-agent'))?.id
    })
    const history = async (): Promise<MessageShape[]> => {
      const answer = await httpCall(appSocket, 'GET', `/v2/chats/${chatId}/messages?limit=50`, token, null)
      if (answer.status !== 200) throw new AcceptanceFailure(`history answered ${answer.status}`)
      return (answer.body as { messages: MessageShape[] }).messages
    }

    await pollUntil('the agent to reply to its task', deadlineAt, async () => (await history()).some((message) => message.from === 'acceptance-agent' && message.text === 'task done'))
    if (!existsSync(join(projectDir, 'effect.txt'))) throw new AcceptanceFailure('the agent\'s file effect is missing')

    const followUp = `a follow-up with "quotes" and $5B\nstandin:${JSON.stringify([{ do: 'run', command: 'ouro reply "follow-up answered"' }])}`
    await command('send_message', { to: 'acceptance-agent', text: followUp, attachmentIds: [], wake: 'wake', answersAskId: null }, 'acceptance-send')
    await pollUntil('a reply to a sent message', deadlineAt, async () => (await history()).some((message) => message.text === 'follow-up answered'))
    if (!(await history()).some((message) => message.text === followUp)) throw new AcceptanceFailure('a sent message came back altered')
    await pollUntil('deliveries to complete', deadlineAt, async () => (await history()).every((message) => message.deliveries.every((delivery) => delivery.state.state === 'completed')))

    // History and pairing survive a restart.
    const messageCount = (await history()).length
    await stopOurod()
    ourod = startOurod()
    await pollUntil('the server to return after a restart', deadlineAt, async () => (await httpCall(appSocket, 'GET', '/v2/identity', null, null)).status === 200)
    const historyAfter = await history()
    if (historyAfter.length !== messageCount) throw new AcceptanceFailure(`history had ${messageCount} messages before a restart and ${historyAfter.length} after`)
    const afterRestart = `after the restart\nstandin:${JSON.stringify([{ do: 'run', command: 'ouro reply "answered after the restart"' }])}`
    await command('send_message', { to: 'acceptance-agent', text: afterRestart, attachmentIds: [], wake: 'wake', answersAskId: null }, 'acceptance-after')
    await pollUntil('a reply after the restart', deadlineAt, async () => (await history()).some((message) => message.text === 'answered after the restart'))
    passed = true
  } catch (error) {
    // The check's own data holds no one's conversations: what it ran is kept, for the next check of this release to clear.
    const said = output.trim() === '' ? 'the server printed nothing' : `the server printed: ${output.slice(-1500)}`
    throw new AcceptanceFailure(`${(error as Error).message}; ${said}; its work is kept in ${input.workDir}`)
  } finally {
    await stopOurod()
    await stopRunners()
    if (passed) rmSync(input.workDir, { recursive: true, force: true })
  }
}
