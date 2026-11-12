// Taking bases (J-34, server side): an offered base is merged beside the person's live source and goes live through the
// guardian's release path, then into their branch; a conflict goes to an agent started for it (or, when none can start, to
// the owner) and nothing live changes until it is resolved; a base that doesn't build changes nothing. A local bare repository stands in for the public base repository.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import type { AgentEntity, BaseStatus, MessageEntity } from '@ouro/contract'
import { BaseRepo } from '../server/src/adapters/base-repo-fixture.ts'
import { GuardianRun } from './guardian-harness.ts'
import { standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const execFileAsync = promisify(execFile)
const run = new GuardianRun()
let phone: AppClient
const baseRepo = new BaseRepo(join(run.dir, 'bases.git'))
const treesDir = join(run.dir, 'base-trees')

const DEFAULT_PROTOCOL = 'server/protocols/default.md'
const FOLDER_LINE = 'Work in {{folder}} unless the task says otherwise.'
const PERSON_LINE = 'Work in {{folder}} unless the task says otherwise. Keep notes short.'
const BASE_2_LINE = 'Work in {{folder}} unless your task says otherwise.'
const RESOLVED_LINE = 'Work in {{folder}} unless your task says otherwise. Keep notes short.'
const BASE_4_LINE = 'Work in {{folder}} unless the task you were given says otherwise.'

/** A stand-in for `expo export`, configured the way a person's is. */
const FAKE_EXPORT = `mkdir -p {out}/b && echo bundle > {out}/b/ios.js && printf '{"version":0,"fileMetadata":{"ios":{"bundle":"b/ios.js","assets":[]}}}' > {out}/metadata.json`

const treeOf = (n: number) => join(treesDir, String(n))
const besideDirOf = (n: number) => `${run.source}.base-update-${n}`

function editTree(n: number, path: string, from: string, to: string): void {
  const file = join(treeOf(n), path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} in base ${n} doesn't contain the text to replace`)
  writeFileSync(file, text.replace(from, to))
}

/** Each base is the whole tree of the one before with its own change, as the repository holds it. */
async function makeBaseTrees(): Promise<void> {
  const archive = join(run.dir, 'base-0.tar')
  mkdirSync(treeOf(0), { recursive: true })
  await run.git('archive', '--format=tar', '-o', archive, 'ouro-base')
  await execFileAsync('tar', ['-xf', archive, '-C', treeOf(0)])

  cpSync(treeOf(0), treeOf(1), { recursive: true })
  writeFileSync(join(treeOf(1), 'server/protocols/starter.md'), `${readFileSync(join(treeOf(1), 'server/protocols/starter.md'), 'utf8')}\nBase 1 was here.\n`)
  mkdirSync(join(treeOf(1), 'apps/mobile'), { recursive: true })
  writeFileSync(join(treeOf(1), 'apps/mobile/base-1.txt'), 'the app, as of base 1\n')
  writeFileSync(join(treeOf(1), 'apps/mobile/app.json'), JSON.stringify({ expo: { name: 'Ouro Next', version: '0.1.0', runtimeVersion: { policy: 'appVersion' } } }))

  cpSync(treeOf(1), treeOf(2), { recursive: true })
  editTree(2, DEFAULT_PROTOCOL, FOLDER_LINE, BASE_2_LINE)

  cpSync(treeOf(2), treeOf(3), { recursive: true })
  editTree(3, 'server/src/app/render.ts', 'const STOP_WORDS', 'const typeError: number = "not a number"\nconst STOP_WORDS')

  // Base 4 drops base 3's broken change and rewords the line the person changed again.
  cpSync(treeOf(2), treeOf(4), { recursive: true })
  editTree(4, DEFAULT_PROTOCOL, BASE_2_LINE, BASE_4_LINE)
}

/** Releasing base `n` in the repository, which servers then offer. */
const offer = async (n: number, notes: string): Promise<void> => {
  await baseRepo.release(n, notes, treeOf(n))
}

before(async () => {
  await run.createSource()
  // The person's copy took base 0 as it was installed, then changed something of their own. The base repository's history
  // grows from that commit, as the real one's does from the commits people's copies start at.
  await run.git('branch', 'ouro-base')
  await baseRepo.create({ repo: run.source, commit: (await run.git('rev-parse', 'ouro-base')).trim() })
  run.editSource(DEFAULT_PROTOCOL, FOLDER_LINE, PERSON_LINE)
  await run.commitAll('my own wording')
  await makeBaseTrees()
  await offer(1, 'the starter protocol gains a line, and the app a file')

  run.extraOurodEnv = { OURO_BASE_REPO: baseRepo.url, OURO_APP_EXPORT_COMMAND: FAKE_EXPORT }
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
  phone = await run.pairDevice()
})
after(() => run.cleanup())

/** The base as the phone sees it; null while the server is switching releases and doesn't answer. */
async function base(): Promise<Extract<BaseStatus, { kind: 'taker' }> | null> {
  try {
    const status = (await phone.snapshot()).server.release.base
    assert.equal(status.kind, 'taker')
    return status.kind === 'taker' ? status : null
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    return null
  }
}

const head = async () => (await run.git('rev-parse', 'main')).trim()
const sourceText = (path: string) => readFileSync(join(run.source, path), 'utf8')

/** The agent a base update started for its work, once there is one. */
async function startedFor(name: string): Promise<AgentEntity | undefined> {
  return (await phone.snapshot()).agents.find((agent) => agent.name === name)
}

/** The person's chat with an agent. */
const conversationWith = async (name: string): Promise<MessageEntity[]> => await phone.conversation(name)

test('an offered base is merged beside the live source, goes live through the guardian, and then into the person\'s branch', async () => {
  const offered = await waitFor('base 1 to be offered', async () => (await base())?.offered?.n === 1 && await base())
  assert.equal(offered.integrated, 0)
  assert.deepEqual(offered.update, { state: 'idle' })
  const releaseBefore = (await run.status()).active

  const taken = await phone.command('take_base_update', { n: 1 })
  assert.deepEqual(taken.server.release.base.kind === 'taker' && taken.server.release.base.update, { state: 'updating', n: 1 })
  // Offered now, so that the server base 1 brings up finds it when it starts.
  await offer(2, 'the default protocol says "your task"')

  const done = await waitFor('base 1 to be integrated', async () => {
    const status = await base()
    return status?.integrated === 1 && status.update.state === 'idle' && status
  }, 240_000)
  const status = await run.status()
  assert.notEqual(status.active, releaseBefore)
  assert.ok(status.active!.endsWith((await head()).slice(0, 8)), 'main is the commit that went live')
  assert.match(sourceText('server/protocols/starter.md'), /Base 1 was here\./)
  assert.match(sourceText(DEFAULT_PROTOCOL), /Keep notes short\./, 'the person\'s own change is kept')
  assert.ok(!existsSync(besideDirOf(1)), 'the merge beside is cleaned up')
  assert.equal((await run.git('branch', '--list', 'ouro-update/*')).trim(), '')
  const latestUpdate = await waitFor('the app to be published', async () => ((await (await fetch(`${run.url}/v2/identity`)).json()) as { latestUpdate: { updateNumber: number } | null }).latestUpdate)
  assert.equal(latestUpdate.updateNumber, 1, 'base 1 changes the app, so the phone has it without anyone running ouro publish')
  assert.equal(await startedFor('base-1-publish'), undefined, 'no agent is started to publish it')
  assert.equal(done.offered?.n, 2, 'the next base is offered once this one is in')
})

test('a base that conflicts with the person\'s changes goes to an agent started for it, which resolves it and carries on', async () => {
  await waitFor('base 2 to be offered', async () => (await base())?.offered?.n === 2)
  const releaseBefore = (await run.status()).active
  const headBefore = await head()

  await phone.command('take_base_update', { n: 2 })
  const conflicted = await waitFor('base 2 to conflict', async () => {
    const status = await base()
    return status?.update.state === 'conflict' && status.update
  }, 60_000)
  assert.deepEqual(conflicted, { state: 'conflict', n: 2, files: [DEFAULT_PROTOCOL], resolver: 'base-2' })
  assert.equal((await run.status()).active, releaseBefore, 'nothing live changed')
  assert.equal(await head(), headBefore)
  const brief = (await waitFor('an agent started with the brief', async () => await startedFor('base-2'))).task
  assert.ok(brief.startsWith('Ouro base 2 conflicts'))
  assert.ok(brief.includes(DEFAULT_PROTOCOL) && brief.includes(besideDirOf(2)) && brief.includes('ouro base continue'))

  // What the base agent's model would do: keep the person's wording and take the base's.
  const resolved = join(run.dir, 'resolved.md')
  writeFileSync(resolved, readFileSync(join(treeOf(2), DEFAULT_PROTOCOL), 'utf8').replace(BASE_2_LINE, RESOLVED_LINE))
  await offer(3, 'a change that does not build')
  const beside = besideDirOf(2)
  const seenBefore = (await conversationWith('base-2')).length
  await phone.command('send_message', {
    to: 'base-2',
    text: standInScript({
      do: 'run',
      command: `cp ${resolved} ${join(beside, DEFAULT_PROTOCOL)} && git -C ${beside} add -A && git -C ${beside} -c user.name=base-2 -c user.email=base-2@invalid commit -q --no-edit && ouro base continue > continued.txt 2>&1; ouro reply "$(cat continued.txt)"`,
    }),
    attachmentIds: [],
    wake: 'wake',
    answersAskId: null,
  })
  const reply = await waitFor('the base agent to carry on', async () => (await conversationWith('base-2')).slice(seenBefore)
    .find((message) => message.from === 'base-2' && !message.text.startsWith('stand-in received')), 60_000)
  assert.match(reply.text, /updating to base 2/)

  await waitFor('base 2 to be integrated', async () => {
    const status = await base()
    return status?.integrated === 2 && status.update.state === 'idle'
  }, 240_000)
  assert.ok((await run.status()).active!.endsWith((await head()).slice(0, 8)))
  assert.match(sourceText(DEFAULT_PROTOCOL), /unless your task says otherwise\. Keep notes short\./)
  assert.doesNotMatch(sourceText(DEFAULT_PROTOCOL), /^(<<<<<<<|>>>>>>>)/m)
})

test('a base that fails to build changes nothing: the live release and the person\'s branch stay as they were', async () => {
  await waitFor('base 3 to be offered', async () => (await base())?.offered?.n === 3)
  const releaseBefore = (await run.status()).active
  const headBefore = await head()

  await phone.command('take_base_update', { n: 3 })
  const failed = await waitFor('base 3 to fail', async () => {
    const status = await base()
    return status?.update.state === 'failed' && status
  }, 240_000)
  assert.equal(failed.update.state === 'failed' && failed.update.n, 3)
  assert.match(failed.update.state === 'failed' ? failed.update.why : '', /type checking failed/)
  assert.equal(failed.integrated, 2)
  assert.equal(failed.offered?.n, 3, 'still offered, to take again once fixed')
  assert.equal((await run.status()).active, releaseBefore)
  assert.equal(await head(), headBefore)
  assert.doesNotMatch(sourceText('server/src/app/render.ts'), /typeError/)
})

test('a conflict no agent can start for goes to the owner, and is recorded with no resolver', async () => {
  // A running agent holds the only slot.
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: 'sleep 600' }), name: 'sleeper', model: null, folder: null })
  await waitFor('the sleeper to run', async () => (await startedFor('sleeper'))?.state.state === 'in_turn')
  await phone.command('set_limits', { agentLimit: 1, budgetUsd: null })
  await offer(4, 'the default protocol is reworded again')
  await waitFor('base 4 to be offered', async () => (await base())?.offered?.n === 4)

  await phone.command('take_base_update', { n: 4 })
  const conflicted = await waitFor('base 4 to conflict', async () => {
    const status = await base()
    return status?.update.state === 'conflict' && status.update
  }, 60_000)
  assert.deepEqual(conflicted, { state: 'conflict', n: 4, files: [DEFAULT_PROTOCOL], resolver: null })
  assert.equal(await startedFor('base-4'), undefined, 'no agent was started')
  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === snapshot.viewer.address))
  assert.ok(systemChat, 'the owner was told, from the system')
  const notice = (await phone.history(systemChat.id)).messages.find((message) => message.text.startsWith('Ouro base 4 conflicts'))
  assert.ok(notice, 'with the brief')
  assert.match(notice.text, /couldn't start an agent for this: the limit of 1 running agents is reached/)
})
