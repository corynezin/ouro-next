import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogModel, launchModelFor, runtimeOf } from './models.ts'

test('a model is run by its provider; an unknown name is a Claude model by that name', () => {
  assert.equal(catalogModel('deepseek').provider, 'openrouter')
  assert.equal(catalogModel('deepseek').providerModelId, 'deepseek/deepseek-v4-pro')
  assert.equal(catalogModel('haiku').provider, 'anthropic')
  assert.deepEqual(catalogModel('fable'), { id: 'fable', label: 'Claude Fable', provider: 'anthropic', providerModelId: 'claude-fable-5-2' })
  assert.deepEqual(catalogModel('claude-opus-5-5'), { id: 'claude-opus-5-5', label: 'claude-opus-5-5', provider: 'anthropic', providerModelId: 'claude-opus-5-5' })
  assert.equal(catalogModel('stand-in').provider, 'stand_in')
})

test('an OpenRouter model without OpenRouter set up runs on the fallback, and says what it replaced', () => {
  assert.deepEqual(launchModelFor('deepseek', { openrouter: true }), { model: catalogModel('deepseek'), fallbackFrom: null })
  const fallback = launchModelFor('deepseek', { openrouter: false })
  assert.equal(fallback.model.id, 'sonnet')
  assert.equal(fallback.fallbackFrom?.id, 'deepseek')
  assert.equal(launchModelFor('opus', { openrouter: false }).fallbackFrom, null)
})

test("OpenAI's models are known by name and run in Codex; OpenRouter's run in Claude Code", () => {
  assert.equal(catalogModel('gpt-6-luna').provider, 'openai')
  assert.equal(catalogModel('codex-mini').provider, 'openai')
  assert.equal(runtimeOf(catalogModel('gpt-6-luna').provider), 'codex')
  assert.equal(runtimeOf(catalogModel('deepseek').provider), 'claude_code')
  assert.equal(runtimeOf(catalogModel('sonnet').provider), 'claude_code')
  assert.equal(launchModelFor('gpt-6-luna', { openrouter: false }).fallbackFrom, null, 'no fallback: a Codex agent waits for ChatGPT')
})
