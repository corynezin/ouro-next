// People through the real server: an invited person shows in the owner's People, and removing them unpairs their phone.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { peopleRows } from '../src/features/settings/model.ts'
import { cleanUp, newPhone, pairedPhone, runs } from './support.ts'

after(cleanUp)

test("an invited person shows in the owner's People with their phone; removing them unpairs that phone and the row goes", async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  const guestPhone = newPhone()
  try {
    const invited = await session.command('start_pairing', { inviteePersonName: 'ann' })
    assert.ok(invited.ok, invited.ok ? '' : JSON.stringify(invited.failure))
    await guestPhone.start()
    await guestPhone.pairAndActivate(run.url, invited.value.code)
    const guest = guestPhone.activeSession!
    await waitFor("ann's stream to go live", () => guest.connection.phase === 'live')

    const people = () => peopleRows(session.store.people.values(), session.store.devices.values())
    const ann = await waitFor('ann in People with her phone', () => people().find((row) => row.name === 'ann' && row.devicesText === '1 device'))
    assert.equal(ann.address, 'human@ann')
    assert.equal(people().length, 1, 'the owner is not listed')

    const removed = await session.command('remove_person', { personId: ann.personId })
    assert.ok(removed.ok, removed.ok ? '' : JSON.stringify(removed.failure))
    await waitFor('ann gone from People', () => people().length === 0)
    await waitFor("ann's phone unpaired", () => guest.connection.phase === 'unpaired')
  } finally {
    guestPhone.activeSession?.dispose()
    phone.activeSession?.dispose()
  }
})
