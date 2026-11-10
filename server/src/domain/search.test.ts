import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containsEveryWord, excerptAround, searchWords } from './search.ts'

test('a query is its words, in any case, each once', () => {
  assert.deepEqual(searchWords('  Deploy the  BUILD deploy '), ['deploy', 'the', 'build'])
  assert.deepEqual(searchWords('   '), [])
})

test('a message matches when it holds every word, anywhere', () => {
  assert.equal(containsEveryWord('The build is GREEN now', ['green', 'build']), true)
  assert.equal(containsEveryWord('The build is red', ['green', 'build']), false)
})

test('the excerpt is one line around the first matched word, cut with …, and the match keeps its case', () => {
  const long = `${'a '.repeat(200)}the Deploy went\nfine ${'b '.repeat(200)}`
  const { excerpt, match } = excerptAround(long, ['deploy'])
  assert.equal(match, 'Deploy')
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'))
  assert.ok(excerpt.includes('the Deploy went fine'), 'one line')
  assert.ok(excerpt.length <= 202)
  assert.deepEqual(excerptAround('short and Sweet', ['sweet', 'short']), { excerpt: 'short and Sweet', match: 'short' })
  // Near the end, the window keeps its full width instead of cutting short.
  const nearEnd = excerptAround(`${'x'.repeat(300)} target`, ['target'])
  assert.ok(nearEnd.excerpt.endsWith('target') && nearEnd.excerpt.startsWith('…'))
})
