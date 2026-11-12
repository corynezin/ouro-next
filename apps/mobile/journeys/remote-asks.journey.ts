// Remote asks through two real servers: an agent on another computer asks; its ask shows in Asks
// and its chat here, and a choice answers it there.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from '../../../journeys/harness.ts'
import { agentsListModel } from '../src/features/agents/model.ts'
import { asksPanel, choicesForMessage } from '../src/features/chat/model.ts'
import { remoteAsksOf, remoteSend } from '../src/features/remoteAgent/model.ts'
import { directChatWith, openCopyOf } from '../src/features/shared/agentFacts.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test("Remote asks: an agent on another computer asks; its ask shows in Asks and its chat here, snoozes from here, and a choice answers it there", async () => {
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
    const created = await betaPhone.session.command('create_agent', { task: 'hello there', name: 'asker', model: null, folder: null })
    assert.ok(created.ok, created.ok ? '' : JSON.stringify(created.failure))
    await waitFor('asker idle on beta', () => betaPhone.session.store.agents.get(created.value.agent.id)?.state.state === 'idle', 20_000)
    const remote = await waitFor('asker@beta here', () => [...session.store.remoteAgents.values()].find((found) => found.address === 'asker@beta'))

    // The person talks to it from here, so its ask comes here.
    session.outbox.send(remoteSend(remote, standInScript({ do: 'run', command: 'ouro ask human --blocked --choice Yes --choice No "Ship it?"' }), null))
    const asksRow = () => agentsListModel(session.store, { connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now() })
      .asks?.rows.find((row) => row.text === 'Ship it?')
    const row = await waitFor('the ask in Asks', () => asksRow(), 30_000)
    assert.equal(row.agentName, 'asker@beta')
    assert.deepEqual(row.asker, { kind: 'remote', remoteAgentId: remote.id })
    assert.deepEqual(row.choices, ['Yes', 'No'])

    // Snoozed from here, as the swipe sends it: the copy shows it, and so does the ask on its own computer.
    const snoozed = await session.command('snooze_ask', { askId: row.askId, snooze: { kind: 'until', at: Date.now() + 3_600_000 } })
    assert.ok(snoozed.ok, snoozed.ok ? '' : JSON.stringify(snoozed.failure))
    await waitFor('snoozed here', () => asksRow()?.snoozed === true)
    await waitFor('snoozed on beta', () => [...betaPhone.session.store.asks.values()].some((ask) => ask.text === 'Ship it?' && ask.snooze !== null), 30_000)
    const reminded = await session.command('snooze_ask', { askId: row.askId, snooze: null })
    assert.ok(reminded.ok, reminded.ok ? '' : JSON.stringify(reminded.failure))
    await waitFor('awake again here', () => asksRow()?.snoozed === false)

    // Its chat: the panel, and the choices on the message that poses it.
    const asks = remoteAsksOf(session.store, remote)
    assert.deepEqual(asksPanel(asks.map(openCopyOf), null, Date.now()).rows.map((panelRow) => panelRow.askId), [row.askId])
    const chat = directChatWith(session.store, remote.address)!
    const close = session.openChat(chat.id)
    const posing = await waitFor('the posing message', () => session.store.timeline(chat.id)?.messages.find((message) => message.text === 'Ship it?'))
    const choices = choicesForMessage(posing, session.store.remoteAsks)
    assert.deepEqual(choices, { askId: row.askId, options: ['Yes', 'No'] })

    // A tap on Yes, as the chat sends it.
    session.outbox.send(remoteSend(remote, 'Yes', choices!.askId))
    await waitFor('the copy gone here', () => !session.store.remoteAsks.has(row.askId) && asksRow() === undefined)
    await waitFor('closed on beta', () => betaPhone.session.store.asks.size === 0 && [...betaPhone.session.store.chats.values()].some((c) => c.latestMessage?.text === 'Yes'), 30_000)
    close()
  } finally {
    alphaPhone.phone.activeSession?.dispose()
    betaPhone.phone.activeSession?.dispose()
  }
})
