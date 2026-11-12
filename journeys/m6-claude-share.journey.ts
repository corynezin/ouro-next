// Claude's sign-in across the person's computers, through two real servers: one approval at alpha makes a year-long plan
// token that signs in alpha and beta both, it can be sent again without approving, a computer that trusts alpha only to
// message takes none, and only the owner shares it.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ClaudeLoginStart, ClaudeShareResult } from '@ouro/contract'
import type { IntegrationEntity } from '@ouro/contract'
import { AppClient as Client, JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
  await waitFor('each sees the other', async () => (await alphaPhone.snapshot()).computers.some((computer) => computer.release !== null)
    && (await betaPhone.snapshot()).computers.some((computer) => computer.release !== null), 30_000)
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

const claudeOf = async (phone: AppClient): Promise<IntegrationEntity | undefined> => (await phone.snapshot()).integrations.find((integration) => integration.provider === 'claude')
const longLived = { status: 'signed_in', account: { method: 'plan', email: null, longLived: true } }
const share = async (action: string, body?: object) => ClaudeShareResult.parse((await alphaPhone.integration('POST', `claude/share/${action}`, body)).body)

test('one approval signs in this computer and the other with a year-long plan token', async () => {
  ClaudeLoginStart.parse((await alphaPhone.integration('POST', 'claude/share/start')).body)
  assert.equal((await share('finish', { code: 'wrong-code' })).accepted, false)

  ClaudeLoginStart.parse((await alphaPhone.integration('POST', 'claude/share/start')).body)
  appendFileSync(join(alpha.accountsDir, 'accepted'), 'share-code\n')
  const shared = await share('finish', { code: 'share-code' })
  assert.ok(shared.accepted)
  assert.deepEqual(shared.integration.state, longLived)
  assert.deepEqual(shared.computers, [{ name: 'beta', shared: true, why: null }])
  await waitFor("beta's sign-in", async () => (await claudeOf(betaPhone))?.state.status === 'signed_in' && JSON.stringify((await claudeOf(betaPhone))?.state) === JSON.stringify(longLived), 20_000)
})

test('the token is sent again without approving, to the computers that take it', async () => {
  const again = await share('again')
  assert.ok(again.accepted)
  assert.deepEqual(again.computers, [{ name: 'beta', shared: true, why: null }])

  const alphaIdAtBeta = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'limited' })
  try {
    const refused = await share('again')
    assert.ok(refused.accepted)
    assert.equal(refused.computers.length, 1)
    assert.equal(refused.computers[0]!.shared, false, 'beta trusts alpha only to message')
    assert.match(refused.computers[0]!.why ?? '', /trusted only to message/)
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'full' })
  }
})

test("an invited person can't share a sign-in: it would put all the owner's computers on their plan", async () => {
  const { code } = await alphaPhone.command('start_pairing', { inviteePersonName: 'guest' })
  const paired = await (await fetch(`${alpha.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'guest-phone' }) })).json() as { deviceToken: string; deviceId: string }
  const guest = new Client(alpha, paired.deviceToken, paired.deviceId)
  for (const action of ['start', 'finish', 'again']) {
    const answer = await guest.integration('POST', `claude/share/${action}`, action === 'finish' ? { code: 'share-code' } : undefined)
    assert.equal(answer.status, 403, `${action}: ${JSON.stringify(answer.body)}`)
  }
})
