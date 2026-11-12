// The stand-in model: real runner, real CLI, real journal, with only the model replaced. It "reads" a message the way a
// model would: a message containing a `standin:` line with a JSON step list follows that script, and anything else gets
// a short reply through the real `ouro` command. Scripts can fail like a provider, hold at a barrier, or run commands.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ProviderFailure } from '../domain/agent.ts'
import type { PlanWindowReading } from '../domain/usage.ts'
import { classifyClaudeFailure } from './claude-provider.ts'
import type { DeliveryForModel, ProviderEvent, ProviderSession, ProviderSessionParams } from './provider.ts'

export type StandInStep =
  | { do: 'text'; text: string }
  | { do: 'run'; command: string }
  | { do: 'barrier'; name: string }
  /** Fails the turn like a provider would, the first time this message is attempted. */
  /** Once per message, unless `everyTime`. */
  | { do: 'fail'; failure: ProviderFailure; detail: string; retryAfterMs?: number; everyTime?: boolean }
  /** Kills this runner and everything under it mid-turn, as a crash would. */
  | { do: 'crash' }
  /** Crashes the first time this name is reached, and does nothing on later attempts: a crash that a resume survives. */
  | { do: 'crash_once'; name: string }
  | { do: 'cost'; usd: number }
  /** The turn's prompt was this large, as the turn result reports it, cached for the lifetime the session asked for. */
  | { do: 'context'; tokens: number }
  /** Reports the plan's usage windows, as Claude Code's rate-limit events do. */
  | { do: 'plan_usage'; windows: PlanWindowReading[] }
  | { do: 'exit_session' }
  /** Fails every time, the way Claude Code does: an error result, classified by the Claude adapter, then its process exits. */
  | { do: 'claude_error'; text: string }
  /** The provider loses this conversation and the runner crashes, the first time this name is reached: the next launch
   *  can't resume it. */
  | { do: 'lose_session_once'; name: string }
  /** Leaves a background task running past the turn, as Claude Code's background shell does. Once barrier `name` is
   *  released the task ends, and the model takes its own turn for it, with nothing handed to it, running `then`. */
  | { do: 'background'; name: string; then: StandInStep[] }

function crashRunner(): void {
  process.kill(-process.pid, 'SIGKILL')
  process.kill(process.pid, 'SIGKILL')
}

const SCRIPT_LINE = /standin:\s*(\[.*\])\s*$/m
const BARRIER_POLL_MS = 20
/** Longer than any launch deadline: a hung launch is ended by `ourod`, never by waking up. */
const HUNG_LAUNCH_MS = 60 * 60_000

/**
 * A launch that is accepted but never answered: when the barrier directory holds `hang-launch`, the next session to
 * start takes it and blocks its runner before the runner can say it is ready. One file, one hung launch.
 */
function hangLaunchIfAsked(barrierDir: string): void {
  const marker = join(barrierDir, 'hang-launch')
  try {
    renameSync(marker, `${marker}.taken`)
  } catch {
    return // not asked, or another session took it first
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HUNG_LAUNCH_MS)
}
/** What a compacted context comes to. */
const COMPACTED_CONTEXT_TOKENS = 5_000

function scriptOf(content: string): StandInStep[] | null {
  const match = SCRIPT_LINE.exec(content)
  if (!match) return null
  return JSON.parse(match[1]!) as StandInStep[]
}

export function startStandInSession(params: ProviderSessionParams, onEvent: (event: ProviderEvent) => void): ProviderSession {
  const conversationDir = join(params.stateDir, 'standin')
  mkdirSync(conversationDir, { recursive: true })
  if (params.resumeProviderSessionId !== null && !existsSync(join(conversationDir, `${params.resumeProviderSessionId}.jsonl`))) {
    const detail = `No conversation found with session ID: ${params.resumeProviderSessionId}`
    queueMicrotask(() => {
      onEvent({ type: 'session_unresumable', providerSessionId: params.resumeProviderSessionId!, detail })
      onEvent({ type: 'exited', reason: detail })
    })
    return { deliver() {}, interrupt() {}, compact() {}, stop() {} }
  }
  const sessionId = params.resumeProviderSessionId ?? randomUUID()
  const conversationPath = join(conversationDir, `${sessionId}.jsonl`)
  if (!existsSync(conversationPath)) writeFileSync(conversationPath, '')
  const barrierDir = params.env.OURO_STANDIN_BARRIERS ?? join(conversationDir, 'barriers')
  mkdirSync(barrierDir, { recursive: true })
  hangLaunchIfAsked(barrierDir)

  // The model hasn't taken these in yet. Messages arriving mid-turn wait here for the next one, as a real model's would.
  const inbox: DeliveryForModel[] = []
  let currentTurn: { attemptIds: string[]; cancel: () => void } | null = null
  let stopped = false
  let interruptRequested = false
  // Turns the model takes on its own, for background tasks that ended: each waits until no turn runs.
  const unpromptedTurns: StandInStep[][] = []
  let backgroundRunning = 0

  onEvent({ type: 'session_identified', providerSessionId: sessionId })

  const remember = (entry: object) => appendFileSync(conversationPath, `${JSON.stringify(entry)}\n`)

  const conversationText = (): string[] => readFileSync(conversationPath, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { text: string }).text)

  const runCommand = (command: string, delivery: DeliveryForModel) => new Promise<{ ok: boolean; output: string }>((resolve) => {
    onEvent({ type: 'tool_use', toolName: 'Bash', input: command })
    execFile('/bin/sh', ['-c', command], { cwd: params.folder, env: { ...params.env, OURO_STANDIN_MESSAGE: delivery.text, OURO_STANDIN_MODEL_CONTENT: delivery.modelContent, OURO_STANDIN_HISTORY: conversationText().join('\n') }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`
      onEvent({ type: 'tool_result', text: output, isError: error !== null })
      resolve({ ok: error === null, output })
    })
  })

  // A background task outlives the turn that started it, so interrupting a later turn doesn't end it.
  const waitForBarrier = (name: string, { interruptible = true } = {}) => new Promise<void>((resolve) => {
    writeFileSync(join(barrierDir, `${name}.reached`), '')
    const check = setInterval(() => {
      if (stopped || (interruptible && interruptRequested) || existsSync(join(barrierDir, `${name}.release`))) {
        clearInterval(check)
        resolve()
      }
    }, BARRIER_POLL_MS)
  })

  async function runTurn(deliveries: DeliveryForModel[]): Promise<void> {
    let costUsd = 0.001
    let contextTokens: number | null = null
    onEvent({ type: 'taken_in', attemptIds: deliveries.map((delivery) => delivery.attemptId) })
    for (const delivery of deliveries) remember({ text: delivery.text, from: delivery.from })
    onEvent({ type: 'thinking' })
    for (const delivery of deliveries) {
      const steps = scriptOf(delivery.modelContent) ?? [{ do: 'run', command: `ouro reply "stand-in received: $OURO_STANDIN_MESSAGE"` } satisfies StandInStep]
      for (const step of steps) {
        if (stopped || interruptRequested) break
        switch (step.do) {
          case 'text':
            onEvent({ type: 'text', text: step.text })
            break
          case 'run':
            await runCommand(step.command, delivery)
            break
          case 'barrier':
            await waitForBarrier(step.name)
            break
          case 'cost':
            costUsd += step.usd
            break
          case 'context':
            contextTokens = step.tokens
            break
          case 'plan_usage':
            onEvent({ type: 'plan_usage_observed', windows: step.windows })
            break
          case 'fail': {
            const marker = join(conversationDir, `failed-${createHash('sha256').update(delivery.text).digest('hex').slice(0, 16)}`)
            if (existsSync(marker) && step.everyTime !== true) break
            writeFileSync(marker, '')
            onEvent({ type: 'turn_failed', failure: step.failure, detail: step.detail, retryAfterMs: step.retryAfterMs ?? null })
            return
          }
          case 'crash':
            crashRunner()
            return
          case 'crash_once': {
            const marker = join(conversationDir, `crashed-${step.name}`)
            if (existsSync(marker)) break
            writeFileSync(marker, '')
            crashRunner()
            return
          }
          case 'lose_session_once': {
            const marker = join(conversationDir, `lost-${step.name}`)
            if (existsSync(marker)) break
            writeFileSync(marker, '')
            rmSync(conversationPath)
            crashRunner()
            return
          }
          case 'exit_session':
            onEvent({ type: 'exited', reason: 'the session ended' })
            return
          case 'background':
            backgroundRunning += 1
            onEvent({ type: 'background_tasks', running: backgroundRunning })
            void waitForBarrier(step.name, { interruptible: false }).then(() => {
              if (stopped) return
              backgroundRunning -= 1
              onEvent({ type: 'background_tasks', running: backgroundRunning })
              unpromptedTurns.push(step.then)
              startNextTurnIfIdle()
            })
            break
          case 'claude_error':
            onEvent({ type: 'turn_failed', failure: classifyClaudeFailure(step.text), detail: step.text.slice(0, 500), retryAfterMs: null })
            onEvent({ type: 'exited', reason: 'claude exited with 1' })
            return
        }
      }
    }
    if (stopped) return
    const context = contextTokens !== null && params.promptCacheTtlMs !== null ? { tokens: contextTokens, cacheTtlMs: params.promptCacheTtlMs } : null
    onEvent({ type: 'turn_result', acknowledgedAttemptIds: deliveries.map((delivery) => delivery.attemptId), costUsd, context })
  }

  /** Only text and commands: what a model does when a background task's end wakes it. */
  async function runUnpromptedTurn(steps: StandInStep[]): Promise<void> {
    const nothingHanded: DeliveryForModel = { attemptId: '', from: '', text: '', modelContent: '' }
    onEvent({ type: 'thinking' })
    for (const step of steps) {
      if (stopped || interruptRequested) break
      if (step.do === 'text') onEvent({ type: 'text', text: step.text })
      if (step.do === 'run') await runCommand(step.command, nothingHanded)
    }
    if (!stopped) onEvent({ type: 'turn_result', acknowledgedAttemptIds: [], costUsd: 0.001, context: null })
  }

  function startNextTurnIfIdle(): void {
    if (currentTurn || stopped) return
    const unprompted = inbox.length === 0 ? unpromptedTurns.shift() : undefined
    if (unprompted) {
      currentTurn = { attemptIds: [], cancel: () => {} }
      void runUnpromptedTurn(unprompted).finally(() => {
        currentTurn = null
        startNextTurnIfIdle()
      })
      return
    }
    if (inbox.length === 0) return
    const deliveries = inbox.splice(0)
    interruptRequested = false
    currentTurn = { attemptIds: deliveries.map((delivery) => delivery.attemptId), cancel: () => {} }
    void runTurn(deliveries).finally(() => {
      currentTurn = null
      startNextTurnIfIdle()
    })
  }

  return {
    deliver(delivery) {
      inbox.push(delivery)
      startNextTurnIfIdle()
    },
    interrupt() {
      interruptRequested = true
    },
    compact(instructions) {
      // Kept in the conversation, as a model's summary would keep them, so a later step can show them.
      remember({ text: `compacted: ${instructions}`, from: 'compaction' })
      onEvent({ type: 'compaction_finished', contextTokens: COMPACTED_CONTEXT_TOKENS })
    },
    stop() {
      stopped = true
      onEvent({ type: 'exited', reason: 'stopped' })
    },
  }
}
