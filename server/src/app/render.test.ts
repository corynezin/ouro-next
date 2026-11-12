import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderConversationSeed, renderForModel } from './render.ts'

const message = { from: 'human', relayedBy: null, text: 'the build is green', purpose: 'message' as const, attachmentPaths: [] }

test('a group post names the group and its sender, and says when it is only an FYI', () => {
  assert.equal(renderForModel(message, { wake: 'fyi', possiblySeen: false }, { groupHandle: '#team' }), '[fyi] [#team from human] the build is green')
  assert.equal(renderForModel(message, { wake: 'wake', possiblySeen: false }, { groupHandle: '#team' }), '[#team from human] the build is green')
  assert.equal(renderForModel(message, { wake: 'wake', possiblySeen: false }, { groupHandle: null }), '[human] the build is green')
})

test("a person's words relayed by an agent say which agent carried them", () => {
  assert.equal(renderForModel({ ...message, relayedBy: 'concierge' }, { wake: 'wake', possiblySeen: false }, { groupHandle: null }), '[human via concierge] the build is green')
})

test('a fresh session is told it starts with an empty memory, given its task and recent messages, and how to find older ones', () => {
  const seed = renderConversationSeed({ task: 'Tidy the notes', recent: [{ from: 'human', at: Date.UTC(2026, 10, 9, 8, 30), text: 'and the beans' }], previousEndedOnRefusal: false })
  assert.match(seed, /could not be continued, so this is a new session and you start with an empty memory/)
  assert.match(seed, /Your task: Tidy the notes/)
  assert.match(seed, /2026-11-09 08:30 \[human\] and the beans/)
  assert.match(seed, /find them with `ouro search <words>`/)
})
