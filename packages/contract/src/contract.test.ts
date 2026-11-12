import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  AgentState, Change, CommandRequest, commands, displayStateOf, parseAddress, PeerMessage, pinTargetKey, PROVIDER_SESSION_ID_PATTERN, receiptOf, SyncFrame,
} from './index.ts'
import type { MessageEntity } from './index.ts'

const reachable = { reachable: true }

test('a tool call displays as running that tool', () => {
  const state = AgentState.parse({ state: 'in_turn', since: 1, generation: 1, turnId: 't', activity: { kind: 'tool', toolName: 'Bash' }, lastOutputAt: 1, afterTurn: null })
  assert.deepEqual(displayStateOf(state, reachable), { display: 'running', activity: 'running_tool', toolName: 'Bash' })
})

test('an unreachable machine outranks every state of its agents', () => {
  const state = AgentState.parse({ state: 'idle', since: 1, generation: 1 })
  assert.deepEqual(displayStateOf(state, { reachable: false }), { display: 'offline' })
})

test('a hold displays as stopped with the hold as its reason', () => {
  const state = AgentState.parse({ state: 'held', since: 1, hold: 'credits', retryAt: 10 })
  assert.deepEqual(displayStateOf(state, reachable), { display: 'stopped', reason: 'credits' })
})

test('addresses parse into owner, person and agent', () => {
  assert.deepEqual(parseAddress('human'), { kind: 'owner' })
  assert.deepEqual(parseAddress('human@sam'), { kind: 'person', person: 'sam' })
  assert.deepEqual(parseAddress('alice'), { kind: 'agent', agentName: 'alice', machine: null })
  assert.deepEqual(parseAddress('alice@mac'), { kind: 'agent', agentName: 'alice', machine: 'mac' })
})

const messageAt10 = (state: MessageEntity['deliveries'][number]['state']): Pick<MessageEntity, 'at' | 'deliveries' | 'remoteDeliveries'> => ({
  at: 10,
  deliveries: [{ recipient: 'alice', recipientAgentId: 'a1', wake: 'wake', state }],
  remoteDeliveries: [],
})

test('receipts distinguish queued, delivered and read', () => {
  assert.equal(receiptOf({ at: 10, deliveries: [], remoteDeliveries: [] }, null), 'sent')
  assert.equal(receiptOf(messageAt10({ state: 'queued', since: 10, possiblySeen: false }), 50), 'queued')
  // With the runner but not yet in the conversation, as mid-turn: still queued, even while the agent goes on writing.
  assert.equal(receiptOf(messageAt10({ state: 'handed_to_runner', since: 11, turnId: 't', attemptId: 'x', possiblySeen: false }), 12), 'queued')
  assert.equal(receiptOf(messageAt10({ state: 'taken_in', since: 11, turnId: 't', attemptId: 'x', possiblySeen: false }), 5), 'delivered')
  assert.equal(receiptOf(messageAt10({ state: 'taken_in', since: 11, turnId: 't', attemptId: 'x', possiblySeen: false }), 12), 'read')
  assert.equal(receiptOf(messageAt10({ state: 'undeliverable', at: 11, reason: 'archived' }), 12), 'undeliverable')
})

test("a recipient on another machine reads as queued until that machine has it, then delivered", () => {
  const remote = (state: MessageEntity['remoteDeliveries'][number]['state']) => ({ at: 10, deliveries: [], remoteDeliveries: [{ recipient: 'bob@beta', state }] })
  assert.equal(receiptOf(remote({ state: 'queued', since: 10, attempts: 3 }), null), 'queued')
  assert.equal(receiptOf(remote({ state: 'accepted', at: 11 }), null), 'delivered')
  assert.equal(receiptOf(remote({ state: 'undeliverable', at: 11, reason: 'no agent named bob' }), null), 'undeliverable')
})

test('a change validates by entity and refuses a mismatched value', () => {
  const deleted = Change.parse({ cursor: 3, entity: 'ask', id: 'a', op: 'delete' })
  assert.equal(deleted.op, 'delete')
  assert.throws(() => Change.parse({ cursor: 3, entity: 'ask', id: 'a', op: 'upsert', value: { nonsense: true } }))
})

test('sync frames are a closed set', () => {
  assert.equal(SyncFrame.parse({ frame: 'caught_up', cursor: 0 }).frame, 'caught_up')
  assert.throws(() => SyncFrame.parse({ frame: 'mystery' }))
})

test('a command needs an idempotency key', () => {
  const request = CommandRequest(commands.interrupt_agent.input)
  assert.throws(() => request.parse({ input: { agentId: 'a' } }))
  assert.equal(request.parse({ idempotencyKey: '12345678', input: { agentId: 'a' } }).input.agentId, 'a')
})

test('a message from a peer older than protocol 3 answers no ask', () => {
  const fromProtocol2 = { messageId: 'm1', from: { kind: 'owner' }, to: 'helper', text: 'yes', wake: 'wake', purpose: 'message', sentAt: 1 }
  assert.equal(PeerMessage.parse(fromProtocol2).answersAskId, null)
  assert.equal(PeerMessage.parse({ ...fromProtocol2, answersAskId: 'ask-1' }).answersAskId, 'ask-1')
})

test('a pin target is the same as another exactly when its key is', () => {
  assert.equal(pinTargetKey({ kind: 'agent', agentId: 'x' }), pinTargetKey({ kind: 'agent', agentId: 'x' }))
  assert.notEqual(pinTargetKey({ kind: 'agent', agentId: 'x' }), pinTargetKey({ kind: 'chat', chatId: 'x' }))
  assert.notEqual(pinTargetKey({ kind: 'remote_agent', address: 'x@a' }), pinTargetKey({ kind: 'remote_agent', address: 'x@b' }))
})

test("a moved conversation's session id is a plain name: one that could leave its folder is refused", () => {
  assert.ok(PROVIDER_SESSION_ID_PATTERN.test(randomUUID()))
  for (const id of ['../x', 'a/b', 'a\\b', '', '..']) assert.equal(PROVIDER_SESSION_ID_PATTERN.test(id), false, id)
})
