// Invited people: their own identity on their own phone, and removal by the owner, which cuts their devices at once
// and closes their questions while what they said stays. Inviting the name again brings the same person back.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { personAddress } from '@ouro/contract'
import { AppClient, CommandFailed, JourneyRun, standInScript, waitFor } from './harness.ts'

const run = new JourneyRun()
let owner: AppClient
before(async () => {
  await run.startServer()
  owner = await run.pairDevice('owner-phone')
})
after(() => run.cleanup())

async function invite(name: string): Promise<AppClient> {
  const { code } = await owner.command('start_pairing', { inviteePersonName: name })
  const response = await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: `${name}-phone` }) })
  assert.equal(response.status, 200)
  const paired = await response.json() as { deviceToken: string; deviceId: string }
  return new AppClient(run, paired.deviceToken, paired.deviceId)
}

test('an invited person has their own identity, and only the owner invites or removes', async () => {
  const ann = await invite('ann')
  const annView = await ann.snapshot()
  assert.equal(annView.viewer.address, personAddress('ann'))
  assert.ok(annView.people.some((person) => person.name === 'ann' && !person.isOwner))
  await assert.rejects(ann.command('start_pairing', { inviteePersonName: 'bob' }), (error: CommandFailed) => error.code === 'forbidden')
  const ownerPerson = annView.people.find((person) => person.isOwner)!
  await assert.rejects(ann.command('remove_person', { personId: ownerPerson.id }), (error: CommandFailed) => error.code === 'forbidden')
  await assert.rejects(owner.command('remove_person', { personId: ownerPerson.id }), (error: CommandFailed) => error.code === 'forbidden')
})

test('removing a person cuts their devices at once and closes their questions; their words stay; a new invite brings them back', async () => {
  const cat = await invite('cat')
  const catId = (await cat.snapshot()).viewer.personId
  await cat.command('create_agent', { task: 'ready', name: 'cats-agent', model: null, folder: join(run.dir, 'cats-agent') })
  await waitFor('the agent to go idle', async () => (await cat.agent('cats-agent')).state.state === 'idle')
  await cat.command('send_message', { to: 'cats-agent', text: standInScript({ do: 'run', command: `ouro ask ${personAddress('cat')} "Which colour?"` }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const ask = await waitFor("the agent's question to cat", async () => (await owner.snapshot()).asks.find((candidate) => candidate.text === 'Which colour?'))
  const chatId = await cat.directChatWith('cats-agent')
  const epoch = (await cat.snapshot()).epoch
  const stream = cat.openChanges((await cat.snapshot()).cursor, epoch)

  await owner.command('remove_person', { personId: catId })
  await waitFor("cat's stream to be cut", () => stream.closedWith !== null, 10_000)
  const refused = await fetch(`${run.url}/v2/snapshot`, { headers: { authorization: `Bearer ${cat.token}` } })
  assert.equal(refused.status, 401, 'their device no longer connects')

  const ownerView = await owner.snapshot()
  assert.ok(!ownerView.people.some((person) => person.id === catId), 'gone from People')
  assert.ok(!ownerView.devices.some((device) => device.personId === catId), 'and so are their devices')
  assert.ok(!ownerView.asks.some((candidate) => candidate.id === ask.id), 'their question is closed')
  assert.ok((await owner.history(chatId)).messages.some((message) => message.from === personAddress('cat')), 'what they said stays')
  assert.ok(ownerView.agents.some((agent) => agent.name === 'cats-agent'), 'and so do their agents')

  // Asking a removed person is refused, as for anyone unknown.
  await owner.command('send_message', { to: 'cats-agent', text: standInScript({ do: 'run', command: `ouro ask ${personAddress('cat')} "Still there?" > out.txt 2>&1; ouro reply "ask says: $(cat out.txt)"` }), attachmentIds: [], wake: 'wake', answersAskId: null })
  const said = await waitFor('the refusal', async () => (await owner.conversation('cats-agent')).find((message) => message.text.startsWith('ask says:')))
  assert.match(said.text, /no person at human@cat/)

  const catAgain = await invite('cat')
  assert.equal((await catAgain.snapshot()).viewer.personId, catId, 'the same person, with their history')
  assert.ok((await owner.snapshot()).people.some((person) => person.id === catId))
})

test('on the computer, ouro devices lists the phones and revokes one by name, refusing a name two phones share', async () => {
  const spare = await run.pairDevice('spare-phone')
  const listed = await run.cli('devices')
  assert.match(listed, /^owner-phone {2}\S+ {2}paired \d{4}-\d\d-\d\d \d\d:\d\d {2}last seen /m)
  assert.match(listed, new RegExp(`^spare-phone .*\\(${spare.deviceId}\\)$`, 'm'))

  assert.equal(await run.cli('devices', 'revoke', 'spare-phone'), 'revoked spare-phone; its token no longer works\n')
  await assert.rejects(spare.snapshot(), 'its token no longer works')
  assert.doesNotMatch(await run.cli('devices'), /spare-phone/)
  await assert.rejects(run.cli('devices', 'revoke', 'spare-phone'), /no paired phone named "spare-phone"/)

  const twins = [await run.pairDevice('twin'), await run.pairDevice('twin')]
  await assert.rejects(run.cli('devices', 'revoke', 'twin'), /2 phones are named "twin": revoke one by its id/)
  assert.equal(await run.cli('devices', 'revoke', twins[0]!.deviceId), 'revoked twin; its token no longer works\n')
  assert.equal((await twins[1]!.snapshot()).viewer.deviceId, twins[1]!.deviceId, 'the other twin still works')
})
