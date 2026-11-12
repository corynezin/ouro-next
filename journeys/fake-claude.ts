// A stand-in for the `claude` command, for journeys that check how Claude Code is launched: it records its arguments and
// the provider variables it was given, then answers each message in Claude Code's stream-json, without a model.
// With FAKE_CLAUDE_TRANSCRIPT set it also keeps a transcript where Claude Code does, with each model request in it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { transcriptHashOf } from '../server/src/adapters/transcript-requests.ts'

const record = process.env.FAKE_CLAUDE_RECORD
const providerVariables = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
if (record) {
  const env = Object.fromEntries(providerVariables.filter((name) => name in process.env).map((name) => [name, process.env[name]]))
  appendFileSync(record, `${JSON.stringify({ args: process.argv.slice(2), env })}\n`)
}

// `--resume <id>` carries on that conversation, as Claude Code does, in the same transcript.
const resumed = process.argv.indexOf('--resume')
const sessionId = resumed >= 0 ? process.argv[resumed + 1]! : randomUUID()
const say = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
say({ type: 'system', subtype: 'init', session_id: sessionId })

// The transcript in the shape Claude Code writes it: one entry per block of a reply; the first message as a blob, later
// ones only as entries, a tool result and the message that came after it sent as one merged message; each request
// naming its base. The Context screen has to rebuild those merged messages from the entries.
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = join(transcriptDir, `${sessionId}.jsonl`)
const text = { type: 'text', text: 'fake claude was here' }
let sent = 0
let turn = 0
if (existsSync(transcript)) {
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    const entry = line ? JSON.parse(line) as { type: string; keep?: number; tail?: string[] } : null
    if (entry?.type !== 'api-request') continue
    turn += 1
    sent = entry.keep! + entry.tail!.length
  }
}
function keep(prompt: unknown): void {
  const said = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : Array.isArray(prompt) ? prompt : []
  const entries: object[] = [{ type: 'api-request-shape', shapeHash: 'fake', shape: { system: [{ type: 'text', text: 'You are a fake.' }], tools: [{ name: 'Bash', description: 'Runs a command.' }] } }]
  let tail: string[]
  if (turn === 0) {
    const message = { role: 'user', content: said }
    entries.push({ type: 'user', message: { role: 'user', content: prompt } }, { type: 'api-request-blob', hash: transcriptHashOf(message), message })
    tail = [transcriptHashOf(message)]
  } else {
    const call = { type: 'tool_use', id: `tool_${turn - 1}`, name: 'Bash', input: { command: 'true' } }
    const result = { type: 'tool_result', tool_use_id: call.id, content: '' }
    entries.push({ type: 'user', message: { role: 'user', content: [result] } }, { type: 'attachment' }, { type: 'user', message: { role: 'user', content: prompt } })
    tail = [transcriptHashOf({ role: 'assistant', content: [text, call] }), transcriptHashOf({ role: 'user', content: [result, ...said] })]
  }
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 7 }
  const id = `msg_${turn}`
  entries.push(
    { type: 'api-request', id: `request_${turn}`, ...(turn === 0 ? {} : { base: `request_${turn - 1}` }), timestamp: new Date().toISOString(), shapeHash: 'fake', keep: sent, tail, params: { model: 'fake-model' } },
    { type: 'assistant', message: { role: 'assistant', id, content: [text], usage } },
    { type: 'assistant', message: { role: 'assistant', id, content: [{ type: 'tool_use', id: `tool_${turn}`, name: 'Bash', input: { command: 'true' } }], usage } },
  )
  sent += tail.length
  turn += 1
  mkdirSync(transcriptDir, { recursive: true })
  appendFileSync(transcript, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { type: string; uuid?: string; message?: { content?: unknown } }
  if (message.type !== 'user') return
  if (process.env.FAKE_CLAUDE_TRANSCRIPT) keep(message.message?.content ?? '')
  say({ type: 'assistant', message: { content: [text] } })
  say({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 0, user_message_uuids: message.uuid ? [message.uuid] : [] })
})
