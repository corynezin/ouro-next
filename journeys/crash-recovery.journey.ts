// Crash and recovery (brief §12): a crash after a file write and before the reply still gives one reply and one effect;
// three agents finishing in shuffled order each answer in their own chat; a launch that is accepted but never answered
// is killed and replaced without a duplicate. Real server, runners and commands, the stand-in model, a controlled clock.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity, MessageEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const LAUNCH_DEADLINE_MS = 30_000
const run = new JourneyRun()
let phone: AppClient
before(async () => {
  run.addServerEnv({ OURO_POLICY_JSON: JSON.stringify({ launchDeadlineMs: LAUNCH_DEADLINE_MS }) })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)

async function readyAgent(name: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: 'ready', name, model: null, folder: join(run.dir, name) })
  return await waitFor(`${name} to go idle`, async () => { const agent = await phone.agent(name); return agent.state.state === 'idle' && agent.queuedDeliveries === 0 && agent })
}

async function deliveryCompleted(agentName: string, message: MessageEntity): Promise<void> {
  await waitFor(`${agentName}'s delivery to complete`, async () => {
    const found = (await phone.conversation(agentName)).find((candidate) => candidate.id === message.id)
    return found?.deliveries[0]?.state.state === 'completed'
  })
}

test('a crash after a file write and before the reply: one effect, one reply', async () => {
  await readyAgent('writer')
  // Like a model that looks before it writes: on the resumed attempt the line is already there.
  const write = 'grep -qx written effect.txt 2>/dev/null || echo written >> effect.txt'
  const { message } = await send('writer', standInScript({ do: 'run', command: write }, { do: 'crash_once', name: 'after-write' }, { do: 'run', command: 'ouro reply "wrote it"' }))
  const crashed = await waitFor('the crash', async () => { const agent = await phone.agent('writer'); return agent.state.state === 'stopped' && agent })
  assert.ok(crashed.state.state === 'stopped' && crashed.state.stopped.reason === 'crash')
  assert.equal(readFileSync(join(run.dir, 'writer', 'effect.txt'), 'utf8'), 'written\n', 'the write happened before the crash')
  assert.equal((await phone.conversation('writer')).filter((candidate) => candidate.text === 'wrote it').length, 0, 'and the reply did not')
  await waitFor('the message requeued, marked as re-sent', async () => {
    const state = (await phone.conversation('writer')).find((candidate) => candidate.id === message.id)?.deliveries[0]?.state
    return state?.state === 'queued' && state.possiblySeen
  })

  run.advanceClock(6_000) // past the first crash backoff
  await waitFor('the reply', async () => (await phone.conversation('writer')).some((candidate) => candidate.text === 'wrote it'))
  await deliveryCompleted('writer', message)
  assert.equal((await phone.conversation('writer')).filter((candidate) => candidate.text === 'wrote it').length, 1)
  assert.equal(readFileSync(join(run.dir, 'writer', 'effect.txt'), 'utf8'), 'written\n')
})

test('three agents finishing in shuffled order each answer in their own chat, attributed to themselves', async () => {
  const names = ['north', 'east', 'south']
  for (const name of names) await readyAgent(name)
  for (const name of names) await send(name, standInScript({ do: 'barrier', name: `finish-${name}` }, { do: 'run', command: `ouro reply "answer for ${name}"` }))
  for (const name of names) await waitFor(`${name} at its barrier`, () => run.barrierReached(`finish-${name}`))

  const finishOrder = ['south', 'north', 'east']
  for (const name of finishOrder) {
    run.releaseBarrier(`finish-${name}`)
    await waitFor(`${name}'s answer`, async () => (await phone.conversation(name)).some((message) => message.text === `answer for ${name}`))
  }
  for (const name of names) {
    const answers = (await phone.conversation(name)).filter((message) => message.text.startsWith('answer for '))
    assert.deepEqual(answers.map((message) => [message.from, message.text]), [[name, `answer for ${name}`]], `${name}'s chat holds only its own answer`)
  }
  const seqs = await Promise.all(finishOrder.map(async (name) => (await phone.conversation(name)).find((message) => message.text === `answer for ${name}`)!.seq))
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'answers arrive in the order the agents finished')
})

test('a launch that is accepted but never answered is replaced, with one reply and no duplicate', async () => {
  const ready = await readyAgent('sleeper')
  const hung = generationOf(ready)! + 1
  await phone.command('stop_agent', { agentId: ready.id })
  await waitFor('sleeper to stop', async () => (await phone.agent('sleeper')).state.state === 'stopped')
  writeFileSync(join(run.barrierDir, 'hang-launch'), '')

  const { message } = await send('sleeper', 'wake up')
  await waitFor('the launch that hangs', async () => { const agent = await phone.agent('sleeper'); return agent.state.state === 'starting' && generationOf(agent) === hung })
  await waitFor('the hang taken', () => !existsSync(join(run.barrierDir, 'hang-launch')))
  run.advanceClock(LAUNCH_DEADLINE_MS + 1_000)
  // Killed and confirmed gone, it counts as a crash; past its backoff it launches again.
  await waitFor('the hung launch ended', async () => (await phone.agent('sleeper')).state.state === 'stopped', 30_000)
  run.advanceClock(6_000)
  await waitFor('the reply', async () => (await phone.conversation('sleeper')).some((candidate) => candidate.text === 'stand-in received: wake up'), 30_000)
  await deliveryCompleted('sleeper', message)
  assert.equal(generationOf(await phone.agent('sleeper')), hung + 1)
  assert.equal((await phone.conversation('sleeper')).filter((candidate) => candidate.text === 'stand-in received: wake up').length, 1)
  assert.equal(await run.runnerPid((await phone.agent('sleeper')).id, hung), null, 'the hung runner is gone')
})
