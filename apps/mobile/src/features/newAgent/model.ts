// The New agent sheet as data. The server says which models exist; this groups them as the pickers show them.
import type { CommandInput, ComputerEntity, ModelOption, PromptCacheLifetime } from '@ouro/contract'

export interface ModelGroup { title: string; models: { id: string; label: string }[] }

const GROUP_TITLES: { provider: ModelOption['provider']; title: string }[] = [
  { provider: 'anthropic', title: 'Subscription' },
  { provider: 'openai', title: 'ChatGPT' },
  { provider: 'openrouter', title: 'OpenRouter' },
  { provider: 'stand_in', title: 'Stand-in' },
]

/** How the reference names a model in the pickers. The server's label says more (a version, a route), for agents. */
const MODEL_NAMES: Record<string, string> = {
  fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5',
  deepseek: 'DeepSeek', 'deepseek-flash': 'DeepSeek Flash',
  'qwen-coder': 'Qwen Coder', 'gemini-flash': 'Gemini Flash', 'or-haiku': 'Haiku',
}

/** The reference's order within each group, most capable first; a model it doesn't list keeps the server's order, after. */
const MODEL_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'deepseek', 'qwen-coder', 'deepseek-flash', 'gemini-flash', 'or-haiku']
const orderOf = (id: string) => { const index = MODEL_ORDER.indexOf(id); return index === -1 ? MODEL_ORDER.length : index }

/** The ChatGPT plan's models, which the plan decides, by their parts: `gpt-5-codex` is "GPT-5-Codex". */
const gptName = (id: string) => id.split('-').map((part) => (part === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1))).join('-')

/** A model's name as the pickers show it; one the reference doesn't name keeps the server's label. */
export function modelName(model: { id: string; label: string; provider: ModelOption['provider'] }): string {
  return MODEL_NAMES[model.id] ?? (model.provider === 'openai' ? gptName(model.id) : model.label)
}

/** Only what can run now, plus `current` so an agent's existing model stays selectable. */
export function modelGroups(models: readonly ModelOption[], current: string | null): ModelGroup[] {
  const shown = models.filter((m) => m.available || m.id === current)
  const groups = GROUP_TITLES.map(({ provider, title }) => ({
    title,
    models: shown.filter((m) => m.provider === provider).sort((x, y) => orderOf(x.id) - orderOf(y.id)).map((m) => ({ id: m.id, label: modelName(m) })),
  })).filter((group) => group.models.length)
  if (current !== null && !models.some((m) => m.id === current)) groups.push({ title: 'Other', models: [{ id: current, label: current }] })
  return groups
}

/** Files don't go to another computer yet: with some picked, an agent there can't start until they are removed. */
export const canStartAgent = (task: string, busy: boolean, fileCount = 0, remote = false) => !busy && !!task.trim() && !(remote && fileCount > 0)

export const FILES_COPY = {
  add: 'Add files',
  remoteRefused: "Files can't go to another computer yet: remove them to start it there.",
} as const

/** An agent name has no spaces: they are stripped as it is typed, as in the reference. */
export const typedAgentName = (typed: string) => typed.replace(/\s/g, '')

/** Where a new agent runs: here, or on one of the person's other computers. */
export interface MachineOption { key: string; computerId: string | null; label: string }

const HERE: MachineOption = { key: 'here', computerId: null, label: 'Cloud computer' }

/** Here first, then the other computers by name, those with no agents yet too. Only a computer that trusts this one fully
 * takes an agent from it; with none, there is nothing to pick and the picker isn't shown. */
export function machineOptions(computers: Iterable<ComputerEntity>): MachineOption[] {
  const others = [...computers]
    .filter((computer) => computer.trust === 'full')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((computer) => ({ key: `computer:${computer.id}`, computerId: computer.id, label: computer.name }))
  return others.length ? [HERE, ...others] : []
}

export const machineFooter = (machineName: string) => `It runs on ${machineName} and reports to you here.`

/** Without a model chosen, that computer's own default, which may not be this one's. The cache lifetime as for
 * newAgentInput. */
export function newRemoteAgentInput(computerId: string, task: string, name: string, chosenModel: string | null, promptCache: PromptCacheLifetime | null): CommandInput<'create_remote_agent'> {
  const input: CommandInput<'create_remote_agent'> = { computerId, task, name: name.trim() || null, model: chosenModel, folder: null }
  return promptCache === '1h' ? { ...input, promptCacheLifetime: promptCache } : input
}

/** Only Anthropic's models keep a timed prompt cache; the others have nothing to choose. */
export const hasPromptCache = (models: readonly ModelOption[], model: string | null) => models.find((m) => m.id === model)?.provider === 'anthropic'

export const PROMPT_CACHE_OPTIONS: readonly { lifetime: PromptCacheLifetime; label: string }[] = [
  { lifetime: '5m', label: '5 min' },
  { lifetime: '1h', label: '1 hour' },
]

/** `promptCache` is null for a model without one. The lifetime is sent only when it isn't the server's default.
 * `attachmentIds`: the files already uploaded, which come in the task's message; sent only when there are some. */
export function newAgentInput(task: string, name: string, model: string | null, promptCache: PromptCacheLifetime | null, attachmentIds: readonly string[] = []): CommandInput<'create_agent'> {
  const input: CommandInput<'create_agent'> = { task, name: name.trim() || null, model, folder: null, ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}) }
  return promptCache === '1h' ? { ...input, promptCacheLifetime: promptCache } : input
}
