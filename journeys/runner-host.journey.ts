// The installed shape: runners start through ouro-runner-host, a separate service, so a guardian restart (which on a
// Sprite kills every process under the guardian's service) and a release switch both leave turns running.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { GuardianRun } from './guardian-harness.ts'
import type { DeploymentRecord } from './guardian-harness.ts'
import { standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new GuardianRun()
let phone: AppClient
let hostPid: number

before(async () => {
  await run.createSource()
  hostPid = await run.startRunnerHost()
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const generationOf = (agent: AgentEntity): number | null => ('generation' in agent.state ? agent.state.generation : null)
const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })

async function runnerOf(agent: AgentEntity): Promise<{ pid: number; parent: number }> {
  const parents = await run.runnerParents()
  const generation = generationOf(agent)
  const line = execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').find((text) => text.includes(`/agents/${agent.id}/runner-${generation}.json`))
  assert.ok(line, `a runner for ${agent.name} generation ${generation}`)
  const pid = Number(line.trim().split(/\s+/)[0])
  return { pid, parent: parents.get(pid)! }
}

test('a turn keeps running through a guardian service restart, and through a release switch', async () => {
  await phone.command('create_agent', { task: 'ready', name: 'steady', model: null, folder: null })
  await waitFor('the agent to settle', async () => (await phone.agent('steady')).state.state === 'idle', 30_000)
  const started = await phone.agent('steady')
  const firstRunner = await runnerOf(started)
  assert.equal(firstRunner.parent, hostPid, 'the runner host started the runner')

  // A turn held open while the guardian's whole service is killed, ourod with it.
  await send('steady', standInScript({ do: 'barrier', name: 'across-restart' }, { do: 'run', command: 'ouro reply "finished across the restart"' }))
  await waitFor('the turn to start', () => run.barrierReached('across-restart'), 30_000)
  const killed = await run.killGuardianService()
  assert.ok(!killed.includes(firstRunner.pid), "the runner wasn't under the guardian")
  assert.ok((await run.runnerPids()).includes(firstRunner.pid), 'the runner survived the restart')

  await run.start()
  await waitFor('the phone to be served again', async () => (await phone.snapshot().catch(() => null)) !== null, 30_000)
  const afterRestart = await phone.agent('steady')
  assert.equal(afterRestart.state.state, 'in_turn')
  assert.equal(generationOf(afterRestart), generationOf(started))
  run.releaseBarrier('across-restart')
  await waitFor('the reply from the turn that crossed the restart', async () => (await phone.conversation('steady')).some((message) => message.text === 'finished across the restart'), 30_000)
  assert.equal((await phone.conversation('steady')).filter((message) => message.text === 'finished across the restart').length, 1)

  // A turn held open while a new release goes live: it finishes on the old release, then moves through the host.
  await waitFor('the agent to settle again', async () => (await phone.agent('steady')).state.state === 'idle', 30_000)
  const releaseBefore = (await run.status()).active
  await send('steady', standInScript({ do: 'barrier', name: 'across-switch' }, { do: 'run', command: 'ouro reply "finished across the switch"' }))
  await waitFor('the second turn to start', () => run.barrierReached('across-switch'), 30_000)
  run.editSource('server/protocols/default.md', 'Work in {{folder}} unless the task says otherwise.', 'Work in {{folder}} unless the task says otherwise. (Revised.)')
  const commit = await run.commitAll('revise the agent instructions')
  try {
    const deployment = await run.control('POST', '/deploy', { reference: commit, requestedBy: null }) as DeploymentRecord
    const outcome = await run.deploymentOutcome(deployment.id)
    assert.equal(outcome.phase, 'live', outcome.reason ?? '')
    const { active } = await run.status()
    assert.notEqual(active, releaseBefore)

    const during = await phone.agent('steady')
    assert.equal(during.state.state, 'in_turn')
    assert.equal(during.runningRelease, releaseBefore)
    assert.ok((await run.runnerPids()).includes(firstRunner.pid), 'the runner survived the switch')
  } finally {
    run.releaseBarrier('across-switch')
  }
  await waitFor('the reply from the turn that crossed the switch', async () => (await phone.conversation('steady')).some((message) => message.text === 'finished across the switch'), 30_000)

  const { active } = await run.status()
  const moved = await waitFor('the agent to move to the new release', async () => {
    const agent = await phone.agent('steady')
    return agent.runningRelease === active && agent.state.state === 'idle' ? agent : null
  }, 30_000)
  const movedRunner = await runnerOf(moved)
  assert.equal(movedRunner.parent, hostPid, 'the new release asked the same runner host')
  assert.notEqual(movedRunner.pid, firstRunner.pid)
  assert.ok(!(await run.runnerPids()).includes(firstRunner.pid), 'the old runner is gone')
  const zombies = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=']).toString().split('\n').map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, stat]) => Number(ppid) === hostPid && stat?.startsWith('Z'))
  assert.deepEqual(zombies, [], 'the host reaped the runners that ended')

  await send('steady', 'after the move')
  await waitFor('a reply after the move', async () => (await phone.conversation('steady')).some((message) => message.text === 'stand-in received: after the move'), 30_000)
})
