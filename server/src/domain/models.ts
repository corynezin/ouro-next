// Which provider runs a model, and what a launch uses when that provider isn't available. Pure.

export type ModelProvider = 'anthropic' | 'openai' | 'openrouter' | 'stand_in'

/** The program an agent's model runs in. OpenRouter's models run in Claude Code, pointed at OpenRouter. */
export type ModelRuntime = 'claude_code' | 'codex' | 'stand_in'

/** Whether the provider's prompt cache expires a set time after each request, which compaction can race. */
export function hasTimedPromptCache(provider: ModelProvider): boolean {
  return provider === 'anthropic' || provider === 'stand_in'
}

export function runtimeOf(provider: ModelProvider): ModelRuntime {
  switch (provider) {
    case 'anthropic':
    case 'openrouter': return 'claude_code'
    case 'openai': return 'codex'
    case 'stand_in': return 'stand_in'
  }
}

export interface CatalogModel {
  /** What agents, the app and the command line call it. */
  id: string
  label: string
  provider: ModelProvider
  /** The provider's own name for it. */
  providerModelId: string
}

export const STAND_IN_MODEL_ID = 'stand-in'

/** OpenRouter models run on Claude Code pointed at OpenRouter. `or-haiku` is Haiku billed there; `haiku` is the plan's. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  { id: 'fable', label: 'Claude Fable', provider: 'anthropic', providerModelId: 'claude-fable-5-2' },
  { id: 'opus', label: 'Claude Opus', provider: 'anthropic', providerModelId: 'opus' },
  { id: 'sonnet', label: 'Claude Sonnet', provider: 'anthropic', providerModelId: 'sonnet' },
  { id: 'haiku', label: 'Claude Haiku', provider: 'anthropic', providerModelId: 'haiku' },
  { id: 'deepseek', label: 'DeepSeek V4 Pro', provider: 'openrouter', providerModelId: 'deepseek/deepseek-v4-pro' },
  { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', provider: 'openrouter', providerModelId: 'deepseek/deepseek-v4.1-flash' },
  { id: 'or-haiku', label: 'Haiku via OpenRouter', provider: 'openrouter', providerModelId: 'anthropic/claude-haiku-5.5' },
  { id: 'qwen-coder', label: 'Qwen3 Coder', provider: 'openrouter', providerModelId: 'qwen/qwen3-coder' },
  { id: 'gemini-flash', label: 'Gemini 3.8 Flash', provider: 'openrouter', providerModelId: 'google/gemini-3.8-flash' },
]

/** OpenAI's models aren't in the catalog: which ones a ChatGPT plan may run, Codex says. */
const OPENAI_MODEL_ID = /^(?:gpt-|codex-)/

/** A model not in the catalog is OpenAI's by its name, and otherwise a Claude model by its full name, as Claude Code takes it. */
export function catalogModel(modelId: string): CatalogModel {
  if (modelId === STAND_IN_MODEL_ID) return { id: modelId, label: 'Stand-in', provider: 'stand_in', providerModelId: modelId }
  if (OPENAI_MODEL_ID.test(modelId)) return { id: modelId, label: modelId, provider: 'openai', providerModelId: modelId }
  return MODEL_CATALOG.find((model) => model.id === modelId) ?? { id: modelId, label: modelId, provider: 'anthropic', providerModelId: modelId }
}

/** What runs, and on what. `fallbackFrom`: the chosen model, when its provider isn't available and another runs instead. */
export interface LaunchModel {
  model: CatalogModel
  fallbackFrom: CatalogModel | null
}

/** The model Claude Code runs when an agent's chosen provider isn't set up. */
export const FALLBACK_MODEL_ID = 'sonnet'

export function launchModelFor(modelId: string, available: { openrouter: boolean }): LaunchModel {
  const chosen = catalogModel(modelId)
  if (chosen.provider === 'openrouter' && !available.openrouter) return { model: catalogModel(FALLBACK_MODEL_ID), fallbackFrom: chosen }
  return { model: chosen, fallbackFrom: null }
}
