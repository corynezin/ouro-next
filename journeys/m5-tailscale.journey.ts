// Tailscale through the real server and its route, against the stand-in: connecting installs it and gives a login link,
// approving the login connects, a failed step says why and can be tried again, and removing takes it off.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { TailscaleStatus } from '@ouro/contract'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
  mkdirSync(run.tailscaleDir, { recursive: true })
})
after(() => run.cleanup())

async function tailscale(method: 'GET' | 'POST' | 'DELETE'): Promise<TailscaleStatus> {
  const { status, body } = await phone.tailscale(method)
  assert.equal(status, 200, JSON.stringify(body))
  return TailscaleStatus.parse(body)
}
const settled = (label: string) => waitFor(label, async () => {
  const status = await tailscale('GET')
  return status.tailscale.state === 'installing' || status.tailscale.state === 'removing' ? null : status
})
const standInFile = (name: string) => join(run.tailscaleDir, name)

test('not connected at first; connecting installs it and gives the login link, approving it connects', async () => {
  assert.deepEqual(await tailscale('GET'), { tailscale: { state: 'not_connected' }, lastFailure: null })
  const started = await tailscale('POST')
  assert.ok(['installing', 'logging_in'].includes(started.tailscale.state), JSON.stringify(started))
  const loggingIn = await settled('the login link')
  assert.deepEqual(loggingIn, { tailscale: { state: 'logging_in', loginUrl: 'https://login.tailscale.invalid/a/ouro-journey' }, lastFailure: null })

  writeFileSync(standInFile('approved'), '')
  assert.deepEqual(await tailscale('GET'), { tailscale: { state: 'connected', ip: '100.64.0.7' }, lastFailure: null })
})

test('removing takes it off; a failed remove says why and leaves it connected', async () => {
  writeFileSync(standInFile('fail-remove'), 'Tailscale would not stop')
  await tailscale('DELETE')
  assert.deepEqual(await settled('the failed remove'), {
    tailscale: { state: 'connected', ip: '100.64.0.7' },
    lastFailure: { action: 'remove', message: 'Tailscale would not stop' },
  })

  rmSync(standInFile('fail-remove'))
  rmSync(standInFile('approved'))
  const removing = await tailscale('DELETE')
  assert.ok(['removing', 'not_connected'].includes(removing.tailscale.state), JSON.stringify(removing))
  assert.deepEqual(await settled('the remove'), { tailscale: { state: 'not_connected' }, lastFailure: null })
})

test('a failed install says why, and connecting again starts afresh', async () => {
  writeFileSync(standInFile('fail-install'), 'could not save a restore point, so Tailscale was not installed')
  await tailscale('POST')
  assert.deepEqual(await settled('the failed install'), {
    tailscale: { state: 'not_connected' },
    lastFailure: { action: 'connect', message: 'could not save a restore point, so Tailscale was not installed' },
  })
  rmSync(standInFile('fail-install'))
  await tailscale('POST')
  assert.equal((await settled('the login link')).tailscale.state, 'logging_in')
})

test('Tailscale needs a paired device', async () => {
  const response = await fetch(`${run.url}/v2/tailscale`, { method: 'POST' })
  assert.equal(response.status, 401)
})
