// A new agent's name, when none was given: a short one the summarizer's model suggests from the task, as the reference
// does. The caller falls back to the task's first words when the model fails, is slow, or answers something unusable.
import { AGENT_NAME_PATTERN } from '@ouro/contract'
import { SummarizeFailed } from '../adapters/summarizer.ts'
import type { Summarize } from '../adapters/summarizer.ts'

/** Past this, creating the agent doesn't wait: the app is waiting on it. */
export const NAME_SUGGESTION_TIMEOUT_MS = 10_000

const TASK_CHARS = 500
const NAME_CHARS = 40
const MIN_NAME_CHARS = 3
const NAME_WORDS = 3

export const NAMING_INSTRUCTIONS = 'You name AI agents. Given an agent\'s task, answer with a short, memorable kebab-case name of 2 or 3 words that says what the agent is for, such as "invoice-parser" or "fix-login-bug". Answer with the name only.'

/** In a task, this line makes the stand-in namer answer the rest of the line, for tests; without it, it fails. */
export const STAND_IN_NAME_ANSWER = 'standin-name: '

/** Free and deterministic: answers what the task's stand-in line says. */
export const standInSuggestName: Summarize = async ({ digest }) => {
  const line = digest.split('\n').find((candidate) => candidate.startsWith(STAND_IN_NAME_ANSWER))
  if (line === undefined) throw new SummarizeFailed('the stand-in namer was given no name', 0)
  return { text: line.slice(STAND_IN_NAME_ANSWER.length), costUsd: 0 }
}

/** The model's answer as an agent name: lower-case kebab-case, at most 3 words and 40 characters; null when nothing usable
 * is left. */
export function agentNameOfAnswer(answer: string): string | null {
  const firstLine = answer.trim().split('\n')[0] ?? ''
  const words = firstLine.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '')
  const name = words.slice(0, NAME_WORDS).join('-').slice(0, NAME_CHARS).replace(/-+$/, '')
  return name.length >= MIN_NAME_CHARS && AGENT_NAME_PATTERN.test(name) ? name : null
}

export interface NameSuggestion {
  /** Null when the model gave no usable name in time. */
  name: string | null
  costUsd: number
}

/** Never throws: any failure is no suggestion. A late answer's cost isn't known, so it isn't counted. */
export async function suggestAgentName(summarize: Summarize, model: string, task: string, timeoutMs: number): Promise<NameSuggestion> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<NameSuggestion>((resolve) => { timer = setTimeout(() => resolve({ name: null, costUsd: 0 }), timeoutMs) })
  const asked = summarize({ model, instructions: NAMING_INSTRUCTIONS, digest: task.slice(0, TASK_CHARS) }).then(
    (answer): NameSuggestion => ({ name: agentNameOfAnswer(answer.text), costUsd: answer.costUsd }),
    (error: unknown): NameSuggestion => ({ name: null, costUsd: error instanceof SummarizeFailed ? error.costUsd : 0 }),
  )
  try {
    return await Promise.race([asked, late])
  } finally {
    clearTimeout(timer)
  }
}
