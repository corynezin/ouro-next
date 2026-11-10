// M2, server side: a good release goes live under running work, and bad ones change nothing or roll back by themselves,
// including one that passes a simple health check but hides old history.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { seedHistory } from '../tools/seed-history.ts'
import { GuardianRun } from './guardian-harness.ts'
import type { DeploymentRecord } from './guardian-harness.ts'
import { standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const execFileAsync = promisify(execFile)
const run = new GuardianRun()
let phone: AppClient
const SEEDED_MESSAGES = 400

before(async () => {
  await run.createSource()
  // Old history that a regression could hide, already there on the person's machine.
  seedHistory(run.dataDir, SEEDED_MESSAGES, Date.now() - 86_400_000)
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)

const SETTLED_STATES = ['idle', 'stopped', 'done']

/**
 * Each test starts from a quiet machine: no deploy running, and every agent settled on the live release. A test that
 * fails leaves its source edits behind, so `restoringSource` puts them back whatever happens.
 */
async function quiet(): Promise<void> {
  await waitFor('no deploy in progress', async () => !(await run.status()).deploying, 180_000)
  const { active } = await run.status()
  await waitFor('agents to settle on the live release', async () => (await phone.snapshot()).agents.every((agent) =>
    SETTLED_STATES.includes(agent.state.state) && (agent.runningRelease === null || agent.runningRelease === active || agent.state.state !== 'idle')), 60_000)
}

async function restoringSource(body: () => Promise<void>): Promise<void> {
  const start = (await run.git('rev-parse', 'HEAD')).trim()
  try {
    await body()
  } finally {
    await run.git('reset', '-q', '--hard', start)
  }
}

async function deployAndWait(reference: string): Promise<DeploymentRecord> {
  const started = await run.control('POST', '/deploy', { reference, requestedBy: null }) as DeploymentRecord
  return await run.deploymentOutcome(started.id)
}

test('a good release, deployed by an agent mid-turn, goes live; work continues and agents move between turns', async () => {
  await quiet()
  try {
    await goodRelease()
  } finally {
    run.releaseBarrier('across-deploy')
  }
})

async function goodRelease(): Promise<void> {
  const releaseBefore = (await run.status()).active
  await phone.command('create_agent', { task: 'ready', name: 'bystander', model: null, folder: null })
  await waitFor('the bystander to settle', async () => (await phone.agent('bystander')).state.state === 'idle', 30_000)

  // A bystander holds a turn open across the whole deploy.
  await phone.command('send_message', { to: 'bystander', text: standInScript({ do: 'barrier', name: 'across-deploy' }, { do: 'run', command: 'ouro reply "finished across the deploy"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the bystander to be mid-turn', () => run.barrierReached('across-deploy'), 30_000)
  const bystanderBefore = await phone.agent('bystander')
  const bystanderPids = await run.runnerPids()

  run.editSource('server/protocols/default.md', 'Work in {{folder}} unless the task says otherwise.', 'Work in {{folder}} unless the task says otherwise. (Instructions revised by the journey.)')
  const commit = await run.commitAll('revise the agent instructions')

  await phone.command('create_agent', { task: standInScript({ do: 'run', command: 'ouro deploy > deploy-output.txt 2>&1; ouro reply "$(tail -n 1 deploy-output.txt)"' }), name: 'deployer', model: null, folder: null })
  const deployReply = await waitFor('the deployer to report', async () => (await phone.conversation('deployer')).find((message) => message.from === 'deployer'), 150_000)
  assert.match(deployReply.text, /is live and confirmed healthy/)

  const status = await run.status()
  assert.notEqual(status.active, releaseBefore)
  assert.equal(status.lastGood, status.active)
  assert.ok(status.active!.endsWith(commit.slice(0, 8)))

  // The bystander's turn wasn't touched by the switch: same generation, same runner, still on the old release.
  const bystanderDuring = await phone.agent('bystander')
  assert.equal(bystanderDuring.state.state, 'in_turn')
  assert.equal(generationOf(bystanderDuring), generationOf(bystanderBefore))
  assert.equal(bystanderDuring.runningRelease, releaseBefore)
  assert.ok((await run.runnerPids()).some((pid) => bystanderPids.includes(pid)))

  run.releaseBarrier('across-deploy')
  await waitFor('the bystander to finish its turn', async () => (await phone.conversation('bystander')).some((message) => message.text === 'finished across the deploy'), 30_000)

  // Then it moves to the new release on the same conversation, and picks up the new instructions.
  const moved = await waitFor('the bystander to move', async () => {
    const agent = await phone.agent('bystander')
    return agent.runningRelease === status.active && agent.state.state === 'idle' ? agent : null
  }, 30_000)
  assert.equal(generationOf(moved), generationOf(bystanderBefore)! + 1)
  const runnerConfig = JSON.parse(readFileSync(join(run.dataDir, 'agents', moved.id, `runner-${generationOf(moved)}.json`), 'utf8')) as { systemPrompt: string; resumeProviderSessionId: string | null }
  assert.match(runnerConfig.systemPrompt, /Instructions revised by the journey/)
  assert.notEqual(runnerConfig.resumeProviderSessionId, null, 'it resumed its conversation')

  await phone.command('send_message', { to: 'bystander', text: 'after the move', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('a reply after the move', async () => (await phone.conversation('bystander')).some((message) => message.text === 'stand-in received: after the move'), 30_000)
}

test('a release that fails to build changes nothing', async () => {
  await quiet()
  await restoringSource(async () => {
  const before = await run.status()
  run.editSource('server/src/app/render.ts', 'const STOP_WORDS', 'const typeError: number = "not a number"\nconst STOP_WORDS')
  await run.commitAll('a type error')
  const outcome = await deployAndWait('main')
  assert.equal(outcome.phase, 'build_failed')
  assert.match(outcome.reason ?? '', /type checking failed/)
  assert.deepEqual((await run.status()).active, before.active)
  assert.equal((await run.status()).ourodPid, before.ourodPid, 'the live server was not restarted')
  })
})

test('a release with a broken send is rejected before going live', async () => {
  await quiet()
  await restoringSource(async () => {
  const before = await run.status()
  run.editSource('server/src/app/core.ts', "if (text.trim() === '' && attachments.length === 0) throw", "if (text.length > 0) throw")
  await run.commitAll('break sending')
  const outcome = await deployAndWait('main')
  assert.equal(outcome.phase, 'verification_failed')
  // The agent's own reply goes through the same broken path, so that's where it shows first.
  assert.match(outcome.reason ?? '', /reply to its task|send_message answered 400/)
  assert.equal((await run.status()).ourodPid, before.ourodPid, 'the live server was not restarted')

  // The person was told, in words, from the system.
  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === 'human'))
  assert.ok(systemChat)
  const notices = await phone.history(systemChat.id)
  assert.ok(notices.messages.some((message) => message.text.includes('failed its checks before going live')))
  })
})

test('a release whose manifest would crash phones is stopped, even when it weakens the contract to match', async () => {
  await quiet()
  await restoringSource(async () => {
    const before = await run.status()
    // The edit drops milliseconds and loosens the schema to allow that, so the candidate's own validation is satisfied.
    run.editSource('packages/contract/src/updates.ts', 'createdAt: update.createdAt.toISOString(),', "createdAt: update.createdAt.toISOString().replace(/\\.\\d{3}Z$/, 'Z'),")
    run.editSource('packages/contract/src/updates.ts', 'const IsoTimestampWithMilliseconds = z.string().regex(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/)', 'const IsoTimestampWithMilliseconds = z.string()')
    await run.commitAll('a manifest phones would crash on')
    const outcome = await deployAndWait('main')
    assert.equal(outcome.phase, 'verification_failed', outcome.reason ?? '')
    assert.match(outcome.reason ?? '', /would crash phones: createdAt is not an ISO time with milliseconds/)
    assert.equal((await run.status()).ourodPid, before.ourodPid, 'the live server was not restarted')
  })
})

test('a release that hides old history in a quiet chat rolls back, though newer chats fill the recent sample', async () => {
  await quiet()
  await restoringSource(async () => {
    const before = await run.status()
    // Four newer conversations, so the seeded chat is nowhere near the most recently active.
    for (const name of ['chatty-1', 'chatty-2', 'chatty-3', 'chatty-4']) {
      await phone.command('create_agent', { task: 'ready', name, model: null, folder: null })
    }
    await waitFor('the newer chats to have replies', async () => {
      const { agents } = await phone.snapshot()
      return agents.filter((agent) => agent.name.startsWith('chatty-')).every((agent) => agent.state.state === 'idle')
    }, 60_000)
    const { chats } = await phone.snapshot()
    const seeded = chats.find((chat) => chat.title === 'seeded')!
    const newer = chats.filter((chat) => chat.latestMessage !== null && chat.latestMessage.seq > seeded.latestMessage!.seq)
    assert.ok(newer.length >= 4, `expected four newer chats, saw ${newer.length}`)

    run.editSource('server/src/store/store.ts', "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'", "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? AND seq > (SELECT max(seq) - 60 FROM messages) ORDER BY seq DESC LIMIT ?'")
    await run.commitAll('a regression that only shows recent history, with the old chat quiet')
    const outcome = await deployAndWait('main')
    assert.equal(outcome.phase, 'rolled_back', outcome.reason ?? '')
    assert.match(outcome.reason ?? '', new RegExp(`chat ${seeded.id} lost \\d+ of \\d+ older messages`))
    assert.equal((await run.status()).active, before.active)
  })
})

test('a release that hides old history passes simple checks, is caught live, and rolls back by itself', async () => {
  await quiet()
  await restoringSource(async () => {
  const before = await run.status()
  const seededChat = (await phone.snapshot()).chats.find((chat) => chat.title === 'seeded')!
  const oldestPageBefore = await phone.history(seededChat.id, 100)

  run.editSource('server/src/store/store.ts', "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'", "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? AND seq > (SELECT max(seq) - 60 FROM messages) ORDER BY seq DESC LIMIT ?'")
  const badCommit = await run.commitAll('a regression that only shows recent history')

  // It does pass the simple check: identity, the agent list and the newest page all answer.
  const outcome = await deployAndWait('main')
  const phases = run.deployments().filter((record) => record.id === outcome.id).map((record) => record.phase)
  console.log(`history regression: ${phases.join(' -> ')}; ${outcome.reason}`)
  // This case is about what passes the offline check. If acceptance caught it instead, that is a different journey.
  assert.ok(phases.includes('confirming'), `expected it to pass acceptance and go live first, saw: ${phases.join(' -> ')}; ${outcome.reason}`)
  assert.equal(outcome.phase, 'rolled_back', outcome.reason ?? '')
  assert.match(outcome.reason ?? '', /lost \d+ of \d+ older messages/)

  const after = await run.status()
  assert.equal(after.active, before.active)
  assert.equal(after.lastGood, before.lastGood)
  assert.deepEqual((await phone.history(seededChat.id, 100)).messages.map((message) => message.id), oldestPageBefore.messages.map((message) => message.id))

  // The failed source is kept for repair, and the person was told why.
  assert.ok(run.deployments().some((record) => record.commit === badCommit))
  const systemChat = (await phone.snapshot()).chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === 'human'))!
  const notices = await phone.history(systemChat.id)
  assert.ok(notices.messages.some((message) => message.text.includes('turned out unhealthy, so the last good version is back') && message.text.includes('older messages')))

  // A repair ships.
  await run.git('revert', '--no-edit', 'HEAD')
  const repaired = await deployAndWait('main')
  assert.equal(repaired.phase, 'live', repaired.reason ?? '')
  })
})

test('a turn running across a release that is caught live and rolled back finishes with one reply, and nothing sent meanwhile is lost', async () => {
  await quiet()
  try {
    await restoringSource(rollbackUnderWork)
  } finally {
    run.releaseBarrier('across-rollback')
  }
})

async function rollbackUnderWork(): Promise<void> {
  const before = await run.status()
  await phone.command('create_agent', { task: 'ready', name: 'keeper', model: null, folder: null })
  await waitFor('the keeper to settle', async () => (await phone.agent('keeper')).state.state === 'idle', 30_000)
  const { message: held } = await phone.command('send_message', { to: 'keeper', text: standInScript({ do: 'barrier', name: 'across-rollback' }, { do: 'run', command: 'ouro reply "finished across the rollback"' }), attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the keeper to be mid-turn', () => run.barrierReached('across-rollback'), 30_000)
  const keeperBefore = await phone.agent('keeper')
  const runnersBefore = await run.runnerPids()

  // The same regression as above: it passes the offline check, then hides old history once live. The live check samples
  // the most recently active chats, so the person writes in the old one first.
  const seededChat = (await phone.snapshot()).chats.find((chat) => chat.title === 'seeded')!
  await phone.command('post_to_chat', { chatId: seededChat.id, text: 'back in the old chat', attachmentIds: [] })
  run.editSource('server/src/store/store.ts', "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'", "'SELECT * FROM messages WHERE chat_id = ? AND seq < ? AND seq > (SELECT max(seq) - 60 FROM messages) ORDER BY seq DESC LIMIT ?'")
  await run.commitAll('a regression that only shows recent history, deployed under work')
  const started = await run.control('POST', '/deploy', { reference: 'main', requestedBy: null }) as DeploymentRecord
  await waitFor('the bad release to go live', () => run.deployments().some((record) => record.id === started.id && record.phase === 'confirming'), 150_000)
  // Sent while the bad release is being confirmed: whichever release takes it, it must survive the rollback.
  const { message: meanwhile } = await phone.command('send_message', { to: 'keeper', text: 'sent during the bad release', attachmentIds: [], wake: 'wake', answersAskId: null })
  const outcome = await run.deploymentOutcome(started.id)
  assert.equal(outcome.phase, 'rolled_back', outcome.reason ?? '')
  assert.equal((await run.status()).active, before.active)

  // The turn wasn't touched: same generation, same runner, still mid-turn.
  const keeperDuring = await phone.agent('keeper')
  assert.equal(keeperDuring.state.state, 'in_turn')
  assert.equal(generationOf(keeperDuring), generationOf(keeperBefore))
  assert.ok((await run.runnerPids()).some((pid) => runnersBefore.includes(pid)), 'the runner carried on')

  run.releaseBarrier('across-rollback')
  await waitFor('the reply across the rollback', async () => (await phone.conversation('keeper')).some((message) => message.text === 'finished across the rollback'), 30_000)
  await waitFor('the message sent meanwhile answered', async () => (await phone.conversation('keeper')).some((message) => message.text === 'stand-in received: sent during the bad release'), 30_000)
  const conversation = await phone.conversation('keeper')
  assert.equal(conversation.filter((message) => message.text === 'finished across the rollback').length, 1)
  assert.equal(conversation.filter((message) => message.text === 'stand-in received: sent during the bad release').length, 1)
  // The reply comes before the turn's end is recorded, so completion can trail it by a moment.
  await waitFor('both deliveries completed', async () => {
    const now = await phone.conversation('keeper')
    return [held, meanwhile].every((sent) => now.find((message) => message.id === sent.id)?.deliveries[0]?.state.state === 'completed')
  }, 30_000)
  assert.equal((await phone.agent('keeper')).runningRelease, before.active, 'the agent stays on the last good release')
}

test('the watchdog restarts a server that dies, within its budget, and leaves runners alone', async () => {
  await quiet()
  if ((await run.runnerPids()).length === 0) {
    await phone.command('create_agent', { task: 'ready', name: 'watched', model: null, folder: null })
    await waitFor('a running agent', async () => (await phone.agent('watched')).state.state === 'idle', 30_000)
  }
  const before = await run.status()
  const runnersBefore = await run.runnerPids()
  assert.ok(runnersBefore.length > 0)
  process.kill(before.ourodPid!, 'SIGKILL')
  const restarted = await waitFor('a new server', async () => {
    const status = await run.status()
    return status.ourodPid !== null && status.ourodPid !== before.ourodPid ? status : null
  }, 20_000)
  assert.equal(restarted.active, before.active)
  for (const pid of runnersBefore) assert.ok((await run.runnerPids()).includes(pid), `runner ${pid} survived`)
  await waitFor('the phone to be served again', async () => (await phone.snapshot().catch(() => null)) !== null, 20_000)

  // The budget is one restart per fifteen minutes: a second death is left alone and recorded.
  const second = await run.status()
  // Only what the guardian says after this death counts: under load, its health check can refuse a restart earlier,
  // while the first replacement is still starting.
  const outputBeforeDeath = run.output.length
  process.kill(second.ourodPid!, 'SIGKILL')
  await waitFor('the refusal', () => run.output.slice(outputBeforeDeath).includes('"event":"restart_refused"'), 20_000)
  assert.equal((await run.status()).ourodPid, null)
  const { stdout } = await execFileAsync('ls', [join(run.home, 'guardian/failure-snapshots')])
  assert.ok(stdout.trim().split('\n').length >= 2)
})
