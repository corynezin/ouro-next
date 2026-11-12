// One Servers page through two real servers. Pairing the second leaves the two Not linked: a link grants full trust both
// ways, so only the person makes it (Link), unless they just made that server from the app, which links it by itself.
// Unlinking from the open one leaves the other Not linked again.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { serverRows } from '../src/features/servers/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Servers: a server paired is Not linked until Link; unlink; a server just made here links itself', async () => {
  const alpha = new JourneyRun()
  const beta = new JourneyRun()
  runs.push(alpha, beta)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  const { phone } = await pairedPhone(alpha)
  const pairBeta = async (afterPairing: 'nothing' | 'link_with_other_servers') => {
    const code = /code: (\S+)/.exec(await beta.cli('pair'))![1]!
    await phone.pairAndActivate(beta.url, code, { afterPairing })
    return phone.activeSession!
  }
  try {
    let session = await pairBeta('nothing')
    const rowsOnBeta = async () => serverRows(await phone.servers.list(), session.serverId, { counts: new Map(), checking: false }, session.store.computers.values())
    const alphaRow = async () => (await rowsOnBeta()).find((row) => row.url === alpha.url)
    await waitFor('beta caught up', async () => session.store.viewer !== null)
    assert.equal((await alphaRow())?.link?.kind, 'not_linked', 'pairing alone links nothing')
    assert.equal(session.store.computers.size, 0)

    const alphaSaved = (await phone.servers.list()).find((server) => server.url === alpha.url)!
    const betaSaved = (await phone.servers.list()).find((server) => server.id === session.serverId)!
    assert.equal(await phone.linkServers(alphaSaved, betaSaved), null)
    const linked = await waitFor('alpha linked after Link', async () => {
      const link = (await alphaRow())?.link
      return link?.kind === 'linked' && link.stateText.startsWith('Online') ? link : undefined
    })
    assert.equal(linked.fullTrust, true)

    const removed = await session.command('remove_computer', { computerId: linked.computerId })
    assert.ok(removed.ok, removed.ok ? '' : JSON.stringify(removed.failure))
    await waitFor('alpha Not linked', async () => (await alphaRow())?.link?.kind === 'not_linked')

    // As if the person had just made beta from Servers → New server: paired, it links itself with alpha.
    await phone.removeServer(session.serverId)
    session = await pairBeta('link_with_other_servers')
    await waitFor('alpha linked on beta, by itself', async () => (await alphaRow())?.link?.kind === 'linked')
  } finally {
    phone.activeSession?.dispose()
  }
})
