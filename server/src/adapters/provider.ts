// The port every model provider implements. A session is one running model process on one conversation. Failure
// classification lives in each adapter and nowhere else.
import type { ProviderFailure } from '../domain/agent.ts'
import type { ContextReading } from '../domain/compaction.ts'
import type { PlanWindowReading } from '../domain/usage.ts'

export interface DeliveryForModel {
  attemptId: string
  from: string
  /** The message as sent, for the log. */
  text: string
  /** What the model reads: the text with its sender and chat, and whether it was possibly seen before. */
  modelContent: string
}

export type ProviderEvent =
  | { type: 'session_identified'; providerSessionId: string }
  /** The conversation asked to resume no longer exists at the provider. The process exits after this. */
  | { type: 'session_unresumable'; providerSessionId: string; detail: string }
  /** These deliveries entered the model's conversation: at the start of a turn, or at a boundary within one. */
  | { type: 'taken_in'; attemptIds: string[] }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; input: string }
  | { type: 'tool_result'; text: string; isError: boolean }
  /** `context`: null when the provider reports no prompt size, or the model has no timed prompt cache. */
  | { type: 'turn_result'; acknowledgedAttemptIds: string[]; costUsd: number; context: ContextReading | null }
  | { type: 'turn_failed'; failure: ProviderFailure; detail: string; retryAfterMs: number | null }
  /** `contextTokens`: the compacted context's size; null when the provider doesn't say. */
  | { type: 'compaction_finished'; contextTokens: number | null }
  /** The subscription's usage windows, as the provider reported them; only those it reported. */
  | { type: 'plan_usage_observed'; windows: PlanWindowReading[] }
  | { type: 'notice'; text: string }
  /** How many background tasks (shell commands, subagents) the model has running, each time that set changes. */
  | { type: 'background_tasks'; running: number }
  | { type: 'exited'; reason: string }

export interface ProviderSessionParams {
  model: string
  folder: string
  /** Null starts a new conversation. */
  resumeProviderSessionId: string | null
  systemPrompt: string
  env: Record<string, string>
  stateDir: string
  /** The project's memory folder, for a provider with a memory of its own to use; null: not in a project. */
  memoryDir: string | null
  /** The prompt cache lifetime asked for; null when the model has no timed prompt cache. */
  promptCacheTtlMs: number | null
}

export interface ProviderSession {
  deliver(delivery: DeliveryForModel): void
  interrupt(): void
  /** `instructions`: what the summary must include, for a provider that takes any. */
  compact(instructions: string): void
  /** Ends the model process, giving it the chance to save its conversation. */
  stop(): void
}

export type StartProviderSession = (params: ProviderSessionParams, onEvent: (event: ProviderEvent) => void) => ProviderSession
