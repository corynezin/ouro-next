// Asks through the real server: snoozing takes an ask out of the open ones, and Remind me now brings it back.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { agentsListModel } from '../src/features/agents/model.ts'
import { directSend } from '../src/features/chat/model.ts'
import { quickSnooze, snoozeChoices } from '../src/features/shared/agentFacts.ts'
import { JourneyRun, standInScript, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('snoozing an ask takes it out of the open asks, and Remind me now brings it back', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const created = await session.command('create_agent', { task: 'ready', name: 'dave', model: null, folder: null })
    assert.ok(created.ok)
    const agentId = created.value.agent.id
    await waitFor('dave idle', () => session.store.agents.get(agentId)?.state.state === 'idle', 20_000)
    session.outbox.send(directSend(session.store.agents.get(agentId)!, standInScript({ do: 'run', command: 'ouro ask human "Ship it?"' }), [], null))

    const asks = () => agentsListModel(session.store, { connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now() }).asks
    const row = await waitFor('the ask in the list', () => asks()?.rows.find((ask) => ask.text === 'Ship it?'), 20_000)
    assert.equal(asks()?.headerText, 'Asks (1)')

    // The row's swipe, as the screen sends it.
    const snooze = quickSnooze(row.snoozed, Date.now())
    assert.equal(snooze.title, 'Snooze 1h')
    assert.equal(await session.commandError('snooze_ask', { askId: row.askId, snooze: snooze.snooze }), null)
    await waitFor('out of the open asks', () => asks()?.headerText === 'Asks (all snoozed)')
    assert.equal(asks()?.rows[0]?.snoozed, true)
    assert.match(asks()?.rows[0]?.timeText ?? '', /^zz /)

    const remindNow = snoozeChoices(true, Date.now()).find((choice) => choice.title === 'Remind me now')!
    assert.equal(await session.commandError('snooze_ask', { askId: row.askId, snooze: remindNow.snooze }), null)
    await waitFor('back in the open asks', () => asks()?.headerText === 'Asks (1)')
    assert.equal(asks()?.rows[0]?.snoozed, false)
  } finally {
    phone.activeSession?.dispose()
  }
})
