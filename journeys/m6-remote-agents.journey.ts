// Agents on another of the person's computers, shown beside this one's: their state, task and latest line, kept up to
// date within seconds; only names and running or waiting where that computer trusts this one only limitedly; offline with
// their computer; and gone once archived there, or once the computer is removed.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { RemoteAgentEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const copyAtAlpha = async (address: string): Promise<RemoteAgentEntity | undefined> => (await alphaPhone.snapshot()).remoteAgents.find((agent) => agent.address === address)
const betaIdAtAlpha = async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')!.id
const alphaIdAtBeta = async () => (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id

async function betaAgent(name: string): Promise<string> {
  await betaPhone.command('create_agent', { task: standInScript({ do: 'text', text: `${name} working` }), name, model: 'stand-in', folder: null })
  await waitFor(`${name} idle`, async () => (await betaPhone.agent(name)).state.state === 'idle', 30_000)
  return (await betaPhone.agent(name)).id
}

test("each computer shows the other's agents with their state and task, kept up to date", async () => {
  const workerId = await betaAgent('worker')
  const copy = await waitFor('worker@beta at alpha', async () => {
    const found = await copyAtAlpha('worker@beta')
    return found?.details?.state.state === 'idle' ? found : null
  })
  assert.equal(copy.name, 'worker')
  assert.equal(copy.activity, 'waiting')
  assert.match(copy.details!.task, /worker working/)
  assert.equal(copy.details!.model, 'stand-in')
  assert.match(await alpha.cli('list'), /^worker@beta {2}running: idle {2}standin:/m)

  await betaPhone.command('stop_agent', { agentId: workerId })
  await waitFor("the stop seen at alpha", async () => (await copyAtAlpha('worker@beta'))?.details?.state.state === 'stopped')

  await betaPhone.command('archive_agent', { agentId: workerId })
  await waitFor('the archived agent gone from alpha', async () => (await copyAtAlpha('worker@beta')) === undefined)
})

test('where that computer trusts this one only limitedly, only names and running or waiting show', async () => {
  await betaAgent('quiet')
  await waitFor('quiet@beta with details', async () => (await copyAtAlpha('quiet@beta'))?.details !== null && (await copyAtAlpha('quiet@beta')) !== undefined)
  await betaPhone.command('set_computer_trust', { computerId: await alphaIdAtBeta(), trust: 'limited' })
  try {
    const limited = await waitFor('details withheld', async () => {
      const found = await copyAtAlpha('quiet@beta')
      return found && found.details === null ? found : null
    })
    assert.equal(limited.activity, 'waiting')
    assert.match(await alpha.cli('list'), /^quiet@beta {2}waiting$/m)
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: await alphaIdAtBeta(), trust: 'full' })
  }
})

test("a computer that stops answering shows its agents as offline; removing it removes them", async () => {
  await betaAgent('steady')
  await waitFor('steady@beta at alpha', async () => (await copyAtAlpha('steady@beta'))?.details !== undefined)
  await beta.killServer()
  alpha.advanceClock(60_000)
  try {
    await waitFor('beta offline', async () => (await alphaPhone.snapshot()).computers.find((computer) => computer.name === 'beta')?.status === 'offline')
    assert.match(await alpha.cli('list'), /^steady@beta {2}offline/m)
    assert.ok(await copyAtAlpha('steady@beta'), 'the last known copy stays while its computer is away')
  } finally {
    alpha.advanceClock(-60_000)
  }
  await alphaPhone.command('remove_computer', { computerId: await betaIdAtAlpha() })
  assert.deepEqual((await alphaPhone.snapshot()).remoteAgents, [])
})
