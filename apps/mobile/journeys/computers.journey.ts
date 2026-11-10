// Computers through two real servers: another computer joins with the invite command, its trust changes, it goes.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { computerRows } from '../src/features/computers/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Computers: another computer joins with the invite command, shows online through sync, changes trust, and goes when removed', async () => {
  const alpha = new JourneyRun()
  const beta = new JourneyRun()
  runs.push(alpha, beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  const { phone, session } = await pairedPhone(alpha)
  try {
    const invite = await session.command('create_computer_invite', {})
    assert.ok(invite.ok, invite.ok ? '' : JSON.stringify(invite.failure))
    const [, , , address, code] = invite.value.command.split(' ')
    await beta.cli('computers', 'join', address!, code!)

    const rows = () => computerRows(session.store.computers.values())
    const shown = await waitFor('beta online in Computers', () => rows().find((row) => row.name === 'beta' && row.stateText.startsWith('Online')))
    assert.equal(shown.trust, 'full')

    const limited = await session.command('set_computer_trust', { computerId: shown.id, trust: 'limited' })
    assert.ok(limited.ok, limited.ok ? '' : JSON.stringify(limited.failure))
    await waitFor('beta limited, through sync', () => rows().find((row) => row.id === shown.id)?.trust === 'limited')

    const removed = await session.command('remove_computer', { computerId: shown.id })
    assert.ok(removed.ok, removed.ok ? '' : JSON.stringify(removed.failure))
    await waitFor('beta gone from Computers', () => rows().length === 0)
  } finally {
    phone.activeSession?.dispose()
  }
})
