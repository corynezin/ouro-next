// A stand-in for the `claude` command, for journeys that check how Claude Code is launched: it records its arguments and
// the provider variables it was given, then answers each message in Claude Code's stream-json, without a model.
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const record = process.env.FAKE_CLAUDE_RECORD
const providerVariables = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
if (record) {
  const env = Object.fromEntries(providerVariables.filter((name) => name in process.env).map((name) => [name, process.env[name]]))
  appendFileSync(record, `${JSON.stringify({ args: process.argv.slice(2), env })}\n`)
}

const sessionId = randomUUID()
const say = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
say({ type: 'system', subtype: 'init', session_id: sessionId })
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { type: string; uuid?: string }
  if (message.type !== 'user') return
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'fake claude was here' }] } })
  say({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 0, user_message_uuids: message.uuid ? [message.uuid] : [] })
})
