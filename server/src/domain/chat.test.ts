import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentNames, mentionedMembers, personNames } from './chat.ts'

const members = [
  { address: 'fixer', names: agentNames('fixer', 'alpha') },
  { address: 'fixer-two', names: agentNames('fixer-two', 'alpha') },
  { address: 'human', names: personNames({ address: 'human', name: 'Ada' }) },
  { address: 'human@ann', names: personNames({ address: 'human@ann', name: 'Ann' }) },
]

test('an @mention calls a member by name, full address or person name; anything else calls no one', () => {
  assert.deepEqual([...mentionedMembers('@fixer can you look?', members)], ['fixer'])
  assert.deepEqual([...mentionedMembers('thanks @fixer.', members)], ['fixer'], 'trailing punctuation is not part of the name')
  assert.deepEqual([...mentionedMembers('@fixer-two and @FIXER@alpha', members)], ['fixer', 'fixer-two'])
  assert.deepEqual([...mentionedMembers('@ada, @human@ann', members)], ['human', 'human@ann'])
  assert.deepEqual([...mentionedMembers('fixer, mail me at a@b.c, @nobody', members)], [])
  assert.deepEqual([...mentionedMembers('@fixer@beta', members)], [], "another machine's fixer is not this one")
})

test('@human calls every person and no agent', () => {
  assert.deepEqual([...mentionedMembers('@human look', members)], ['human', 'human@ann'])
})
