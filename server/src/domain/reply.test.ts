import assert from 'node:assert/strict'
import { test } from 'node:test'
import { owesReply, replyReminder } from './reply.ts'
import type { TakenMessage } from './reply.ts'

const fromPerson: TakenMessage = {
  from: 'human', fromKind: 'person', purpose: 'message', wake: 'wake', replyTo: 'human', answersOwnAsk: false, followsOwnMessage: false, answeredInChat: false,
}
const fromAgent: TakenMessage = { ...fromPerson, from: 'scout', fromKind: 'agent', replyTo: 'scout' }

test('a message from a person or an agent is owed a reply until the agent writes in its chat', () => {
  assert.equal(owesReply(fromPerson), true)
  assert.equal(owesReply(fromAgent), true)
  assert.equal(owesReply({ ...fromPerson, answeredInChat: true }), false)
})

test('FYIs, done reports, system notices and answers to the agent\'s own questions owe nothing', () => {
  assert.equal(owesReply({ ...fromPerson, wake: 'fyi' }), false)
  for (const purpose of ['done_report', 'system_notice', 'reply_reminder', 'goal_cycle'] as const) assert.equal(owesReply({ ...fromAgent, purpose }), false, purpose)
  assert.equal(owesReply({ ...fromPerson, answersOwnAsk: true }), false)
})

test('a task is owed a reply like a message', () => {
  assert.equal(owesReply({ ...fromPerson, purpose: 'task' }), true)
  assert.equal(owesReply({ ...fromAgent, purpose: 'task' }), true)
  assert.equal(owesReply({ ...fromPerson, purpose: 'task', answeredInChat: true }), false)
})

test('an agent writing back to this agent is owed nothing; a person writing back still is', () => {
  assert.equal(owesReply({ ...fromAgent, followsOwnMessage: true }), false)
  assert.equal(owesReply({ ...fromPerson, followsOwnMessage: true }), true)
})

test('one reminder names everyone owed, each once, and how to reply to the first', () => {
  assert.equal(replyReminder([{ ...fromPerson, answeredInChat: true }]), null)
  assert.equal(replyReminder([fromPerson, fromPerson]),
    'human\'s message has no reply yet; your terminal is not seen. Reply with `ouro send human "…"` (short, outcome first). If you are still working on it or waiting, say so in one line. This is the only reminder.')
  const group = { ...fromAgent, replyTo: '#team' }
  assert.match(replyReminder([group, fromPerson])!, /^#team and human's messages have no reply yet; .* Reply with `ouro send '#team' "…"`/)
})
