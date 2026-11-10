// A stand-in for `codex app-server`, for tests of agents on Codex without a model: it speaks the JSON-RPC Ouro uses,
// records how threads were opened, and answers each turn with every message the turn took in, after FAKE_CODEX_TURN_MS
// so a message can arrive mid-turn. While the file FAKE_CODEX_UNAUTHORIZED names exists, turns fail as signed out.
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const record = process.env.FAKE_CODEX_RECORD
const turnMs = Number(process.env.FAKE_CODEX_TURN_MS ?? '300')
const unauthorizedFile = process.env.FAKE_CODEX_UNAUTHORIZED

const say = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
const answer = (id: number, result: object) => say({ id, result })
const refuse = (id: number, message: string) => say({ id, error: { code: -32600, message } })
const notify = (method: string, params: object) => say({ method, params })

interface Input { type: string; text: string }
interface Turn { id: string; heard: string[]; timer: NodeJS.Timeout }

let threadId: string | null = null
let turn: Turn | null = null
let nextTurn = 0

const finish = (current: Turn, status: 'completed' | 'interrupted') => {
  if (turn !== current) return
  turn = null
  clearTimeout(current.timer)
  if (status === 'completed' && unauthorizedFile && existsSync(unauthorizedFile)) {
    notify('turn/completed', { threadId, turn: { id: current.id, status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } } } })
    return
  }
  if (status === 'completed') {
    notify('item/started', { threadId, turnId: current.id, item: { id: `${current.id}-r`, type: 'reasoning' } })
    notify('item/started', { threadId, turnId: current.id, item: { id: `${current.id}-c`, type: 'commandExecution', command: 'true' } })
    notify('item/completed', { threadId, turnId: current.id, item: { id: `${current.id}-c`, type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0, aggregatedOutput: '' } })
    notify('item/completed', { threadId, turnId: current.id, item: { id: `${current.id}-m`, type: 'agentMessage', text: `fake codex heard: ${current.heard.join(' | ')}` } })
  }
  notify('turn/completed', { threadId, turn: { id: current.id, status } })
}

const begin = (heard: string[]): Turn => {
  const current: Turn = { id: `turn-${++nextTurn}`, heard, timer: setTimeout(() => finish(current, 'completed'), turnMs) }
  turn = current
  return current
}

const textOf = (input: Input[]) => input.map((part) => part.text).join('\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  const { id, method, params = {} } = message
  if (id === undefined) return
  if (record && (method === 'thread/start' || method === 'thread/resume')) {
    appendFileSync(record, `${JSON.stringify({ method, params, cwd: process.cwd() })}\n`)
  }
  switch (method) {
    case 'initialize': return answer(id, {})
    case 'thread/start':
      threadId = `thread-${process.pid}`
      return answer(id, { thread: { id: threadId } })
    case 'thread/resume':
      threadId = String(params.threadId)
      return answer(id, { thread: { id: threadId } })
    case 'turn/start': {
      if (turn) return refuse(id, 'a turn is running')
      const current = begin([textOf(params.input as Input[])])
      answer(id, { turn: { id: current.id, status: 'inProgress' } })
      return notify('turn/started', { threadId, turn: { id: current.id, status: 'inProgress' } })
    }
    case 'turn/steer':
      if (!turn || turn.id !== params.expectedTurnId) return refuse(id, 'no such turn running')
      turn.heard.push(textOf(params.input as Input[]))
      return answer(id, { turnId: turn.id })
    case 'turn/interrupt':
      if (turn) finish(turn, 'interrupted')
      return answer(id, {})
    case 'thread/compact/start': {
      const compaction: Turn = { id: `turn-${++nextTurn}`, heard: [], timer: setTimeout(() => {}, 0) }
      turn = compaction
      answer(id, {})
      notify('turn/started', { threadId, turn: { id: compaction.id, status: 'inProgress' } })
      notify('item/completed', { threadId, turnId: compaction.id, item: { id: `${compaction.id}-x`, type: 'contextCompaction' } })
      turn = null
      return notify('turn/completed', { threadId, turn: { id: compaction.id, status: 'completed' } })
    }
    default: return refuse(id, `${method} is not supported`)
  }
})
