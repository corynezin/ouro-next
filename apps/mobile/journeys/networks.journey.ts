// Servers grouped by network, through real servers: the phone sets up a private network, a shared server added to the
// phone isn't linked into it by itself, the person adds it to a shared network from the phone, and the Servers page groups
// each server under its network.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { networkSections, serverRows, unpairedComputerRows } from '../src/features/servers/model.ts'
import { canPull } from '../src/features/remoteAgent/model.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Servers: networks set up and joined from the phone, a new server left for the person to place, and the page grouped by network', async () => {
  const alpha = new JourneyRun()
  const team = new JourneyRun()
  runs.push(alpha, team)
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  team.addServerEnv({ OURO_MACHINE_NAME: 'team' })
  await Promise.all([alpha.startServer(), team.startServer()])
  const { phone, session: alphaSession } = await pairedPhone(alpha)
  try {
    const made = await alphaSession.command('create_network', { name: 'private', kind: 'private', role: 'home' })
    assert.ok(made.ok, made.ok ? '' : JSON.stringify(made.failure))
    const shared = await alphaSession.command('create_network', { name: 'team', kind: 'shared', role: 'extra' })
    assert.ok(shared.ok)
    await waitFor('alpha knows its networks', () => (alphaSession.store.server?.networks ?? []).length === 2)

    // Adding team to the phone doesn't link it into alpha's private network.
    const code = /code: (\S+)/.exec(await team.cli('pair'))![1]!
    await phone.pairAndActivate(team.url, code)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const saved = await phone.servers.list()
    const alphaSaved = saved.find((server) => server.url === alpha.url)!
    const teamSaved = saved.find((server) => server.url === team.url)!
    assert.deepEqual([...phone.activeSession!.store.computers.values()].map((computer) => computer.name), [], 'not linked by itself')

    await phone.switchTo(alphaSaved)
    const session = phone.activeSession!
    await waitFor('alpha open', () => (session.store.server?.networks ?? []).length === 2)
    assert.equal(await phone.addToNetwork(teamSaved, alphaSaved, shared.value.network.id, 'home'), null)
    const teamComputer = await waitFor('team online in alpha', () => [...session.store.computers.values()].find((computer) => computer.name === 'team' && computer.status === 'online'))
    assert.equal(teamComputer.networkId, shared.value.network.id)
    assert.equal(canPull(teamComputer, session.store.server!.networks!), true)

    const servers = await phone.servers.list()
    const rows = serverRows(servers, session.serverId, { counts: new Map(), checking: false }, session.store.computers.values())
    const sections = networkSections(rows, unpairedComputerRows(session.store.computers.values(), servers), new Map([[session.serverId, { networks: session.store.server!.networks!, computers: [...session.store.computers.values()] }]]))
    assert.deepEqual(sections.map((section) => [section.title, section.rows.map((row) => row.label)]), [['private', [alphaSaved.label]], ['team', [teamSaved.label]]])
  } finally {
    phone.activeSession?.dispose()
  }
})
