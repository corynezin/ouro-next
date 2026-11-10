// Sign-up through a stand-in hub: setup walks the steps and pairs with the new server; New server does the same.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'
import { HubApi } from '../src/core/hub/hubApi.ts'
import { firstServerSetup, hostedServerSetup } from '../src/core/hub/hostedSetup.ts'
import { HostedServers } from '../src/core/hub/hostedServers.ts'
import { hostedRows } from '../src/features/servers/model.ts'
import { setupProgress, signupFailureText } from '../src/features/onboarding/model.ts'
import { startFakeHub } from '../../../tools/fake-hub.ts'
import { freePort, JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, newPhone, nodeNetwork, realClock, runs } from './support.ts'

after(cleanUp)

test('sign-up through the hub: setup walks the steps, pairs with the new server and connects; New server does the same; a used invite and a failed step say why', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const port = await freePort()
  const fakeHub = await startFakeHub({ port, invites: ['alpha', 'beta'], stepMs: 50, serverAddress: run.url, pairCommand: run.pairCodeCommand() })
  try {
    const hub = new HubApi({ network: nodeNetwork, clock: realClock }, `http://127.0.0.1:${port}`)
    const phone = newPhone()
    await phone.start()

    const signedUp = await hub.signup({ invite: 'alpha', name: 'Ada' })
    assert.ok(signedUp.ok)
    await phone.saveHostedAccount(signedUp.value)
    const seen = new Set<string>()
    const setup = firstServerSetup(phone, hub, signedUp.value, () => { seen.add(setupProgress(setup.state)?.text ?? setup.state.stage) })
    setup.start()
    await waitFor('setup to finish', () => setup.state.stage === 'done' || (setup.state.stage === 'failed' && setup.state.message), 30_000)
    assert.equal(setup.state.stage, 'done')
    assert.ok(seen.size > 2, `progress was shown on the way: ${[...seen].join(', ')}`)
    const session = phone.activeSession!
    await waitFor('the stream to go live', () => session.connection.phase === 'live')
    const [saved] = await phone.servers.list()
    assert.equal(saved?.label, "Ada's computer")
    assert.match(saved?.hostedServerId ?? '', /^srv-/)

    // A second server, made from Servers: listed there until it's paired, then set up and connected like the first.
    const made = await hub.createServer(signedUp.value.token, { label: 'Work' })
    assert.ok(made.ok)
    const hostedServers = new HostedServers(hub, realClock)
    const listed = await hostedServers.load(signedUp.value)
    assert.equal(listed.available, true)
    assert.deepEqual(hostedRows(listed.servers, await phone.servers.list()).map((row) => row.label), ['Work'])
    const second = hostedServerSetup(phone, hub, signedUp.value, made.value.id, () => {})
    second.start()
    await waitFor('the second setup to finish', () => second.state.stage === 'done' || (second.state.stage === 'failed' && second.state.message), 30_000)
    assert.equal(second.state.stage, 'done')
    const nowSaved = await phone.servers.list()
    assert.deepEqual(hostedRows((await hostedServers.load(signedUp.value)).servers, nowSaved), [])
    assert.equal(nowSaved.find((server) => server.id === phone.activeSession!.serverId)?.hostedServerId, made.value.id)
    session.dispose()

    const reused = await hub.signup({ invite: 'alpha', name: 'Someone' })
    assert.ok(!reused.ok)
    assert.equal(signupFailureText(reused.failure), 'That invite code is not valid, or was used already.')

    await fetch(`http://127.0.0.1:${port}/fake-hub/fail-next`, { method: 'POST', body: JSON.stringify({ step: 'install', why: 'The disk is full.' }) })
    const pat = await hub.signup({ invite: 'beta', name: 'Pat' })
    assert.ok(pat.ok)
    const failing = firstServerSetup(newPhone(), hub, pat.value, () => {})
    failing.start()
    await waitFor('setup to fail', () => failing.state.stage === 'failed')
    assert.deepEqual(failing.state, { stage: 'failed', message: 'The disk is full.' })
    setup.stop()
    second.stop()
    failing.stop()
    phone.activeSession?.dispose()
  } finally {
    await fakeHub.close()
  }
})
