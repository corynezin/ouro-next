import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SummarizeFailed } from '../adapters/summarizer.ts'
import type { Summarize } from '../adapters/summarizer.ts'
import { agentNameOfAnswer, NAMING_INSTRUCTIONS, suggestAgentName } from './naming.ts'

test("a model's answer becomes a lower-case kebab-case name, or none", () => {
  assert.equal(agentNameOfAnswer('invoice-parser'), 'invoice-parser')
  assert.equal(agentNameOfAnswer('  "Fix Login Bug".\n'), 'fix-login-bug')
  assert.equal(agentNameOfAnswer('heron-watcher\nBecause it watches herons.'), 'heron-watcher')
  assert.equal(agentNameOfAnswer('build-and-verify-tests'), 'build-and-verify', 'at most three words')
  assert.equal(agentNameOfAnswer('internationalization-localization-accessibility'), 'internationalization-localization-access', 'at most 40 characters')
  assert.equal(agentNameOfAnswer('!!'), null)
  assert.equal(agentNameOfAnswer('ab'), null)
  assert.equal(agentNameOfAnswer(''), null)
})

test('the summarizer is asked for a name from the task, and its cost kept', async () => {
  const asked: Parameters<Summarize>[0][] = []
  const summarize: Summarize = async (request) => {
    asked.push(request)
    return { text: 'Duck Counter', costUsd: 0.001 }
  }
  assert.deepEqual(await suggestAgentName(summarize, 'haiku', 'count the ducks', 1_000), { name: 'duck-counter', costUsd: 0.001 })
  assert.deepEqual(asked, [{ model: 'haiku', instructions: NAMING_INSTRUCTIONS, digest: 'count the ducks' }])
})

test('a failed, slow or unusable answer is no suggestion; a failure still counts its cost', async () => {
  const failing: Summarize = async () => { throw new SummarizeFailed('signed out', 0.002) }
  assert.deepEqual(await suggestAgentName(failing, 'haiku', 'task', 1_000), { name: null, costUsd: 0.002 })

  const slow: Summarize = () => new Promise((resolve) => setTimeout(() => resolve({ text: 'too-late', costUsd: 0.001 }), 200))
  assert.deepEqual(await suggestAgentName(slow, 'haiku', 'task', 20), { name: null, costUsd: 0 })

  const unusable: Summarize = async () => ({ text: '?!', costUsd: 0.001 })
  assert.deepEqual(await suggestAgentName(unusable, 'haiku', 'task', 1_000), { name: null, costUsd: 0.001 })
})
