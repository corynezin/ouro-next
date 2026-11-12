// An agent's Context screen through the real server: its model requests rebuilt from the transcript Claude Code keeps
// (a fake `claude` writes one, in Claude Code's shape), each request's detail, a block's whole text, why there is nothing
// for other agents, and that only the owner may read it.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { ContextBlockText, ContextDetail, ContextList, ErrorResponse } from '@ouro/contract'
import { AppClient, JourneyRun, standInScript, waitFor } from './harness.ts'

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

const requestsOf = async (id: string, query = '') => {
  const { status, body } = await phone.get(`/v2/agents/${id}/context${query}`)
  assert.equal(status, 200)
  return ContextList.parse(body)
}

test("a Claude Code agent's requests, one request's detail, and a block's whole text", async () => {
  const id = await startAgent('inspected', 'sonnet')
  await phone.command('send_message', { to: 'inspected', text: 'and another thing', attachmentIds: [], wake: 'wake', answersAskId: null })
  await waitFor('the second message to be taken', async () => (await phone.conversation('inspected')).filter((message) => message.deliveries[0]?.state.state === 'completed').length === 2)
  const list = await requestsOf(id)
  assert.equal(list.unavailable, null)
  const newest = list.requests[0]!.n
  assert.ok(newest >= 1)
  // Each request keeps everything before it and adds a reply and a message.
  assert.deepEqual(list.requests.map((row) => [row.n, row.model, row.messageCount, row.inputTokens, row.outputTokens]),
    Array.from({ length: newest + 1 }, (_, index) => newest - index).map((n) => [n, 'fake-model', 2 * n + 1, 110, 7]))
  assert.deepEqual(await requestsOf(id, '?limit=1'), { requests: [list.requests[0]], hasOlder: true, unavailable: null })
  assert.deepEqual((await requestsOf(id, `?before=${newest}&limit=1`)).requests.map((row) => row.n), [newest - 1])

  const detail = await phone.get(`/v2/agents/${id}/context/${newest}`)
  assert.equal(detail.status, 200)
  const parsed = ContextDetail.parse(detail.body)
  assert.equal(parsed.exact, true)
  assert.equal(parsed.totalInput, 110)
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ['Bash'])
  assert.deepEqual(parsed.response.map((block) => block.type), ['text', 'tool_use'])
  assert.equal(parsed.response[0]!.text, 'fake claude was here')
  // Each later message went as one with the tool result before it, as Claude Code sends it: rebuilt, not lost.
  assert.deepEqual(parsed.messages.map((message) => message.kind === 'message' ? `${message.role}: ${message.blocks.map((block) => block.type).join(', ')}` : 'unresolved'),
    ['user: text', ...Array.from({ length: newest }, () => ['assistant: text, tool_use', 'user: tool_result, text']).flat()])
  assert.ok(parsed.messages.some((message) => message.kind === 'message' && message.blocks.some((block) => block.text.includes('and another thing'))))

  const text = await phone.get(`/v2/agents/${id}/context/0/text?part=system&i=0&k=0`)
  assert.equal(text.status, 200)
  assert.equal(ContextBlockText.parse(text.body).text, 'You are a fake.')
})

test('a missing request or block is not found, and a bad part is refused', async () => {
  const id = (await phone.agent('inspected')).id
  assert.equal((await phone.get(`/v2/agents/${id}/context/99`)).status, 404)
  assert.equal((await phone.get(`/v2/agents/${id}/context/0/text?part=response&i=0&k=9`)).status, 404)
  assert.equal((await phone.get(`/v2/agents/${id}/context/0/text?part=elsewhere`)).status, 400)
  assert.equal((await phone.get(`/v2/agents/${id}/context/0/text?part=message&i=-1`)).status, 400)
})

test("only the owner reads an agent's context: not an invited person, not an agent", async () => {
  const id = (await phone.agent('inspected')).id
  const { code } = await phone.command('start_pairing', { inviteePersonName: 'guest' })
  const response = await fetch(`${run.url}/v2/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'guest-phone' }) })
  const paired = await response.json() as { deviceToken: string; deviceId: string }
  const guest = new AppClient(run, paired.deviceToken, paired.deviceId)
  for (const path of [`/v2/agents/${id}/context`, `/v2/agents/${id}/context/0`, `/v2/agents/${id}/context/0/text?part=system`]) {
    const answer = await guest.get(path)
    assert.equal(answer.status, 403, path)
    assert.equal(ErrorResponse.parse(answer.body).error.code, 'forbidden')
  }

  // An agent asks with its own credential, on the local socket, as a tool would.
  const out = join(run.dir, 'agent-asked.txt')
  const ask = `require("node:http").get({ socketPath: process.env.OURO_SOCKET, path: "/v2/agents/${id}/context", headers: { authorization: "Bearer " + process.env.OURO_AGENT_CREDENTIAL } }, (r) => require("node:fs").writeFileSync(${JSON.stringify(out)}, String(r.statusCode)))`
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: `"${process.execPath}" -e '${ask}'` }), name: 'nosy', model: 'stand-in', folder: join(run.dir, 'nosy') })
  const status = await waitFor('the agent to have asked', async () => (existsSync(out) ? readFileSync(out, 'utf8') : null))
  assert.equal(status, '403')
})

test('an agent that is not on Claude Code says why there is nothing', async () => {
  await phone.command('create_agent', { task: 'wait', name: 'elsewhere', model: 'stand-in', folder: null })
  const id = (await phone.agent('elsewhere')).id
  const { status, body } = await phone.get(`/v2/agents/${id}/context`)
  assert.equal(status, 200)
  assert.deepEqual(ContextList.parse(body), { requests: [], hasOlder: false, unavailable: 'not_claude_code' })
  assert.equal((await phone.get(`/v2/agents/${id}/context/0`)).status, 404)
})
