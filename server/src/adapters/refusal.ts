// A model provider's refusal of the input, whichever provider: retrying the same input can't help.

/** The words providers refuse with: Claude's safeguards and usage policy, and OpenAI's. */
const REFUSAL_PATTERN = /safeguards (?:have )?flagged|violates? (?:our|the|anthropic'?s) usage polic|acceptable use polic|\[reasoning_extraction\]|flagged as potentially violating/i

export function readsAsRefusal(text: string): boolean {
  return REFUSAL_PATTERN.test(text)
}
