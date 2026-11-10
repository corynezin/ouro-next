// The server's own lifecycle log: every line names the instance, release and uptime; agent transitions, slow requests
// and memory readings appear; message contents and searches never do.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
before(async () => {
  // Every answered request counts as slow, so the journey sees them logged.
  run.addServerEnv({ OURO_SLOW_REQUEST_MS: '0' })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

const SECRET_WORDS = 'contents-that-must-not-be-logged'

test("an agent's transitions, slow requests and memory are logged, without what was said or searched", async () => {
  await phone.command('create_agent', { task: `say hello ${SECRET_WORDS}`, name: 'logged', model: null, folder: null })
  await phone.command('send_message', { to: 'logged', text: `hello ${SECRET_WORDS}`, attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the reply', async () => (await phone.conversation('logged')).some((message) => message.text.startsWith('stand-in received')))
  await phone.search(SECRET_WORDS)
  // The server prints the line as it answers, so it can reach the journey just after the answer does.
  await waitFor('the search in the log', () => run.serverEvents().some((line) => line.event === 'request_slow' && line.path === '/v2/search'))

  const events = run.serverEvents()
  for (const line of events) {
    assert.equal(typeof line.pid, 'number', JSON.stringify(line))
    assert.equal(typeof line.release, 'string', JSON.stringify(line))
    assert.equal(typeof line.uptimeMs, 'number', JSON.stringify(line))
  }
  const transitions = events.filter((line) => line.event === 'agent_transition' && line.agentName === 'logged')
  assert.ok(transitions.some((line) => line.from === 'starting' && line.to === 'idle'), JSON.stringify(transitions))
  assert.ok(transitions.some((line) => line.to === 'in_turn'), JSON.stringify(transitions))

  const slow = events.filter((line) => line.event === 'request_slow')
  assert.ok(slow.some((line) => line.method === 'POST' && line.path === '/v2/commands/send_message' && line.status === 200 && typeof line.elapsedMs === 'number'))
  assert.ok(slow.some((line) => line.path === '/v2/search'), 'the search is logged by its path')
  assert.ok(!slow.some((line) => line.path === '/v2/changes'), 'change streams stay open by design')

  const memory = events.find((line) => line.event === 'memory')
  assert.ok(memory && typeof memory.rssBytes === 'number' && typeof memory.heapUsedBytes === 'number')

  assert.ok(!JSON.stringify(events).includes(SECRET_WORDS), 'no message, task or search reaches the log')
})
