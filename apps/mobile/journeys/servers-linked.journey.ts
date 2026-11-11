// One Servers page through two real servers: adding the second links it with the first by itself, so each shows the other
// as linked; unlinking from the open one leaves the other Not linked, and Link brings it back.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { serverRows } from '../src/features/servers/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Servers: a server added links itself with the one already here; unlink and Link again', async () => {
  const alpha = new JourneyRun()
  const beta = new JourneyRun()
  runs.push(alpha, beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  const { phone } = await pairedPhone(alpha)
  try {
    const code = /code: (\S+)/.exec(await beta.cli('pair'))![1]!
    await phone.pairAndActivate(beta.url, code)
    const session = phone.activeSession!
    const rowsOnBeta = async () => serverRows(await phone.servers.list(), session.serverId, { counts: new Map(), checking: false }, session.store.computers.values())
    const alphaRow = async () => (await rowsOnBeta()).find((row) => row.url === alpha.url)
    const linked = await waitFor('alpha linked on beta, by itself', async () => {
      const link = (await alphaRow())?.link
      return link?.kind === 'linked' && link.stateText.startsWith('Online') ? link : undefined
    })
    assert.equal(linked.fullTrust, true)

    const removed = await session.command('remove_computer', { computerId: linked.computerId })
    assert.ok(removed.ok, removed.ok ? '' : JSON.stringify(removed.failure))
    await waitFor('alpha Not linked', async () => (await alphaRow())?.link?.kind === 'not_linked')

    const alphaSaved = (await phone.servers.list()).find((server) => server.url === alpha.url)!
    const betaSaved = (await phone.servers.list()).find((server) => server.id === session.serverId)!
    assert.equal(await phone.linkServers(alphaSaved, betaSaved), null)
    await waitFor('alpha linked again after Link', async () => (await alphaRow())?.link?.kind === 'linked')
  } finally {
    phone.activeSession?.dispose()
  }
})
