// Claude Code as a model provider: one long-lived `claude -p` process speaking stream-json. Messages go in on stdin as
// they arrive, so the model takes them in at its next boundary. Claude Code echoes each one back as it enters the
// conversation, and each `result` says which ones its turn covered.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ProviderFailure } from '../domain/agent.ts'
import { PROMPT_CACHE_TTL_MS } from '../domain/compaction.ts'
import type { ContextReading } from '../domain/compaction.ts'
import { inputTokensOfUsage } from '../domain/context.ts'
import { FIVE_HOUR_MINUTES, WEEKLY_MINUTES } from '../domain/usage.ts'
import type { PlanLimitStatus, PlanWindowReading } from '../domain/usage.ts'
import type { DeliveryForModel, ProviderEvent, ProviderSession, ProviderSessionParams } from './provider.ts'
import { readsAsRefusal } from './refusal.ts'

const FAILURE_PATTERNS: readonly [RegExp, ProviderFailure][] = [
  [/please run \/login|not logged in|invalid api key|authentication_error|oauth token has expired/i, 'logged_out'],
  [/credit balance|insufficient credit|billing/i, 'credits'],
  [/usage limit|hit your limit|rate_limit_error|limit reached/i, 'usage_limit'],
  [/overloaded|timeout|timed out|connection error|internal server error|api error: 5\d\d/i, 'transient'],
]

/** The only place that decides what kind of failure a Claude Code error text is. */
export function classifyClaudeFailure(text: string): ProviderFailure {
  // First: a refusal arrives as an "API Error" too, and retrying it can't help.
  if (readsAsRefusal(text)) return 'model_refused'
  for (const [pattern, failure] of FAILURE_PATTERNS) if (pattern.test(text)) return failure
  return 'transient'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
}

const WINDOW_MINUTES_BY_NAME: Readonly<Record<string, number>> = { five_hour: FIVE_HOUR_MINUTES, seven_day: WEEKLY_MINUTES }
const PLAN_LIMIT_STATUSES: readonly PlanLimitStatus[] = ['allowed', 'allowed_warning', 'rejected']

/**
 * The plan windows a `rate_limit_event` reports: `unifiedWindows` by name, each with a utilization (0..1), a reset time in
 * seconds, and a status. An event often carries only some of them. Windows of other names are left out.
 */
export function planWindowsOfRateLimit(info: Record<string, unknown>): PlanWindowReading[] {
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {}
  return Object.entries(windows).flatMap(([name, window]) => {
    const windowMinutes = WINDOW_MINUTES_BY_NAME[name]
    if (windowMinutes === undefined || !isRecord(window) || typeof window.utilization !== 'number' || typeof window.resetsAt !== 'number') return []
    const status = PLAN_LIMIT_STATUSES.find((known) => known === window.status) ?? null
    return [{ windowMinutes, usedFraction: window.utilization, resetsAt: window.resetsAt * 1000, status }]
  })
}

/** Claude Code's answer to `--resume` with a session it no longer has, before it exits. */
/**
 * The prompt size of one model request, from its usage, and how long it is cached: the lifetime it wrote with, or for a
 * request that only read, `cacheTtlMs`, the lifetime it was written with. Null for a request with no usage worth the name.
 */
export function contextOfUsage(usage: Record<string, unknown>, cacheTtlMs: number): ContextReading | null {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const tokens = inputTokensOfUsage(usage)
  if (tokens === 0) return null
  const written = isRecord(usage.cache_creation) ? usage.cache_creation : {}
  const writtenTtlMs = count(written.ephemeral_1h_input_tokens) > 0 ? PROMPT_CACHE_TTL_MS['1h'] : count(written.ephemeral_5m_input_tokens) > 0 ? PROMPT_CACHE_TTL_MS['5m'] : cacheTtlMs
  return { tokens, cacheTtlMs: writtenTtlMs }
}

/** Claude Code's own switches for the prompt cache lifetime. */
function cacheLifetimeEnv(promptCacheTtlMs: number | null): Record<string, string> {
  if (promptCacheTtlMs === null) return {}
  return promptCacheTtlMs >= PROMPT_CACHE_TTL_MS['1h'] ? { ENABLE_PROMPT_CACHING_1H: '1' } : { FORCE_PROMPT_CACHING_5M: '1' }
}

export function isUnresumableSession(stderr: string): boolean {
  return /no conversation found/i.test(stderr)
}

export function claudeArguments(params: ProviderSessionParams): string[] {
  return [
    '-p',
    '--model', params.model,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', params.systemPrompt,
    ...(params.resumeProviderSessionId ? ['--resume', params.resumeProviderSessionId] : []),
    ...(params.memoryDir ? ['--settings', JSON.stringify(memorySettings(params.memoryDir))] : []),
  ]
}

/** The project's memory instead of Claude Code's per-folder one, synced with the person's shared notes when a session
 * starts and after each write. The hook reads which file was written from its input. */
function memorySettings(memoryDir: string): object {
  const sync = { type: 'command', command: 'ouro memory sync --hook', timeout: 30 }
  return {
    autoMemoryDirectory: memoryDir,
    hooks: {
      SessionStart: [{ hooks: [sync] }],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [sync] }],
    },
  }
}

export function startClaudeSession(params: ProviderSessionParams, onEvent: (event: ProviderEvent) => void): ProviderSession {
  const child = spawn(params.env.OURO_CLAUDE_BIN ?? 'claude', claudeArguments(params), {
    cwd: params.folder,
    env: { ...params.env, ...cacheLifetimeEnv(params.promptCacheTtlMs) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Written to the process and not yet covered by a result. A result without ids falls back to these.
  const unacknowledgedAttemptIds = new Set<string>()
  const stderrTail: string[] = []
  let compacting = false
  let compactedTokens: number | null = null
  // Claude Code writes an API error as the assistant's text, and its result may say less, or not come before it exits.
  let apiErrorText: string | null = null
  // The latest request's prompt, which is what the next one reads from the cache or writes again.
  let latestContext: ContextReading | null = null
  // The lifetime the cache was last written with, which a request that only reads keeps.
  let cacheTtlMs = params.promptCacheTtlMs

  const handleAssistant = (message: unknown) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return
    const reading = cacheTtlMs !== null && isRecord(message.usage) ? contextOfUsage(message.usage, cacheTtlMs) : null
    if (reading) {
      latestContext = reading
      cacheTtlMs = reading.cacheTtlMs
    }
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') {
        if (part.text.startsWith('API Error')) apiErrorText = part.text
        onEvent({ type: 'text', text: part.text })
      }
      else if (part.type === 'tool_use' && typeof part.name === 'string') onEvent({ type: 'tool_use', toolName: part.name, input: JSON.stringify(part.input ?? {}) })
      else if (part.type === 'thinking') onEvent({ type: 'thinking' })
    }
  }

  const handleUser = (raw: Record<string, unknown>) => {
    if (raw.isReplay === true) {
      // `--replay-user-messages`: the echo comes when the message is taken in, not when it's written to stdin.
      if (typeof raw.uuid === 'string' && unacknowledgedAttemptIds.has(raw.uuid)) onEvent({ type: 'taken_in', attemptIds: [raw.uuid] })
      return
    }
    const message = raw.message
    if (!isRecord(message) || !Array.isArray(message.content)) return
    for (const part of message.content) {
      if (isRecord(part) && part.type === 'tool_result') {
        onEvent({ type: 'tool_result', text: textOfToolResult(part.content), isError: part.is_error === true })
      }
    }
  }

  const handleResult = (raw: Record<string, unknown>) => {
    if (compacting) {
      compacting = false
      onEvent({ type: 'compaction_finished', contextTokens: compactedTokens })
      compactedTokens = null
      latestContext = null
      return
    }
    const lastApiError = apiErrorText
    apiErrorText = null
    if (raw.is_error === true) {
      const result = typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result ?? raw.subtype ?? 'unknown error')
      const detail = lastApiError !== null && readsAsRefusal(lastApiError) && !readsAsRefusal(result) ? lastApiError : result
      // An interrupted turn reports an error result too; that case arrives with this subtype and isn't a failure.
      if (raw.subtype !== 'error_during_execution') {
        onEvent({ type: 'turn_failed', failure: classifyClaudeFailure(detail), detail: detail.slice(0, 500), retryAfterMs: null })
        return
      }
    }
    const reported = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids.filter((id): id is string => typeof id === 'string') : []
    const acknowledged = reported.length > 0 ? reported : [...unacknowledgedAttemptIds]
    for (const id of acknowledged) unacknowledgedAttemptIds.delete(id)
    onEvent({ type: 'turn_result', acknowledgedAttemptIds: acknowledged, costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : 0, context: latestContext })
    latestContext = null
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      onEvent({ type: 'notice', text: `unreadable output from claude: ${line.slice(0, 200)}` })
      return
    }
    if (!isRecord(raw)) return
    switch (raw.type) {
      case 'system':
        if (raw.subtype === 'init' && typeof raw.session_id === 'string') onEvent({ type: 'session_identified', providerSessionId: raw.session_id })
        // The whole set each time it changes: a task started, finished, or was stopped.
        if (raw.subtype === 'background_tasks_changed' && Array.isArray(raw.tasks)) onEvent({ type: 'background_tasks', running: raw.tasks.length })
        if (raw.subtype === 'compact_boundary' && isRecord(raw.compact_metadata) && typeof raw.compact_metadata.post_tokens === 'number') compactedTokens = raw.compact_metadata.post_tokens
        return
      case 'rate_limit_event': {
        const windows = isRecord(raw.rate_limit_info) ? planWindowsOfRateLimit(raw.rate_limit_info) : []
        if (windows.length > 0) onEvent({ type: 'plan_usage_observed', windows })
        return
      }
      case 'assistant': return handleAssistant(raw.message)
      case 'user': return handleUser(raw)
      case 'result': return handleResult(raw)
    }
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })
  child.on('error', (error) => onEvent({ type: 'exited', reason: `could not run claude: ${error.message}` }))
  child.on('close', (code) => {
    // A refusal, then claude gone before its result: the turn was refused, not crashed, so it isn't retried.
    if (apiErrorText !== null && readsAsRefusal(apiErrorText) && unacknowledgedAttemptIds.size > 0) {
      onEvent({ type: 'turn_failed', failure: 'model_refused', detail: apiErrorText.slice(0, 500), retryAfterMs: null })
    }
    const stderr = stderrTail.join('\n')
    if (params.resumeProviderSessionId !== null && code !== 0 && isUnresumableSession(stderr)) {
      onEvent({ type: 'session_unresumable', providerSessionId: params.resumeProviderSessionId, detail: stderr.slice(-500) })
    }
    onEvent({ type: 'exited', reason: `claude exited with ${code}: ${stderrTail.slice(-3).join(' ').slice(0, 500)}` })
  })

  const write = (message: object) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  return {
    deliver(delivery: DeliveryForModel) {
      unacknowledgedAttemptIds.add(delivery.attemptId)
      write({ type: 'user', uuid: delivery.attemptId, message: { role: 'user', content: delivery.modelContent } })
    },
    interrupt() {
      write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } })
    },
    compact(instructions: string) {
      compacting = true
      write({ type: 'user', message: { role: 'user', content: `/compact ${instructions}` } })
    },
    stop() {
      child.stdin.end()
      child.kill('SIGTERM')
    },
  }
}
