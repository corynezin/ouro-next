/** Visual categories within each provider's lineup, not cross-provider benchmark ranks. */
export type AvatarCompany = 'anthropic' | 'openai' | 'google' | 'qwen' | 'deepseek'
export type AvatarCapability = 'fast' | 'balanced' | 'flagship'

/** The company and capability an agent's avatar announces to VoiceOver; unknown models get neither rather than a guessed rank. */
export function avatarModel(model?: string): { company?: AvatarCompany; capability?: AvatarCapability } {
  const m = model?.toLowerCase().replace(/\[.*\]$/, '') ?? ''
  if (/^(?:anthropic\/)?(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-|$)/.test(m) || m === 'or-haiku') {
    return { company: 'anthropic', capability: m.includes('fable') || m.includes('opus') ? 'flagship' : m.includes('haiku') ? 'fast' : 'balanced' }
  }
  if (/^(?:openai\/)?(?:gpt-|codex-)/.test(m)) {
    // Current Codex model families: Luna is fast, Sol/Terra balanced, Astra flagship.
    const capability = /-(?:luna|mini|nano)(?:-|$)/.test(m) ? 'fast'
      : /-(?:astra|pro)(?:-|$)/.test(m) ? 'flagship'
      : /-(?:sol|terra)(?:-|$)/.test(m) ? 'balanced' : undefined
    return { company: 'openai', capability }
  }
  if (/^(?:google\/)?gemini-/.test(m)) return { company: 'google', capability: m.includes('flash') ? 'fast' : m.includes('pro') ? 'flagship' : undefined }
  if (/^(?:deepseek\/)?deepseek(?:-|$)/.test(m)) return { company: 'deepseek', capability: m.includes('flash') ? 'fast' : m === 'deepseek' || /-pro(?:-|$)/.test(m) ? 'flagship' : undefined }
  if (/^(?:qwen\/)?qwen(?:\d|[-/]|$)/.test(m)) return { company: 'qwen', capability: m.includes('coder') ? 'balanced' : undefined }
  return {}
}
