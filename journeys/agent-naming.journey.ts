// An agent started without a name gets a short one the model suggests from its task, kept unique; when the model gives
// none, it is named from the task's first words. The stand-in namer answers what a task's `standin-name:` line says.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun } from './harness.ts'

const run = new JourneyRun()
after(() => run.cleanup())

test('an unnamed agent is named by the model, kept unique, and named from its task when the model gives no name', async () => {
  await run.startServer()
  const phone = await run.pairDevice()
  const create = (task: string) => phone.command('create_agent', { task, name: null, model: null, folder: null })

  const first = await create('Can you watch the herons by the lake and tell me when they nest?\nstandin-name: Heron Watcher!')
  assert.equal(first.agent.name, 'heron-watcher', "the model's answer, as a name")

  const second = await create('Watch the herons again, from the other side.\nstandin-name: heron-watcher')
  assert.equal(second.agent.name, 'heron-watcher-2', 'a suggested name already taken gets a number')

  const unusable = await create('Can you count the ducks?\nstandin-name: !!')
  assert.equal(unusable.agent.name, 'can-you-count', 'an unusable answer falls back to the first words')

  const none = await create('Does this app build?')
  assert.equal(none.agent.name, 'does-this-app', 'no answer falls back to the first words')

  const named = await phone.command('create_agent', { task: 'Anything.\nstandin-name: ignored', name: 'chosen', model: null, folder: null })
  assert.equal(named.agent.name, 'chosen', 'a given name is kept')
})
