// What `ourod` and a runner say over the runner's socket, one JSON object per line. Everything durable goes through the
// journal instead. Commands here are safe to repeat: a runner ignores an attempt it has already taken.
import type { DeliveryForModel } from './provider.ts'

export type RunnerCommand =
  | { type: 'deliver'; delivery: DeliveryForModel }
  | { type: 'interrupt' }
  | { type: 'compact'; instructions: string }
  | { type: 'stop' }

export type RunnerNotice =
  | { type: 'hello'; agentId: string; generation: number; pid: number }
  | { type: 'journal_grew' }

export interface RunnerConfig {
  agentId: string
  generation: number
  journalPath: string
  socketPath: string
  stateDir: string
  release: string
  provider: 'stand_in' | 'claude' | 'codex'
  model: string
  folder: string
  resumeProviderSessionId: string | null
  systemPrompt: string
  memoryDir: string | null
  /** The prompt cache lifetime asked for; null when the model has no timed prompt cache. */
  promptCacheTtlMs: number | null
  /** The environment the model process and its tools see. Includes the agent's own credential for the `ouro` command. */
  env: Record<string, string>
  /** Variables whose values the runner reads from these files when it starts, so a long-lived key stays out of this config. */
  secretEnvFiles: Record<string, string>
}
