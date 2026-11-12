import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AskEntity, ComputerEntity, PeerAgentDetails, RemoteAgentEntity, RemoteAskEntity } from '@ouro/contract'
import { EntityStore } from '../../core/session/entityStore.ts'
import { agentOf, directChatOf, messageOf, readStateOf, snapshotOf, VIEWER_ADDRESS } from '../../core/testSupport.ts'
import { agentsListModel, searchAgents } from '../agents/model.ts'
import { asksPanel, choicesForMessage } from '../chat/model.ts'
import { openCopyOf } from '../shared/agentFacts.ts'
import { remoteActionsOf, remoteAsksOf, remoteChatModel, remoteListEntries, remoteSend, remoteStatusText } from './model.ts'

const NOW = 10_000_000
const computer = (partial: Partial<ComputerEntity> = {}): ComputerEntity => ({
  id: 'c1', name: 'mac', trust: 'full', status: 'online', lastSeenAt: NOW, release: 'r1', agentsRunning: 1, agentCount: 1,
  incompatibility: null, joinedAt: 1, ...partial,
})
const idle: PeerAgentDetails = { task: 't', model: 'sonnet', state: { state: 'idle', since: 1, generation: 1 }, lastActivityAt: NOW - 3_600_000, summaryLine: null }
const thinking: PeerAgentDetails = {
  ...idle, state: { state: 'in_turn', since: NOW - 5000, generation: 1, turnId: 't', lastOutputAt: NOW, afterTurn: null, activity: { kind: 'thinking' } },
}
const remoteOf = (partial: Partial<RemoteAgentEntity> = {}): RemoteAgentEntity => ({
  id: 'c1:bob', computerId: 'c1', name: 'bob', address: 'bob@mac', activity: 'waiting', details: idle, refreshedAt: NOW, ...partial,
})

test('a remote agent says what it is doing, or that its computer is offline or reconnecting', () => {
  assert.equal(remoteStatusText(remoteOf({ details: thinking, activity: 'running' }), computer()), 'thinking')
  assert.equal(remoteStatusText(remoteOf(), computer()), 'idle')
  assert.equal(remoteStatusText(remoteOf({ details: { ...idle, state: { state: 'stopped', since: 1, stopped: { reason: 'idle' } } } }), computer()), 'stopped')
  assert.equal(remoteStatusText(remoteOf(), computer({ status: 'offline' })), '⊘ mac offline')
  assert.equal(remoteStatusText(remoteOf(), computer({ status: 'reconnecting' })), 'mac reconnecting…')
  assert.equal(remoteStatusText(remoteOf({ details: thinking, activity: 'running' }), computer({ status: 'reconnecting' })), 'thinking', 'activity outranks reconnecting')
  assert.equal(remoteStatusText(remoteOf({ details: null, activity: 'running' }), computer()), 'working', 'limited trust shows only running or waiting')
  assert.equal(remoteStatusText(remoteOf({ details: null }), computer()), 'waiting')
})

test('remote agents sit among local ones by the list order, and fold into Idle only when quiet with details', () => {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({
    agents: [agentOf({ id: 'a', name: 'alice', lastActivityAt: NOW - 60 * 60_000 * 2 })],
    computers: [computer()],
    remoteAgents: [remoteOf(), remoteOf({ id: 'c1:cy', name: 'cy', address: 'cy@mac', details: thinking, activity: 'running' })],
    chats: [directChatOf('d1', 'bob@mac')], readStates: [readStateOf('d1', 0, 0)],
  }))
  const list = agentsListModel(store, { connection: { phase: 'live', detail: '', downSince: null }, fold: { kind: 'never' }, query: '', failureNote: null, now: NOW })
  assert.deepEqual(list.awake.map((listed) => `${listed.kind}:${listed.row.name}`), ['remote:cy', 'remote:bob', 'local:alice'])
  const folded = remoteListEntries(store, { kind: 'after_minutes', minutes: 30 }, NOW)
  assert.deepEqual(folded.map((entry) => [entry.row.name, entry.folded]), [['bob', true], ['cy', false]])
  const [bob] = folded
  assert.equal(bob!.row.computerName, 'mac')
  assert.equal(bob!.row.model, 'sonnet')
  assert.equal(bob!.row.timeText, '1h')
})

test('a limited computer gives no controls; a trusted one gives them as a local agent would', () => {
  assert.deepEqual(remoteActionsOf(remoteOf({ details: null }), computer({ trust: 'limited' })), [])
  assert.deepEqual(remoteActionsOf(remoteOf(), computer({ status: 'offline' })), [])
  assert.deepEqual(remoteActionsOf(remoteOf({ details: thinking }), computer()).map((action) => action.kind), ['interrupt', 'stop'])
  assert.deepEqual(remoteActionsOf(remoteOf(), computer()).map((action) => action.kind), ['stop'])
  const done = remoteOf({ details: { ...idle, state: { state: 'done', since: 1, summary: 'ok' } } })
  assert.deepEqual(remoteActionsOf(done, computer()).map((action) => action.kind), ['archive'])
})

test('its chat is titled by the bare name over its computer, and a message goes to name@machine', () => {
  assert.deepEqual(remoteChatModel(remoteOf(), computer(), 0), { title: 'bob', subtitle: '@mac', statusText: 'idle', statusLabel: 'idle', busy: false, summaryLine: null, canReadLog: true })
  assert.equal(remoteChatModel(remoteOf({ details: null }), computer(), 0).canReadLog, false)
  assert.equal(remoteChatModel(remoteOf({ details: null }), computer(), 0).statusText, 'waiting · That computer trusts this one only to send messages.')
  assert.deepEqual(remoteSend(remoteOf(), 'hi', null), {
    destination: { kind: 'direct', to: 'bob@mac', answersAskId: null }, conversationId: 'c1:bob', text: 'hi', attachments: [],
  })
})

const remoteAskOf = (partial: Partial<RemoteAskEntity> = {}): RemoteAskEntity => ({
  id: 'ask-r', computerId: 'c1', remoteAgentId: 'c1:bob', agentName: 'bob', address: 'bob@mac', level: 'blocked', text: 'Deploy now?\nIt is late.',
  choices: ['Yes', 'No'], at: NOW - 60_000, chatId: 'd1', snooze: null, ...partial,
})
const localAsk = (id: string, level: AskEntity['level'], at: number, snooze: AskEntity['snooze'] = null): AskEntity => ({
  id, agentId: 'a', agentName: 'alice', to: VIEWER_ADDRESS, level, text: `ask ${id}`, choices: [], source: { kind: 'agent' }, at, snooze,
})
const live = { phase: 'live' as const, detail: '', downSince: null }

test("a remote agent's ask shows in Asks by name@machine, ordered with local asks", () => {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({
    agents: [agentOf({ id: 'a', name: 'alice' })],
    computers: [computer()],
    remoteAgents: [remoteOf()],
    asks: [localAsk('waiting', 'waiting', NOW - 120_000), localAsk('urgent', 'urgent', NOW), localAsk('zz', 'urgent', NOW, { kind: 'person_back' })],
    remoteAsks: [remoteAskOf()],
  }))
  const asks = agentsListModel(store, { connection: live, fold: { kind: 'never' }, query: '', failureNote: null, now: NOW }).asks!
  assert.equal(asks.headerText, 'Asks (3)')
  assert.deepEqual(asks.rows.map((row) => [row.askId, row.agentName]), [['urgent', 'alice'], ['ask-r', 'bob@mac'], ['waiting', 'alice'], ['zz', 'alice']])
  const remoteRow = asks.rows[1]!
  assert.deepEqual(remoteRow.asker, { kind: 'remote', remoteAgentId: 'c1:bob' })
  assert.equal(remoteRow.snoozed, false)
  assert.equal(remoteRow.timeText, '1m')
  assert.deepEqual(remoteRow.choices, ['Yes', 'No'])

})

test("its chat shows its asks' copies with their choices, and an answer goes to name@machine with answersAskId", () => {
  const store = new EntityStore()
  const other = remoteAskOf({ id: 'ask-other', remoteAgentId: 'c1:cy', agentName: 'cy', address: 'cy@mac' })
  store.applySnapshot(snapshotOf({ computers: [computer()], remoteAgents: [remoteOf()], remoteAsks: [remoteAskOf(), other] }))
  const bob = store.remoteAgents.get('c1:bob')!
  const asks = remoteAsksOf(store, bob)
  assert.deepEqual(asks.map((ask) => ask.id), ['ask-r'])
  const panel = asksPanel(asks.map(openCopyOf), 'ask-r', NOW)
  assert.deepEqual(panel.rows.map((row) => [row.text, row.choices, row.snoozed, row.answering]), [['Deploy now? It is late.', ['Yes', 'No'], false, true]])

  const posing = messageOf({ seq: 1, chatId: 'd1', from: 'bob@mac', posesAskId: 'ask-r' })
  assert.deepEqual(choicesForMessage(posing, store.remoteAsks), { askId: 'ask-r', options: ['Yes', 'No'] })
  assert.equal(choicesForMessage({ ...posing, posesAskId: 'closed-ask' }, store.remoteAsks), null, 'a closed copy leaves its message plain')

  assert.deepEqual(remoteSend(bob, 'Yes', 'ask-r').destination, { kind: 'direct', to: 'bob@mac', answersAskId: 'ask-r' })
})

test('search finds agents here and on other computers by bare or full name, task, summary, done summary and last message (AG-47)', () => {
  const store = new EntityStore()
  const snapshot = snapshotOf({
    agents: [agentOf({ id: 'a', name: 'alice', task: 'paint', lastActivityAt: NOW - 10 * 60_000 })],
    computers: [computer()],
    remoteAgents: [
      remoteOf({ details: { ...idle, task: 'paint the fence' } }),
      remoteOf({ id: 'c1:dee', name: 'dee', address: 'dee@mac', details: { ...idle, summaryLine: 'painted it', lastActivityAt: NOW - 20 * 60_000 } }),
      remoteOf({ id: 'c1:eve', name: 'eve', address: 'eve@mac', details: { ...idle, state: { state: 'done', since: 1, summary: 'all painted' } } }),
      remoteOf({ id: 'c1:fay', name: 'fay', address: 'fay@mac', details: null }),
    ],
    chats: [{ ...directChatOf('d1', 'fay@mac'), latestMessage: { seq: 1, from: 'fay@mac', at: 1, text: 'Paint arrived' } }],
  })
  store.applySnapshot(snapshot)
  const names = (query: string) => searchAgents(store, query, NOW).map((listed) => `${listed.kind}:${listed.row.name}`)
  assert.deepEqual(names('PAINT'), ['local:alice', 'remote:dee', 'remote:bob', 'remote:eve', 'remote:fay'], 'by the list order within a rank')
  assert.deepEqual(names('bob@'), ['remote:bob'], 'a remote agent by name@computer')
  assert.deepEqual(names(`alice@${snapshot.server.machineName}`), ['local:alice'], 'an agent here by name@this machine')
  assert.deepEqual(names('e'), ['remote:eve', 'local:alice', 'remote:dee', 'remote:bob', 'remote:fay'], 'name prefix, then name containing it, then the rest')
})

test("another computer's agents are rows, its master too; a pinned one leads instead (AG-17)", () => {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({
    computers: [computer()],
    remoteAgents: [remoteOf(), remoteOf({ id: 'c1:master', name: 'master', address: 'master@mac' })],
    pins: [{ id: 'p', target: { kind: 'remote_agent', address: 'bob@mac' }, pinnedAt: 0 }],
  }))
  const list = agentsListModel(store, { connection: { phase: 'live', detail: '', downSince: null }, fold: { kind: 'never' }, query: '', failureNote: null, now: NOW })
  assert.deepEqual(list.awake.map((listed) => listed.row.name), ['master'])
  assert.deepEqual(list.pinned.map((row) => row.kind === 'remote' && row.row.name), ['bob'])
})

test("a remote ask's copy snoozed from either computer: last in Asks with its wake time", () => {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({
    agents: [agentOf({ id: 'a', name: 'alice' })],
    computers: [computer()],
    remoteAgents: [remoteOf()],
    asks: [localAsk('waiting', 'waiting', NOW - 120_000)],
    remoteAsks: [remoteAskOf({ level: 'urgent', snooze: { kind: 'until', at: NOW + 3_600_000 } })],
  }))
  const asks = agentsListModel(store, { connection: live, fold: { kind: 'never' }, query: '', failureNote: null, now: NOW }).asks!
  assert.equal(asks.headerText, 'Asks (1)')
  assert.deepEqual(asks.rows.map((row) => [row.askId, row.snoozed]), [['waiting', false], ['ask-r', true]])
  assert.match(asks.rows[1]!.timeText, /^zz /)
  assert.deepEqual(openCopyOf(remoteAskOf({ snooze: { kind: 'person_back' } })).snooze, { kind: 'person_back' })
})

test("an agent whose computer is offline has the offline tone: orange line, dimmed row (AG-31, AG-35)", () => {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf({ computers: [computer({ status: 'offline' })], remoteAgents: [remoteOf({ details: thinking, activity: 'running' })] }))
  const [entry] = remoteListEntries(store, { kind: 'never' }, NOW)
  assert.equal(entry!.row.statusTone, 'offline')
  assert.equal(entry!.row.statusText, '⊘ mac offline')
})

test('its chat runs a timer while it works and shows its latest summary, as a local agent\'s does', () => {
  const working = remoteChatModel(remoteOf({ details: { ...thinking, summaryLine: 'Fixing the build' }, activity: 'running' }), computer(), NOW)
  assert.equal(working.statusText, 'thinking  0:05')
  assert.equal(working.statusLabel, 'thinking', 'held steady by its status, not the ticking timer')
  assert.equal(working.busy, true)
  assert.equal(working.summaryLine, 'Fixing the build')
  const offline = remoteChatModel(remoteOf({ details: thinking, activity: 'running' }), computer({ status: 'offline' }), NOW)
  assert.equal(offline.statusText, '⊘ mac offline', 'no timer for a computer that is not answering')
})
