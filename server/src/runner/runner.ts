// ouro-runner: hosts one agent's model process for one generation. It has no dependency on `ourod` being up. It writes
// everything to the journal, and `ourod` catches up whenever it can.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { startClaudeSession } from '../adapters/claude-provider.ts'
import { startCodexSession } from '../adapters/codex-provider.ts'
import type { ProviderEvent, ProviderSession, StartProviderSession } from '../adapters/provider.ts'
import type { RunnerCommand, RunnerConfig, RunnerNotice } from '../adapters/runner-protocol.ts'
import { startStandInSession } from '../adapters/standin-provider.ts'
import { encodeJournalRecord } from '../domain/journal.ts'
import type { JournalBody } from '../domain/journal.ts'

const providers: Record<RunnerConfig['provider'], StartProviderSession> = {
  stand_in: startStandInSession,
  claude: startClaudeSession,
  codex: startCodexSession,
}

const STOP_GRACE_MS = 3_000
// How often a runner checks that its journal still exists.
const HOME_CHECK_MS = 2_000

export function runRunner(config: RunnerConfig): void {
  const clients = new Set<Socket>()
  const takenAttemptIds = new Set<string>()
  let exiting = false

  const notifyClients = (notice: RunnerNotice) => {
    const line = `${JSON.stringify(notice)}\n`
    for (const client of clients) client.write(line)
  }

  const journal = (body: JournalBody) => {
    appendFileSync(config.journalPath, encodeJournalRecord({ ...body, at: Date.now(), generation: config.generation }))
    notifyClients({ type: 'journal_grew' })
  }

  const exitRunner = (reason: string) => {
    if (exiting) return
    exiting = true
    journal({ kind: 'runner_exiting', reason })
    rmSync(config.socketPath, { force: true })
    process.exit(0)
  }

  // A runner survives `ourod` going down, so the one signal that nobody will ever come back is its journal being gone:
  // the data directory was removed (a test run's cleanup, a deleted machine). It stops its model and leaves without
  // journaling, as there is nowhere to write.
  const leaveIfJournalGone = () => {
    if (exiting || existsSync(config.journalPath)) return
    exiting = true
    session.stop()
    rmSync(config.socketPath, { force: true })
    setTimeout(() => process.exit(0), STOP_GRACE_MS)
  }

  const onProviderEvent = (event: ProviderEvent) => {
    switch (event.type) {
      case 'exited': return exitRunner(event.reason)
      case 'session_identified': return journal({ kind: 'session_identified', providerSessionId: event.providerSessionId })
      case 'session_unresumable': return journal({ kind: 'session_unresumable', providerSessionId: event.providerSessionId, detail: event.detail })
      case 'taken_in': return journal({ kind: 'taken_in', attemptIds: event.attemptIds })
      case 'thinking': return journal({ kind: 'thinking' })
      case 'text': return journal({ kind: 'text', text: event.text })
      case 'tool_use': return journal({ kind: 'tool_use', toolName: event.toolName, input: event.input })
      case 'tool_result': return journal({ kind: 'tool_result', text: event.text, isError: event.isError })
      case 'turn_result': return journal({ kind: 'turn_result', acknowledgedAttemptIds: event.acknowledgedAttemptIds, costUsd: event.costUsd, context: event.context })
      case 'turn_failed': return journal({ kind: 'turn_failed', failure: event.failure, detail: event.detail, retryAfterMs: event.retryAfterMs })
      case 'compaction_finished': return journal({ kind: 'compaction_finished', contextTokens: event.contextTokens })
      case 'plan_usage_observed': return journal({ kind: 'plan_usage_observed', windows: event.windows })
      case 'notice': return journal({ kind: 'notice', text: event.text })
    }
  }

  journal({ kind: 'runner_started', pid: process.pid, release: config.release })

  const session: ProviderSession = providers[config.provider]({
    model: config.model,
    folder: config.folder,
    resumeProviderSessionId: config.resumeProviderSessionId,
    systemPrompt: config.systemPrompt,
    env: { ...config.env, ...readSecretEnv(config.secretEnvFiles) },
    stateDir: config.stateDir,
    memoryDir: config.memoryDir,
    promptCacheTtlMs: config.promptCacheTtlMs,
  }, onProviderEvent)

  const stopGracefully = (reason: string) => {
    session.stop()
    setTimeout(() => exitRunner(reason), STOP_GRACE_MS).unref()
  }

  const handleCommand = (command: RunnerCommand) => {
    switch (command.type) {
      case 'deliver':
        // `ourod` repeats in-turn deliveries after it reconnects, as it can't know whether the first send arrived.
        if (takenAttemptIds.has(command.delivery.attemptId)) return
        takenAttemptIds.add(command.delivery.attemptId)
        journal({ kind: 'incoming', attemptId: command.delivery.attemptId, from: command.delivery.from, text: command.delivery.text })
        session.deliver(command.delivery)
        return
      case 'interrupt': return session.interrupt()
      case 'compact': return session.compact(command.instructions)
      case 'stop': return stopGracefully('asked to stop')
    }
  }

  const server = createServer((socket) => {
    clients.add(socket)
    socket.write(`${JSON.stringify({ type: 'hello', agentId: config.agentId, generation: config.generation, pid: process.pid } satisfies RunnerNotice)}\n`)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => clients.delete(socket))
    const lines = createInterface({ input: socket })
    lines.on('error', () => socket.destroy())
    lines.on('line', (line) => handleCommand(JSON.parse(line) as RunnerCommand))
  })
  rmSync(config.socketPath, { force: true })
  server.listen(config.socketPath, () => journal({ kind: 'runner_ready' }))

  setInterval(leaveIfJournalGone, HOME_CHECK_MS).unref()
  process.on('SIGTERM', () => stopGracefully('SIGTERM'))
  process.on('SIGHUP', () => {}) // Its launcher going away is routine; that's the point of a runner.
  process.on('SIGPIPE', () => {})
}

/** A missing key file leaves its variable unset: the provider then reports it isn't signed in, as it would anyway. */
function readSecretEnv(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).flatMap(([name, path]) => {
    const value = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
    return value === '' ? [] : [[name, value]]
  }))
}
