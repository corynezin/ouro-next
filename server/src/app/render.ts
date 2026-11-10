// How a delivery reads to a model. These words go only to the model; nothing here is parsed back.
import type { MessagePurpose } from '@ouro/contract'
import { OWNER_ADDRESS } from '@ouro/contract'

export function renderForModel(message: { from: string; text: string; purpose: MessagePurpose; attachmentPaths: string[] }, delivery: { wake: 'wake' | 'fyi'; possiblySeen: boolean }, chat: { groupHandle: string | null }): string {
  const header = message.purpose === 'task' && message.from === OWNER_ADDRESS
    ? ''
    : chat.groupHandle !== null
      ? `[${chat.groupHandle} from ${message.from}] `
      : message.purpose === 'system_notice'
        ? '[system] '
        : `[${message.from}] `
  const fyi = delivery.wake === 'fyi' ? '[fyi] ' : ''
  const possiblySeen = delivery.possiblySeen
    ? '[possibly already seen: this message was in a turn that did not finish, so check what you already did before repeating any action]\n'
    : ''
  const attached = message.attachmentPaths.length > 0 ? `\n\nAttached files:\n${message.attachmentPaths.join('\n')}` : ''
  return `${possiblySeen}${fyi}${header}${message.text}${attached}`
}

export interface PromptFacts {
  name: string
  parent: string
  creator: string
  folder: string
  /** Where the person's own copy of the app and the server are, when this machine has them. */
  appSource: string
  serverSource: string
}

export function renderSystemPrompt(template: string, facts: PromptFacts): string {
  return template
    .replaceAll('{{name}}', facts.name)
    .replaceAll('{{parent}}', facts.parent)
    .replaceAll('{{creator}}', facts.creator)
    .replaceAll('{{folder}}', facts.folder)
    .replaceAll('{{appSource}}', facts.appSource)
    .replaceAll('{{serverSource}}', facts.serverSource)
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'in', 'on', 'for', 'please', 'my', 'our', 'with'])

/** A readable name from a task, when none was given. Uniqueness is the caller's job. */
export function agentNameFromTask(task: string): string {
  const words = task.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((word) => word.length > 0 && !STOP_WORDS.has(word))
  const name = words.slice(0, 3).join('-').slice(0, 40).replace(/-+$/, '')
  return /^[a-z0-9]/.test(name) ? name : 'agent'
}

const SEED_MESSAGE_CHARS = 2_000

/**
 * For a fresh model session on an agent that has run before: its task and what it last took part in, so it can carry on.
 * Added to the system prompt, since the old session's history is gone.
 */
export function renderConversationSeed(input: { task: string; recent: readonly { from: string; at: number; text: string }[]; previousEndedOnRefusal: boolean }): string {
  const why = input.previousEndedOnRefusal
    ? 'Your previous model session ended because the model refused a message you were sent, and that session could not be continued. This is a new session. The refused message is not included below; its sender has been told it was not delivered.'
    : 'Your previous model session could not be continued, so this is a new session and you start with an empty memory. Check the files in your folder for work already done.'
  const lines = input.recent.map((message) => {
    const text = message.text.length > SEED_MESSAGE_CHARS ? `${message.text.slice(0, SEED_MESSAGE_CHARS)} …` : message.text
    return `${new Date(message.at).toISOString().slice(0, 16).replace('T', ' ')} [${message.from}] ${text}`
  })
  return [
    '## Where you left off',
    why,
    `Your task: ${input.task}`,
    ...(lines.length > 0 ? ['Your most recent messages, oldest first:', ...lines] : []),
    'Older messages are in your chats: find them with `ouro search <words>`. `ouro log <your name>` shows what you did.',
  ].join('\n\n')
}
