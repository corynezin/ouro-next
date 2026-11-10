// Remote create through two real servers: New agent's Machine picker offers the other computer, and an agent started
// there comes into the list here.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { agentsListModel } from '../src/features/agents/model.ts'
import { machineOptions, newRemoteAgentInput } from '../src/features/newAgent/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Remote create: the Machine picker offers the other computer, and an agent started there comes into the list', async () => {
  const alpha = new JourneyRun()
  const beta = new JourneyRun()
  runs.push(alpha, beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  const alphaPhone = await pairedPhone(alpha)
  const betaPhone = await pairedPhone(beta)
  const { session } = alphaPhone
  try {
    const invite = await session.command('create_computer_invite', {})
    assert.ok(invite.ok, invite.ok ? '' : JSON.stringify(invite.failure))
    const [, , , address, code] = invite.value.command.split(' ')
    await beta.cli('computers', 'join', address!, code!)
    const machine = await waitFor('beta under Machine', () => machineOptions(session.store.computers.values()).find((option) => option.label === 'beta'))
    assert.deepEqual(machineOptions(session.store.computers.values()).map((option) => option.label), ['Cloud computer', 'beta'])

    // Start, as the sheet sends it with beta picked.
    const made = await session.command('create_remote_agent', newRemoteAgentInput(machine.computerId!, 'hello there', ' cy ', null, null))
    assert.ok(made.ok, made.ok ? '' : JSON.stringify(made.failure))
    assert.equal(made.value.remoteAgent.address, 'cy@beta')
    // Its chat screen draws once sync brings it, moments after the answer.
    await waitFor('cy in the store, for its chat', () => session.store.remoteAgents.get(made.value.remoteAgent.id), 5_000)
    const listed = agentsListModel(session.store, { connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now() })
    assert.ok(listed.awake.some((entry) => entry.kind === 'remote' && entry.row.name === 'cy'))
    await waitFor('cy on beta', () => [...betaPhone.session.store.agents.values()].some((agent) => agent.name === 'cy'))
  } finally {
    alphaPhone.phone.activeSession?.dispose()
    betaPhone.phone.activeSession?.dispose()
  }
})
