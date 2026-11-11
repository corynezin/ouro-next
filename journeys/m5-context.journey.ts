// An agent's Context screen through the real server: its model requests rebuilt from the transcript Claude Code keeps
// (a fake `claude` writes one), each request's detail, a block's whole text, and why there is nothing for other agents.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { ContextBlockText, ContextDetail, ContextList } from '@ouro/contract'
import { JourneyRun, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let run: JourneyRun
let phone: AppClient

before(async () => {
  run = new JourneyRun()
  const fakeClaude = join(run.dir, 'claude')
  writeFileSync(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${resolve(import.meta.dirname, 'fake-claude.ts')}" "$@"\n`)
  chmodSync(fakeClaude, 0o755)
  run.addServerEnv({
    OURO_DEFAULT_MODEL: 'sonnet',
    OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_TRANSCRIPT: '1', OURO_CLI_RETRY_MS: '60000' }),
  })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

async function startAgent(name: string, model: string): Promise<string> {
  await phone.command('create_agent', { task: 'look around', name, model, folder: join(run.dir, name) })
  await waitFor(`${name}'s task to be taken`, async () => (await phone.conversation(name)).some((message) => message.deliveries[0]?.state.state === 'completed'))
  return (await phone.agent(name)).id
}

test("a Claude Code agent's requests, one request's detail, and a block's whole text", async () => {
  const id = await startAgent('inspected', 'sonnet')
  const list = await waitFor('the request in the list', async () => {
    const { status, body } = await phone.get(`/v2/agents/${id}/context`)
    assert.equal(status, 200)
    const parsed = ContextList.parse(body)
    return parsed.requests.length > 0 ? parsed : null
  })
  assert.equal(list.unavailable, null)
  assert.deepEqual(list.requests[0], { ...list.requests[0], n: 0, model: 'fake-model', messageCount: 1, inputTokens: 110, outputTokens: 7 })

  const detail = await phone.get(`/v2/agents/${id}/context/0`)
  assert.equal(detail.status, 200)
  const parsed = ContextDetail.parse(detail.body)
  assert.equal(parsed.exact, true)
  assert.equal(parsed.totalInput, 110)
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ['Bash'])
  assert.equal(parsed.response[0]!.text, 'fake claude was here')
  assert.equal(parsed.messages[0]!.role, 'user')

  const text = await phone.get(`/v2/agents/${id}/context/0/text?part=system&i=0&k=0`)
  assert.equal(text.status, 200)
  assert.equal(ContextBlockText.parse(text.body).text, 'You are a fake.')
})

test('a missing request or block is not found, and a bad part is refused', async () => {
  const id = (await phone.agent('inspected')).id
  assert.equal((await phone.get(`/v2/agents/${id}/context/99`)).status, 404)
  assert.equal((await phone.get(`/v2/agents/${id}/context/0/text?part=response&i=0&k=9`)).status, 404)
  assert.equal((await phone.get(`/v2/agents/${id}/context/0/text?part=elsewhere`)).status, 400)
})

test('an agent that is not on Claude Code says why there is nothing', async () => {
  await phone.command('create_agent', { task: 'wait', name: 'elsewhere', model: 'stand-in', folder: null })
  const id = (await phone.agent('elsewhere')).id
  const { status, body } = await phone.get(`/v2/agents/${id}/context`)
  assert.equal(status, 200)
  assert.deepEqual(ContextList.parse(body), { requests: [], unavailable: 'Only Claude Code agents keep a transcript to show.' })
  assert.equal((await phone.get(`/v2/agents/${id}/context/0`)).status, 404)
})
