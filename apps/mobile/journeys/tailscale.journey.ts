// Tailscale in Computers against the real server, on its stand-in: connect, approve the login, and a failed remove.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { isTailscaleChanging, tailscaleConnectedFooter, tailscaleGateOf } from '../src/features/computers/model.ts'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Tailscale in Computers: connect first, approve the login, then computers can be added; a failed remove says why', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  const standIn = (name: string, text = '') => writeFile(join(run.tailscaleDir, name), text)
  const ask = async (method: 'GET' | 'POST' | 'DELETE') => {
    const answered = await session.api.tailscale(method)
    assert.ok(answered.ok, answered.ok ? '' : JSON.stringify(answered.failure))
    return answered.value
  }
  // As the screen polls while it changes.
  const settled = (label: string) => waitFor(label, async () => {
    const status = await ask('GET')
    return status.tailscale.state === 'installing' || status.tailscale.state === 'removing' ? null : status
  })
  try {
    await mkdir(run.tailscaleDir, { recursive: true })
    assert.deepEqual(tailscaleGateOf((await ask('GET')).tailscale), { kind: 'connect' })

    await ask('POST')
    const loggingIn = await settled('the login link')
    const gate = tailscaleGateOf(loggingIn.tailscale)
    assert.ok(gate?.kind === 'approve' && gate.loginUrl.startsWith('https://login.tailscale.invalid/'), JSON.stringify(gate))
    assert.ok(isTailscaleChanging(loggingIn.tailscale), 'polled while waiting for the approval')

    await standIn('approved')
    const connected = await ask('GET')
    assert.equal(tailscaleGateOf(connected.tailscale), null, 'computers can be added')
    assert.ok(connected.tailscale.state === 'connected')
    assert.equal(tailscaleConnectedFooter(connected.tailscale.ip), 'Connected as 100.64.0.7.')

    await standIn('fail-remove', 'Tailscale would not stop')
    await ask('DELETE')
    const failed = await settled('the failed remove')
    assert.deepEqual(failed.lastFailure, { action: 'remove', message: 'Tailscale would not stop' })
    assert.equal(failed.tailscale.state, 'connected')
  } finally {
    phone.activeSession?.dispose()
  }
})
