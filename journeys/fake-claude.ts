// A stand-in for the `claude` command, for journeys that check how Claude Code is launched: it records its arguments and
// the provider variables it was given, then answers each message in Claude Code's stream-json, without a model.
// With FAKE_CLAUDE_TRANSCRIPT set it also keeps a transcript where Claude Code does, with each model request in it.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
  : value
const hashOf = (message: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(message))).digest('hex')
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = join(transcriptDir, `${sessionId}.jsonl`)
let sent = 0
const reply = { role: 'assistant', content: [{ type: 'text', text: 'fake claude was here' }] }
function keep(prompt: unknown): void {
  const message = { role: 'user', content: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt }
  const tail = sent === 0 ? [hashOf(message)] : [hashOf(reply), hashOf(message)]
  const entries = [
    { type: 'api-request-shape', shapeHash: 'fake', shape: { system: [{ type: 'text', text: 'You are a fake.' }], tools: [{ name: 'Bash', description: 'Runs a command.' }] } },
    { type: 'api-request-blob', hash: hashOf(message), message },
    { type: 'api-request', timestamp: new Date().toISOString(), shapeHash: 'fake', keep: sent, tail, params: { model: 'fake-model' } },
    { type: 'assistant', message: { ...reply, id: `msg_${sent}`, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 7 } } },
  ]
  sent += tail.length
  mkdirSync(transcriptDir, { recursive: true })
  appendFileSync(transcript, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { type: string; uuid?: string; message?: { content?: unknown } }
  if (message.type !== 'user') return
  if (process.env.FAKE_CLAUDE_TRANSCRIPT) keep(message.message?.content ?? '')
  say({ type: 'assistant', message: { content: reply.content } })
  say({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 0, user_message_uuids: message.uuid ? [message.uuid] : [] })
})
