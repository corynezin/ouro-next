// Codex as a model provider, for OpenAI models on the person's ChatGPT plan: one `codex app-server` holding one thread.
// A message arriving while no turn runs starts one (turn/start); one arriving mid-turn joins it (turn/steer), so the
// model takes it in at its next step, as Claude Code does. Messages count as taken in when Codex accepts the turn/start
// or turn/steer that carries them, and each finished turn names the attempts it took in.
import { createInterface } from 'node:readline'
import type { ProviderFailure } from '../domain/agent.ts'
import { CodexAppServer } from './codex-app-server.ts'
import type { DeliveryForModel, ProviderEvent, ProviderSession, ProviderSessionParams } from './provider.ts'
import { readsAsRefusal } from './refusal.ts'

const CODEX_NOTE = 'You run on OpenAI Codex, not Claude Code. Your shell has no run_in_background option, and nothing wakes you ' +
  'when a background job ends: run long commands in the foreground, or start them with nohup and look at their log later.'

/** The only place that decides what kind of failure a failed Codex turn is, from its `codexErrorInfo` and message. */
export function classifyCodexFailure(errorInfo: unknown, message = ''): ProviderFailure {
  if (readsAsRefusal(message)) return 'model_refused'
  if (errorInfo === 'unauthorized') return 'logged_out'
  if (errorInfo === 'usageLimitExceeded') return 'usage_limit'
  if (isRecord(errorInfo)) {
    // A signed-out Codex says so only by a 401 on its connection.
    const detail = Object.values(errorInfo)[0]
    if (isRecord(detail) && detail.httpStatusCode === 401) return 'logged_out'
  }
  return 'transient'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface CodexItem { id: string; type: string; [field: string]: unknown }

/** What the log calls an item's tool, in Claude Code's names so the log reads the same on either. Null: not a tool. */
function toolOf(item: CodexItem): { toolName: string; input: unknown } | null {
  switch (item.type) {
    case 'commandExecution': return { toolName: 'Bash', input: { command: item.command } }
    case 'fileChange': return { toolName: 'Edit', input: { file_path: Array.isArray(item.changes) ? item.changes.map((change) => (isRecord(change) ? change.path : '')).join(', ') : '' } }
    case 'mcpToolCall': return { toolName: `mcp__${String(item.server)}__${String(item.tool)}`, input: item.arguments ?? {} }
    case 'dynamicToolCall': return { toolName: String(item.tool), input: item.arguments ?? {} }
    case 'collabAgentToolCall': return { toolName: 'Agent', input: { description: item.prompt ?? item.tool } }
    case 'webSearch': return { toolName: 'WebSearch', input: { query: item.query } }
    default: return null
  }
}

const RESULT_TEXT_LIMIT = 50_000

function resultOf(item: CodexItem): { text: string; isError: boolean } {
  if (item.type === 'commandExecution') {
    return { text: String(item.aggregatedOutput ?? '').slice(0, RESULT_TEXT_LIMIT), isError: item.status !== 'completed' || (item.exitCode ?? 0) !== 0 }
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return { text: changes.map((change) => (isRecord(change) ? String(change.diff ?? change.path) : '')).join('\n').slice(0, RESULT_TEXT_LIMIT), isError: item.status !== 'completed' }
  }
  return { text: JSON.stringify(item.result ?? item.contentItems ?? item.status ?? '').slice(0, RESULT_TEXT_LIMIT), isError: item.status === 'failed' }
}

/** A turn of the thread: what it was started for, and the attempts it has taken in so far. */
interface Turn {
  purpose: 'work' | 'compaction'
  /** Known once Codex has answered turn/start, or said the turn started, whichever comes first. */
  id: string | null
  takenAttemptIds: string[]
}

export function startCodexSession(params: ProviderSessionParams, onEvent: (event: ProviderEvent) => void): ProviderSession {
  const codex = new CodexAppServer({ command: params.env.OURO_CODEX_BIN ?? 'codex', cwd: params.folder, env: params.env })
  const threadOptions = {
    model: params.model,
    cwd: params.folder,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    developerInstructions: `${params.systemPrompt}\n\n${CODEX_NOTE}`,
  }

  let threadId: string | null = null
  let threadNamed = false
  let turn: Turn | null = null
  /** Delivered and not yet sent into a turn. */
  let waiting: DeliveryForModel[] = []
  /** A turn/start or turn/steer whose answer hasn't come: the turn's end waits for it, so its attempts are counted. */
  let requestInFlight = false
  let endAfterRequest: (() => void) | null = null
  let interruptWanted = false
  let compactionWanted = false
  const stderrTail: string[] = []

  // A thread is resumable only once its first turn has started: before that, Codex has no file for it.
  const nameThread = () => {
    if (threadNamed || threadId === null) return
    threadNamed = true
    onEvent({ type: 'session_identified', providerSessionId: threadId })
  }

  const afterRequest = () => {
    requestInFlight = false
    const end = endAfterRequest
    endAfterRequest = null
    if (end) end()
    else pump()
  }

  const onTurnKnown = (current: Turn, id: string) => {
    if (current.id !== null) return
    current.id = id
    nameThread()
    if (interruptWanted) interrupt()
    pump()
  }

  const inputOf = (deliveries: DeliveryForModel[]) => [{ type: 'text', text: deliveries.map((delivery) => delivery.modelContent).join('\n\n') }]

  /** Codex accepted them into the thread: at the turn's start, or steered into the turn under way. */
  const noteTakenIn = (current: Turn, taken: DeliveryForModel[]) => {
    if (taken.length === 0) return
    const attemptIds = taken.map((delivery) => delivery.attemptId)
    current.takenAttemptIds.push(...attemptIds)
    onEvent({ type: 'taken_in', attemptIds })
  }

  const startTurn = (purpose: Turn['purpose']) => {
    const current: Turn = { purpose, id: null, takenAttemptIds: [] }
    const taken = purpose === 'work' ? waiting : []
    if (purpose === 'work') waiting = []
    turn = current
    requestInFlight = true
    const request = purpose === 'compaction'
      ? codex.request('thread/compact/start', { threadId })
      : codex.request('turn/start', { threadId, input: inputOf(taken) })
    request.then((result) => {
      noteTakenIn(current, taken)
      const id = isRecord(result) && isRecord(result.turn) && typeof result.turn.id === 'string' ? result.turn.id : null
      if (id !== null) onTurnKnown(current, id)
    }, (error: Error) => {
      // Not taken in: they wait for the next turn, and this one ends as failed.
      waiting = [...taken, ...waiting]
      endTurn(current, { kind: 'failed', failure: 'transient', detail: `codex refused the turn: ${error.message}` })
    }).finally(afterRequest)
  }

  const steer = (current: Turn, turnId: string) => {
    const taken = waiting
    waiting = []
    requestInFlight = true
    codex.request('turn/steer', { threadId, input: inputOf(taken), expectedTurnId: turnId }).then(
      () => noteTakenIn(current, taken),
      // Refused: the turn is ending. They start the next one.
      () => { waiting = [...taken, ...waiting] },
    ).finally(afterRequest)
  }

  function pump(): void {
    if (threadId === null || requestInFlight) return
    if (turn === null) {
      if (compactionWanted) {
        compactionWanted = false
        return startTurn('compaction')
      }
      if (waiting.length > 0) startTurn('work')
      return
    }
    if (turn.purpose === 'work' && turn.id !== null && waiting.length > 0) steer(turn, turn.id)
  }

  type TurnEnd = { kind: 'completed' } | { kind: 'failed'; failure: ProviderFailure; detail: string }

  function endTurn(current: Turn, end: TurnEnd): void {
    if (turn !== current) return
    if (requestInFlight) {
      endAfterRequest = () => endTurn(current, end)
      return
    }
    turn = null
    if (current.purpose === 'compaction') onEvent({ type: 'compaction_finished', contextTokens: null })
    else if (end.kind === 'failed') onEvent({ type: 'turn_failed', failure: end.failure, detail: end.detail.slice(0, 500), retryAfterMs: null })
    // The plan pays for Codex, not money per turn.
    else onEvent({ type: 'turn_result', acknowledgedAttemptIds: current.takenAttemptIds, costUsd: 0, context: null })
    pump()
  }

  function interrupt(): void {
    interruptWanted = false
    if (turn === null) return
    // Asked before Codex named the turn: it is interrupted as soon as it has a name.
    if (turn.id === null) {
      interruptWanted = true
      return
    }
    codex.request('turn/interrupt', { threadId, turnId: turn.id }).catch(() => { /* already over */ })
  }

  const onItemStarted = (item: CodexItem) => {
    if (item.type === 'reasoning') return onEvent({ type: 'thinking' })
    const tool = toolOf(item)
    // A web search names its query only once it completes.
    if (tool && item.type !== 'webSearch') onEvent({ type: 'tool_use', toolName: tool.toolName, input: JSON.stringify(tool.input) })
  }

  const onItemCompleted = (item: CodexItem) => {
    if (item.type === 'agentMessage') {
      if (typeof item.text === 'string' && item.text !== '') onEvent({ type: 'text', text: item.text })
      return
    }
    const tool = toolOf(item)
    if (!tool) return
    if (item.type === 'webSearch') onEvent({ type: 'tool_use', toolName: tool.toolName, input: JSON.stringify(tool.input) })
    onEvent({ type: 'tool_result', ...resultOf(item) })
  }

  codex.onNotify = (method, params) => {
    if (!isRecord(params)) return
    switch (method) {
      case 'turn/started': {
        const started = params.turn
        if (turn && isRecord(started) && typeof started.id === 'string') onTurnKnown(turn, started.id)
        return
      }
      case 'item/started': return isRecord(params.item) ? onItemStarted(params.item as CodexItem) : undefined
      case 'item/completed': return isRecord(params.item) ? onItemCompleted(params.item as CodexItem) : undefined
      case 'turn/completed': {
        const completed = params.turn
        if (!turn || !isRecord(completed)) return
        // An interrupted turn still took in what it took in; only a failed one is a failure.
        if (completed.status !== 'failed') return endTurn(turn, { kind: 'completed' })
        const error = isRecord(completed.error) ? completed.error : {}
        return endTurn(turn, { kind: 'failed', failure: classifyCodexFailure(error.codexErrorInfo, String(error.message ?? '')), detail: String(error.message ?? 'the turn failed') })
      }
    }
  }
  codex.onClose = (reason) => onEvent({ type: 'exited', reason: `${reason}: ${stderrTail.slice(-3).join(' ').slice(0, 500)}` })
  createInterface({ input: codex.stderr }).on('line', (line) => {
    stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })

  const openThread = async () => {
    await codex.initialize()
    const resumed = params.resumeProviderSessionId
    const result = resumed === null
      ? await codex.request('thread/start', threadOptions)
      : await codex.request('thread/resume', { threadId: resumed, ...threadOptions, excludeTurns: true })
    if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== 'string') throw new Error('codex opened no thread')
    threadId = result.thread.id
    if (resumed !== null) nameThread()
    pump()
  }
  openThread().catch((error: Error) => {
    onEvent({ type: 'notice', text: `codex could not open the conversation: ${error.message.slice(0, 300)}` })
    codex.close()
  })

  return {
    deliver(delivery: DeliveryForModel) {
      waiting.push(delivery)
      pump()
    },
    interrupt,
    compact() {
      compactionWanted = true
      pump()
    },
    stop() {
      codex.close()
    },
  }
}
