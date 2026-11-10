// Remote agents through two real servers: an agent on another computer shows in the list beside local ones, takes a
// message from here, and stops from here with full trust.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { agentsListModel } from '../src/features/agents/model.ts'
import { remoteSend } from '../src/features/remoteAgent/model.ts'
import type { RemoteAgentRowModel } from '../src/features/remoteAgent/model.ts'
import { directChatWith } from '../src/features/shared/agentFacts.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Remote agents: an agent on another computer shows in the list beside local ones, takes a message, and stops from here', async () => {
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
    const created = await betaPhone.session.command('create_agent', { task: 'hello there', name: 'bob', model: null, folder: null })
    assert.ok(created.ok, created.ok ? '' : JSON.stringify(created.failure))

    const remoteRow = (): RemoteAgentRowModel | undefined => agentsListModel(session.store, {
      connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now(),
    }).awake.flatMap((listed) => (listed.kind === 'remote' ? [listed.row] : [])).find((row) => row.name === 'bob')
    const shown = await waitFor('bob@beta in the list', () => remoteRow())
    assert.equal(shown.computerName, 'beta')
    const remote = session.store.remoteAgents.get(shown.remoteAgentId)!
    assert.equal(remote.address, 'bob@beta')

    session.outbox.send(remoteSend(remote, 'from alpha', null))
    const chat = await waitFor('the direct chat with bob@beta', () => directChatWith(session.store, remote.address))
    const close = session.openChat(chat.id)
    await waitFor('beta accepted it', () => session.store.timeline(chat.id)?.messages
      .some((message) => message.text === 'from alpha' && message.remoteDeliveries.some((delivery) => delivery.recipient === 'bob@beta' && delivery.state.state === 'accepted')))
    // bob answers into its own computer's chat with the person: replies don't come back across (server/remote-control).
    await waitFor('bob got it on beta', () => [...betaPhone.session.store.chats.values()].some((c) => c.latestMessage?.text === 'stand-in received: from alpha'))
    close()

    await waitFor('bob idle, with full trust', () => remoteRow()?.statusText === 'idle')
    const stopped = await session.command('control_remote_agent', { remoteAgentId: remote.id, action: { kind: 'stop' } })
    assert.ok(stopped.ok, stopped.ok ? '' : JSON.stringify(stopped.failure))
    await waitFor('bob stopped, through sync', () => remoteRow()?.statusText === 'stopped')
  } finally {
    alphaPhone.phone.activeSession?.dispose()
    betaPhone.phone.activeSession?.dispose()
  }
})
