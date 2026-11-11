import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEntity, AskEntity, ComputerEntity, GoalEntity, GoalWait, ModelOption, ReadStateEntity } from '@ouro/contract'
import { MASTER_AGENT_NAME } from '@ouro/contract'
import { EntityStore } from '../core/session/entityStore.ts'
import { agentOf, directChatOf as chat, messageOf, readStateOf, snapshotOf, VIEWER_ADDRESS } from '../core/testSupport.ts'
import type { OutboxEntry } from '../core/session/outbox.ts'
import { agentsListModel, goalColorOf, goalMarkerOf, otherServersUnreadTotal, searchAgents, swipeActionsOf } from './agents/model.ts'
import type { AgentRowModel, ListedRow } from './agents/model.ts'
import {
  asksPanel, asksStrip, ChoiceTapGuard, chatItems, choicesForMessage, composedFilesOf, composerPlaceholder, directSend, historyFooter, foldDoneReports, goalBar, messageFiles, outboxBubble,
  recipientLastOutputOf, routedAgents, statusBar, summaryBar, chatMoreMenu, FAILED_SEND_ACTIONS, nextUnreadLabel, STOP_COPY,
} from './chat/model.ts'
import { canStartAgent, hasPromptCache, machineFooter, machineOptions, modelGroups, modelName, newAgentInput, newRemoteAgentInput, typedAgentName } from './newAgent/model.ts'
import { LOG_COPY, LOG_FOLLOW_EVERY_MS, LogReader, logLine } from './log/model.ts'
import { archivedRows, unarchivedNote } from './archived/model.ts'
import { branchMergeText, DETAILS_COPY, detailsModel, screensAboutAgent } from './details/model.ts'
import { canSetGoal, GOAL_COPY, goalChangeNote, goalScreenModel, intervalText, setGoalInput } from './goal/model.ts'
import { allSummariesModel, NO_SUMMARY_YET_IN_LIST, SummariesReader, summariesModel, summariesTitle } from './summaries/model.ts'
import { FILE_COPY, sharedFileName } from './file/model.ts'
import {
  agentByRef, askSnoozeText, listOrder, nextCycleLine, nextUnread, shownConnection, sortAsks, stateDotOf, statusLine, unreadElsewhereCount,
  memberLabel, quickSnooze, snoozeChoices,
} from './shared/agentFacts.ts'

const NOW = 10_000_000_000
const inTurn = (since = NOW - 5000, tool?: string): AgentEntity['state'] => ({
  state: 'in_turn', since, generation: 1, turnId: 't', lastOutputAt: since, afterTurn: null, activity: tool ? { kind: 'tool', toolName: tool } : { kind: 'thinking' },
})
const stopped: AgentEntity['state'] = { state: 'stopped', since: 1, stopped: { reason: 'idle' } }
const done: AgentEntity['state'] = { state: 'done', since: 1, summary: 'all good' }
const live = { phase: 'live' as const, detail: '', downSince: null }

function ask(id: string, agentId: string, level: AskEntity['level'], at: number, snooze: AskEntity['snooze'] = null, choices: string[] = []): AskEntity {
  return { id, agentId, agentName: agentId, to: VIEWER_ADDRESS, level, text: `ask ${id}\nmore`, choices, source: { kind: 'agent' }, at, snooze }
}
function goal(agentId: string, status: GoalEntity['status'], kind: GoalEntity['kind'] = { kind: 'finishing' }): GoalEntity {
  return { id: agentId, agentId, text: 'the goal', kind, status, cycleCount: 12, interval: { kind: 'default', seconds: 30 }, costUsd: 0, setBy: VIEWER_ADDRESS, setAt: 0, notes: '' }
}
function storeWith(partial: Parameters<typeof snapshotOf>[0]) {
  const store = new EntityStore()
  store.applySnapshot(snapshotOf(partial))
  return store
}
const noUnreadDefaults = { connection: live, fold: { kind: 'never' as const }, query: '', failureNote: null, now: NOW }
const localRows = (rows: readonly ListedRow[]): AgentRowModel[] => rows.flatMap((listed) => (listed.kind === 'local' ? [listed.row] : []))

test('a row shows only pay-as-you-go spend: an OpenRouter agent\'s cost, never a subscription\'s or a zero', () => {
  const server = snapshotOf().server
  const models = [{ id: 'deepseek', label: 'DeepSeek', provider: 'openrouter' as const, available: true }, { id: 'sonnet', label: 'Sonnet', provider: 'anthropic' as const, available: true }]
  const store = storeWith({
    server: { ...server, models },
    agents: [
      agentOf({ id: 'or', name: 'or', model: 'deepseek', costUsd: 0.42 }),
      agentOf({ id: 'or0', name: 'or0', model: 'deepseek', costUsd: 0 }),
      agentOf({ id: 'sub', name: 'sub', model: 'sonnet', costUsd: 0.001 }),
    ],
  })
  const cost = Object.fromEntries(localRows(agentsListModel(store, noUnreadDefaults).awake).map((row) => [row.agentId, row.costText]))
  assert.deepEqual(cost, { or: '$0.42', or0: null, sub: null })
})

// ---- status line ----

test('the status line follows the reference priority', () => {
  const line = (partial: Partial<AgentEntity>) => statusLine(agentOf({ id: 'a', name: 'a', ...partial }), undefined, VIEWER_ADDRESS, NOW)
  assert.equal(line({ state: inTurn() }), 'thinking')
  assert.equal(line({ state: inTurn(NOW, 'Bash') }), 'running Bash')
  assert.equal(line({ interruptedBy: VIEWER_ADDRESS }), 'interrupted by you')
  assert.equal(line({ interruptedBy: 'boss' }), 'interrupted by boss')
  assert.equal(line({ state: inTurn(), interruptedBy: VIEWER_ADDRESS }), 'thinking', 'live activity outranks an earlier interrupt')
  assert.equal(line({ state: done }), 'done')
  assert.equal(line({ state: stopped }), 'stopped')
  const crash = (consecutiveCrashes: number, relaunch: { kind: 'at'; at: number } | { kind: 'on_message' } | { kind: 'gave_up'; why: string }) =>
    ({ state: 'stopped' as const, since: NOW, stopped: { reason: 'crash' as const, consecutiveCrashes, relaunch } })
  const cold = { expiresAt: NOW - 1, tokens: 120_500, compacted: false }
  assert.equal(line({ state: crash(1, { kind: 'at', at: NOW + 12_000 }), cache: cold }), 'stopped · crashed, retrying in 12 s', 'the cause outranks the cache')
  assert.equal(line({ state: crash(3, { kind: 'on_message' }) }), 'stopped · crashed 3×, a message restarts it')
  assert.equal(line({ state: crash(5, { kind: 'gave_up', why: 'crash loop' }) }), 'stopped · crashed 5×, gave up: crash loop')
  assert.equal(line({ state: { state: 'held', since: NOW, hold: 'credits', retryAt: null } }), 'stopped · out of credits')
  const refused = { at: NOW, turnId: 't1', failure: { kind: 'model_refused' as const, providerMessage: 'flagged' } }
  assert.equal(line({ state: { state: 'stopped', since: NOW, stopped: { reason: 'idle' } }, lastTurnFailure: refused, cache: cold }), 'stopped · the model refused its last message', 'as a refusal leaves it')
  assert.equal(line({ lastTurnFailure: refused }), 'idle · the model refused its last message')
  assert.equal(line({ state: inTurn(), lastTurnFailure: refused }), 'thinking', 'a new turn outranks it')
  assert.equal(line({ state: stopped, cache: cold }), 'stopped · cache cold · 120k to rewrite')
  assert.equal(line({}), 'idle')
  assert.equal(line({ cache: { expiresAt: NOW + 41.5 * 60_000, tokens: 1, compacted: false } }), 'idle · cache warm · 42m left')
  assert.equal(line({ cache: { expiresAt: NOW + 59 * 60_000, tokens: 14_000, compacted: true } }), 'idle · compacted · 14k to write')
})

test('between goal cycles counts down, and only for an active goal with a cycle scheduled', () => {
  const active = (nextCycleAt: number | null, waitingFor: GoalWait | null = null) => goal('a', { status: 'active', waitingFor, nextCycleAt, cycleRunning: false })
  assert.equal(nextCycleLine(active(NOW + 25_000), NOW), 'between goal cycles · next in 25 s')
  assert.equal(nextCycleLine(active(NOW + 240_000), NOW), 'between goal cycles · next in 4 min')
  assert.equal(nextCycleLine(active(NOW - 1), NOW), 'between goal cycles · next any moment')
  assert.equal(nextCycleLine(active(null), NOW), null)
  assert.equal(nextCycleLine(active(NOW + 1, { kind: 'agent_unavailable' }), NOW), null)
  assert.equal(nextCycleLine(goal('a', { status: 'paused', by: 'x', reason: null, at: 1 }), NOW), null)
  assert.equal(statusLine(agentOf({ id: 'a', name: 'a' }), active(NOW + 25_000), VIEWER_ADDRESS, NOW), 'between goal cycles · next in 25 s')
})

test('the state dot: busy, running idle, done, stopped', () => {
  assert.equal(stateDotOf(agentOf({ id: 'a', name: 'a', state: inTurn() })), 'busy')
  assert.equal(stateDotOf(agentOf({ id: 'a', name: 'a' })), 'running')
  assert.equal(stateDotOf(agentOf({ id: 'a', name: 'a', state: done })), 'done')
  assert.equal(stateDotOf(agentOf({ id: 'a', name: 'a', state: stopped })), 'stopped')
  assert.equal(stateDotOf(agentOf({ id: 'a', name: 'a', state: { state: 'held', since: 1, hold: 'credits', retryAt: null } })), 'stopped')
})

// ---- order ----

test('agents in a turn or active in the last minute sit on top by name; the rest by latest activity', () => {
  const store = storeWith({ agents: [
    agentOf({ id: '1', name: 'zed', lastActivityAt: NOW - 10_000 }),
    agentOf({ id: '2', name: 'amy', lastActivityAt: NOW - 30_000 }),
    agentOf({ id: '3', name: 'old', lastActivityAt: NOW - 5 * 3_600_000 }),
    agentOf({ id: '4', name: 'mid', lastActivityAt: NOW - 3_600_000 }),
    agentOf({ id: '5', name: 'busy', lastActivityAt: 1, state: inTurn() }),
  ] })
  assert.deepEqual(listOrder(store, { kind: 'never' }, NOW).awake.map((a) => a.name), ['amy', 'busy', 'zed', 'mid', 'old'])
})

test('folding: quiet longer than the chosen time with nothing running, unread or waiting', () => {
  const quiet = { lastActivityAt: NOW - 2 * 3_600_000 }
  const c = chat('c1', 'unread')
  const store = storeWith({
    chats: [c],
    readStates: [readStateOf('c1', 0, 3)],
    agents: [
      agentOf({ id: '1', name: 'quiet', ...quiet }),
      agentOf({ id: '2', name: 'recent', lastActivityAt: NOW - 60_000 }),
      agentOf({ id: '3', name: 'unread', ...quiet }),
      agentOf({ id: '4', name: 'waiting', ...quiet, queuedDeliveries: 1 }),
      agentOf({ id: '5', name: 'busy', ...quiet, state: inTurn() }),
    ],
  })
  const idleNames = (fold: Parameters<typeof listOrder>[1]) => listOrder(store, fold, NOW).idle.map((a) => a.name)
  assert.deepEqual(idleNames({ kind: 'after_minutes', minutes: 60 }), ['quiet'])
  assert.deepEqual(idleNames({ kind: 'never' }), [])
  assert.deepEqual(idleNames({ kind: 'server_default' }), ['quiet'], 'the server default is 30 minutes in this snapshot')
  assert.deepEqual(idleNames({ kind: 'after_minutes', minutes: 600 }), [])
})

test('archived agents are not listed, and an archived namesake never wins a link', () => {
  const archived = agentOf({ id: 'old', name: 'alice', state: { state: 'archived', since: 1 } })
  const current = agentOf({ id: 'new', name: 'alice' })
  const store = storeWith({ agents: [archived, current] })
  assert.deepEqual(localRows(agentsListModel(store, noUnreadDefaults).awake).map((r) => r.agentId), ['new'])
  assert.equal(agentByRef(store, 'alice')?.id, 'new')
  assert.equal(agentByRef(store, 'old')?.id, 'old')
  assert.equal(agentByRef(storeWith({ agents: [archived] }), 'alice')?.id, 'old')
})

test('done agents sit among the others by their latest activity, not in a section of their own (AG-44)', () => {
  const store = storeWith({ agents: [
    agentOf({ id: '1', name: 'older', lastActivityAt: NOW - 10 * 60_000 }),
    agentOf({ id: '2', name: 'finished', state: { state: 'done', since: NOW - 5 * 60_000, summary: 'ok' }, lastActivityAt: NOW - 5 * 60_000 }),
    agentOf({ id: '3', name: 'newer', lastActivityAt: NOW - 2 * 60_000 }),
  ] })
  const model = agentsListModel(store, noUnreadDefaults)
  assert.deepEqual(localRows(model.awake).map((row) => row.name), ['newer', 'finished', 'older'])
  assert.deepEqual(model.idle, [])
})

// ---- asks ----

test('asks of the same level raised at the same moment go by lowest id (AG-19)', () => {
  const store = storeWith({ agents: [agentOf({ id: 'a', name: 'a' })], asks: [ask('k2', 'a', 'waiting', 10), ask('k1', 'a', 'waiting', 10), ask('k3', 'a', 'blocked', 10)] })
  assert.deepEqual(agentsListModel(store, noUnreadDefaults).asks!.rows.map((row) => row.askId), ['k3', 'k1', 'k2'])
})

test('asks: not snoozed first, then level, then oldest; master excluded; header counts open only', () => {
  const master = agentOf({ id: 'master', name: 'master' })
  const asks = [
    ask('late', 'a', 'waiting', 50),
    ask('early', 'a', 'waiting', 10),
    ask('urgent', 'b', 'urgent', 90),
    ask('zz', 'b', 'urgent', 1, { kind: 'until', at: NOW + 1000 }),
    ask('mine', 'master', 'urgent', 1),
  ]
  const store = storeWith({ agents: [master, agentOf({ id: 'a', name: 'a' }), agentOf({ id: 'b', name: 'b' })], asks })
  const section = agentsListModel(store, noUnreadDefaults).asks!
  assert.deepEqual(section.rows.map((r) => r.askId), ['urgent', 'early', 'late', 'zz'])
  assert.equal(section.headerText, 'Asks (3)')
  assert.equal(section.headerTone, 'orange')
  assert.equal(section.rows[0]!.text, 'ask urgent more')
  assert.equal(section.rows[0]!.symbolName, 'exclamationmark.octagon.fill')
  assert.equal(section.rows.at(-1)!.snoozed, true)
})

test('all asks snoozed reads as such; an expired snooze counts as open', () => {
  const agents = [agentOf({ id: 'a', name: 'a' })]
  const snoozed = agentsListModel(storeWith({ agents, asks: [ask('1', 'a', 'waiting', 1, { kind: 'person_back' })] }), noUnreadDefaults).asks!
  assert.equal(snoozed.headerText, 'Asks (all snoozed)')
  assert.equal(snoozed.headerTone, 'secondary')
  const expired = agentsListModel(storeWith({ agents, asks: [ask('1', 'a', 'waiting', 1, { kind: 'until', at: NOW - 1 })] }), noUnreadDefaults).asks!
  assert.equal(expired.headerText, 'Asks (1)')
})

test('a snooze with no time says what it waits for', () => {
  assert.equal(askSnoozeText(ask('1', 'a', 'waiting', 1, { kind: 'agent_done_or_idle' }), NOW), "zz when it's done")
  assert.equal(askSnoozeText(ask('1', 'a', 'waiting', 1, { kind: 'person_back' }), NOW), "zz when you're back")
})

test('no asks: no section', () => {
  assert.equal(agentsListModel(storeWith({ agents: [agentOf({ id: 'a', name: 'a' })] }), noUnreadDefaults).asks, null)
})

// ---- rows ----

test('an agent row shows what the list needs, and nothing stale', () => {
  const agent = agentOf({ id: 'a', name: 'alice', model: 'deepseek', costUsd: 1.5, runningOldRelease: true, lastActivityAt: NOW - 3 * 3_600_000 })
  const c = { ...chat('c1', 'alice'), latestMessage: { seq: 1, from: VIEWER_ADDRESS, at: 1, text: 'hi\nthere' } }
  const store = storeWith({
    server: { ...snapshotOf().server, models: [{ id: 'deepseek', label: 'DeepSeek', provider: 'openrouter', available: true }] },
    agents: [agent], chats: [c], readStates: [readStateOf('c1', 0, 2)],
    goals: [goal('a', { status: 'paused', by: VIEWER_ADDRESS, reason: null, at: 1 })],
    asks: [ask('1', 'a', 'waiting', 1), ask('2', 'a', 'blocked', 1)],
  })
  const row = localRows(agentsListModel(store, noUnreadDefaults).awake)[0]!
  assert.equal(row.goalMarker, '‖')
  assert.equal(row.goalColor, 'yellow')
  assert.equal(row.costText, '$1.50')
  assert.equal(row.timeText, '3h')
  assert.equal(row.runningOldRelease, true)
  assert.equal(row.previewText, 'you: hi there')
  assert.equal(row.previewLines, 2)
  assert.equal(row.askSymbolName, 'hand.raised.fill')
  assert.equal(row.askCount, 2)
  assert.equal(row.unread, 2)
  assert.equal(row.statusTone, 'quiet')
})

test('a message from the agent has no "you:", and a summary takes the preview down to a line', () => {
  const c = { ...chat('c1', 'alice'), latestMessage: { seq: 1, from: 'alice', at: 1, text: 'done' } }
  const store = storeWith({
    agents: [agentOf({ id: 'a', name: 'alice' })], chats: [c],
    summaries: [{ id: 'a', agentId: 'a', latest: { number: 1, at: 1, line: 'fixed it', details: [], coversThroughAt: 1 }, live: null, lastFailure: null }],
  })
  const row = localRows(agentsListModel(store, noUnreadDefaults).awake)[0]!
  assert.equal(row.previewText, 'done')
  assert.equal(row.previewLines, 1)
  assert.equal(row.summaryLine, 'fixed it')
})

test('master gets the card, not a row; its status is the invitation unless busy', () => {
  const store = storeWith({ agents: [agentOf({ id: 'm', name: 'master' }), agentOf({ id: 'a', name: 'alice' })] })
  const model = agentsListModel(store, noUnreadDefaults)
  assert.deepEqual(localRows(model.awake).map((r) => r.name), ['alice'])
  assert.equal(model.master?.statusText, 'Tell me what you need; I route it')
  const busy = storeWith({ agents: [agentOf({ id: 'm', name: 'master', state: inTurn() })] })
  assert.equal(agentsListModel(busy, noUnreadDefaults).master?.statusText, 'thinking')
})

// ---- search ----

test('search folds case and accents, ranks name prefix first, and includes idle agents and master', () => {
  const store = storeWith({ agents: [
    agentOf({ id: '1', name: 'renee', task: 'x', lastActivityAt: NOW - 86_400_000 }),
    agentOf({ id: '2', name: 'other', task: 'help René with this' }),
    agentOf({ id: '3', name: 'irene', task: 'x' }),
    agentOf({ id: '4', name: 'master', task: 'route to rene' }),
  ] })
  assert.deepEqual(searchAgents(store, 'RENÉ', NOW).map((listed) => listed.row.name), ['renee', 'irene', 'master', 'other'])
  const model = agentsListModel(store, { ...noUnreadDefaults, fold: { kind: 'after_minutes', minutes: 1 }, query: 'zzz' })
  assert.deepEqual(model.search, { rows: [], emptyText: 'No agents match “zzz”.' })
  assert.equal(agentsListModel(store, noUnreadDefaults).search, null)
})

test('search covers the summary, done summary and last message', () => {
  const c = { ...chat('c1', 'a3'), latestMessage: { seq: 1, from: 'a3', at: 1, text: 'the needle' } }
  const store = storeWith({
    chats: [c],
    agents: [agentOf({ id: '1', name: 'a1', state: { state: 'done', since: 1, summary: 'found needle' } }), agentOf({ id: '2', name: 'a2' }), agentOf({ id: '3', name: 'a3' })],
    summaries: [{ id: '2', agentId: '2', latest: { number: 1, at: 1, line: 'needle here', details: [], coversThroughAt: 1 }, live: null, lastFailure: null }],
  })
  assert.deepEqual(searchAgents(store, 'needle', NOW).map((listed) => listed.row.name).sort(), ['a1', 'a2', 'a3'])
})

// ---- empty and bad states ----

test('empty text depends on the connection; master alone still shows the empty text', () => {
  assert.equal(agentsListModel(storeWith({}), noUnreadDefaults).emptyText, 'No agents yet.')
  assert.equal(agentsListModel(storeWith({}), { ...noUnreadDefaults, connection: { phase: 'connecting', detail: '', downSince: NOW } }).emptyText, 'Connecting…')
  assert.equal(agentsListModel(storeWith({ agents: [agentOf({ id: 'a', name: 'a' })] }), noUnreadDefaults).emptyText, null)
})

test('down is connecting for 5 seconds, then offline with the reason, without blinking back', () => {
  const offline = { phase: 'offline' as const, detail: 'no route', downSince: NOW - 4999 }
  assert.equal(shownConnection(offline, NOW), 'connecting')
  assert.equal(shownConnection({ ...offline, downSince: NOW - 5000 }, NOW), 'offline')
  assert.equal(shownConnection({ phase: 'connecting', detail: '', downSince: NOW - 60_000 }, NOW), 'offline', 'a retry mid-outage is still offline')
  const model = agentsListModel(storeWith({}), { ...noUnreadDefaults, connection: { ...offline, downSince: NOW - 60_000 } })
  assert.deepEqual(model.notes, [{ kind: 'offline', text: 'Offline: no route' }])
  assert.equal(model.dotColor, 'red')
})

test('existing data stays visible while offline, and a revoked pairing says so', () => {
  const store = storeWith({ agents: [agentOf({ id: 'a', name: 'a' })] })
  const offline = agentsListModel(store, { ...noUnreadDefaults, connection: { phase: 'offline', detail: '', downSince: NOW - 60_000 } })
  assert.equal(offline.awake.length, 1)
  assert.equal(offline.notes[0]!.text, 'Offline: no connection')
  const revoked = agentsListModel(store, { ...noUnreadDefaults, connection: { phase: 'unpaired', detail: '', downSince: NOW } })
  assert.deepEqual(revoked.notes, [{ kind: 'unpaired', text: 'This server is not paired (or was revoked).' }])
})

test('a failed action adds a note', () => {
  assert.deepEqual(agentsListModel(storeWith({}), { ...noUnreadDefaults, failureNote: 'nope' }).notes, [{ kind: 'failure', text: 'nope' }])
})

// ---- swipes ----

test('swipe actions by state', () => {
  const kinds = (partial: Partial<AgentEntity>, goals: GoalEntity[] = []) =>
    swipeActionsOf(storeWith({ goals }), agentOf({ id: 'a', name: 'a', ...partial })).map((x) => x.kind)
  assert.deepEqual(kinds({ state: inTurn() }), ['interrupt', 'stop'])
  assert.deepEqual(kinds({}), ['stop'])
  assert.deepEqual(kinds({ state: stopped }), ['archive'])
  assert.deepEqual(kinds({ state: done }), ['archive'])
  assert.deepEqual(kinds({}, [goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: false })]), ['pause_goal', 'stop'])
  assert.deepEqual(kinds({}, [goal('a', { status: 'paused', by: 'x', reason: null, at: 1 })]), ['resume_goal', 'stop'])
  assert.deepEqual(kinds({ state: stopped }, [goal('a', { status: 'complete', at: 1, summary: '' })]), ['archive'])
})

// ---- next unread ----

test('next unread: another agent\'s top ask first, then the next unread agent after this one, wrapping', () => {
  const agents = ['a', 'b', 'c'].map((name) => agentOf({ id: name, name }))
  const chats = ['a', 'b', 'c'].map((name) => chat(`c-${name}`, name))
  const unread = (names: string[]): ReadStateEntity[] => names.map((n) => readStateOf(`c-${n}`, 0, 1))
  const noAsks = storeWith({ agents, chats, readStates: unread(['a', 'c']) })
  const [a, b, c] = agents as [AgentEntity, AgentEntity, AgentEntity]
  assert.equal(nextUnread(noAsks, a, agents, NOW)?.name, 'c')
  assert.equal(nextUnread(noAsks, c, agents, NOW)?.name, 'a', 'wraps')
  assert.equal(nextUnread(noAsks, null, agents, NOW)?.name, 'a')
  assert.equal(unreadElsewhereCount(noAsks, a, agents, NOW), 1)

  const withAsks = storeWith({ agents, chats, readStates: unread(['a']), asks: [ask('1', 'b', 'waiting', 1), ask('2', 'c', 'urgent', 5)] })
  assert.equal(nextUnread(withAsks, a, agents, NOW)?.name, 'c')
  assert.equal(nextUnread(withAsks, c, agents, NOW)?.name, 'b', 'its own ask does not count')
  assert.equal(unreadElsewhereCount(withAsks, null, agents, NOW), 3)

  const snoozed = storeWith({ agents, chats, asks: [ask('1', 'b', 'urgent', 1, { kind: 'person_back' })] })
  assert.equal(nextUnread(snoozed, a, agents, NOW), null)
  assert.equal(unreadElsewhereCount(snoozed, a, agents, NOW), 0)
  void b
})

// ---- chat items ----

const mine = (seq: number, deliveries: Parameters<typeof messageOf>[0]['deliveries'] = []) => messageOf({ seq, chatId: 'c', from: VIEWER_ADDRESS, deliveries })
const delivery = (state: NonNullable<Parameters<typeof messageOf>[0]['deliveries']>[number]['state']) => ({ recipient: 'alice', recipientAgentId: 'a', wake: 'wake' as const, state })
const itemsOf = (messages: ReturnType<typeof messageOf>[], outbox: OutboxEntry[] = [], recipientLastOutputAt: number | null = null) =>
  chatItems({ messages, outbox, viewerAddress: VIEWER_ADDRESS, recipientLastOutputAt })

test('receipts come from delivery state and the agent\'s output, not from guesses', () => {
  const receipt = (message: ReturnType<typeof messageOf>, lastOutput: number | null = null) => {
    const item = itemsOf([message], [], lastOutput)[0]!
    return item.kind === 'message' ? item.receiptText : null
  }
  assert.equal(receipt(mine(1)), '→ sent')
  assert.equal(receipt(mine(1, [delivery({ state: 'queued', since: 1, possiblySeen: false })])), '◌ queued')
  assert.equal(receipt(mine(1, [delivery({ state: 'handed_to_runner', since: 1, turnId: 't', attemptId: 'x', possiblySeen: false })]), 1000), '◌ queued')
  assert.equal(receipt(mine(1, [delivery({ state: 'taken_in', since: 1, turnId: 't', attemptId: 'x', possiblySeen: false })])), '→ delivered')
  assert.equal(receipt(mine(1, [delivery({ state: 'taken_in', since: 1, turnId: 't', attemptId: 'x', possiblySeen: false })]), 1000), '✓ read')
  assert.equal(receipt(messageOf({ seq: 1, chatId: 'c', from: 'alice' }), 1000), null, 'theirs have no receipt')
})

test('an undeliverable message says so instead of claiming a receipt', () => {
  const item = itemsOf([mine(1, [delivery({ state: 'undeliverable', at: 2, reason: 'archived' })])])[0]!
  assert.equal(item.kind === 'message' && item.failedText, '⚠ not delivered: archived')
  assert.equal(item.kind === 'message' && item.receiptText, null)
})

test('newest first for the inverted list, with what is still going out newest of all', () => {
  const entry = outboxEntry('k1', 'hi')
  const items = itemsOf([messageOf({ seq: 1, chatId: 'c' }), messageOf({ seq: 2, chatId: 'c' })], [entry])
  assert.deepEqual(items.map((i) => i.key), ['k1', 'm2', 'm1'])
})

test('an outbox entry hides once the stream lists its message, even before the command answers', () => {
  const entry = outboxEntry('k1', 'hi')
  const listed = messageOf({ seq: 1, chatId: 'c', from: VIEWER_ADDRESS, clientKey: 'k1' })
  assert.deepEqual(itemsOf([listed], [entry]).map((i) => i.key), ['m1'])
})

test('a done report close after the previous message folds under it; others stay plain', () => {
  const said = messageOf({ seq: 1, chatId: 'c', at: 0 })
  const closeDone = messageOf({ seq: 2, chatId: 'c', at: 14 * 60_000, purpose: 'done_report', text: 'summary' })
  const folded = foldDoneReports([said, closeDone])
  assert.equal(folded.length, 1)
  assert.equal(folded[0]!.doneReport?.text, 'summary')

  const farDone = { ...closeDone, at: 16 * 60_000 }
  assert.equal(foldDoneReports([said, farDone]).length, 2)
  const otherSender = { ...closeDone, from: 'bob' }
  assert.equal(foldDoneReports([said, otherSender]).length, 2)
  const twoReports = [closeDone, { ...closeDone, seq: 3, id: 'm3' }]
  assert.equal(foldDoneReports(twoReports).length, 2, 'a report does not fold under a report')
  const item = itemsOf([said, closeDone])[0]!
  assert.equal(item.kind === 'message' && item.doneReport?.summary, 'summary')
})

function outboxEntry(key: string, text: string, delivery: OutboxEntry['delivery'] = { state: 'sending' }, attachments: OutboxEntry['attachments'] = []): OutboxEntry {
  return { idempotencyKey: key, destination: { kind: 'direct', to: 'alice', answersAskId: null }, conversationId: 'c', text, attachments, createdAt: 1, delivery }
}

test('outbox bubbles: sending, failed with its reason (which titles the sheet, CHAT-20), and files', () => {
  assert.deepEqual(outboxBubble(outboxEntry('k', 'hi')), { text: 'hi', footnote: 'sending…', failureReason: null, faded: true })
  assert.deepEqual(outboxBubble(outboxEntry('k', 'hi', { state: 'failed', reason: 'no route' })), { text: 'hi', footnote: '⚠ not sent: no route · tap to retry', failureReason: 'no route', faded: false })
  const file = { localId: 'l', uri: 'u', fileName: 'a.png', mimeType: 'image/png', byteLength: 1 }
  assert.equal(outboxBubble(outboxEntry('k', 'hi', undefined, [{ ...file, uploadedAttachmentId: null }, { ...file, fileName: 'b.png', uploadedAttachmentId: 'x' }])).text, 'hi\n📎 a.png\n📎 b.png ✓')
  assert.equal(outboxBubble(outboxEntry('k', '')).text, '📎 0 files')
})

// ---- bars ----

test('goal bar', () => {
  assert.equal(goalBar(undefined), null)
  assert.deepEqual(goalBar(goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: false })), { text: '◎ goal: active · cycle 12', color: 'orange' })
  assert.deepEqual(goalBar(goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: false }, { kind: 'open_ended' })), { text: '∞ goal: active · cycle 12', color: 'orange' })
  assert.deepEqual(goalBar(goal('a', { status: 'active', waitingFor: { kind: 'next_message_after_interrupt' }, nextCycleAt: null, cycleRunning: false })), { text: '◷ goal: waiting: interrupted, until the next message', color: 'yellow' })
  assert.deepEqual(goalBar(goal('a', { status: 'complete', at: 1, summary: '' })), { text: '✓ goal: complete', color: 'secondary' })
})

test('summary bar prefers a newer live line and marks a stale summary', () => {
  const agent = agentOf({ id: 'a', name: 'a', lastActivityAt: NOW - 60_000 })
  const latest = { number: 1, at: NOW - 120_000, line: 'old line', details: [], coversThroughAt: NOW - 120_000 }
  const live = { at: NOW - 1000, line: 'live line', coversThroughAt: NOW - 1000 }
  const summary = (partial: object) => ({ id: 'a', agentId: 'a', latest: null, live: null, lastFailure: null, ...partial })
  assert.equal(summaryBar(summary({}), agent, NOW), null)
  assert.deepEqual(summaryBar(summary({ latest }), agent, NOW), { text: 'old line', ageText: '2m (before its latest turn)' })
  assert.deepEqual(summaryBar(summary({ latest, live }), agent, NOW), { text: 'live line', ageText: 'now' })
  const busy = agentOf({ id: 'a', name: 'a', lastActivityAt: NOW, state: inTurn() })
  assert.deepEqual(summaryBar(summary({ latest }), busy, NOW), { text: 'old line', ageText: '2m' }, 'mid-turn is not stale')
})

test('status bar has a timer while busy', () => {
  const store = storeWith({})
  assert.deepEqual(statusBar(store, agentOf({ id: 'a', name: 'a', state: inTurn(NOW - 65_000) }), live, NOW), { kind: 'agent', dot: 'busy', busy: true, text: 'thinking  1:05' })
  assert.deepEqual(statusBar(store, agentOf({ id: 'a', name: 'a' }), live, NOW), { kind: 'agent', dot: 'running', busy: false, text: 'idle' })
})

test('status bar: a lost connection replaces the stale state once the grace is over, as on the agents list', () => {
  const store = storeWith({})
  const agent = agentOf({ id: 'a', name: 'a' })
  const down = { phase: 'offline' as const, detail: "Couldn't reach your Ouro machine. Try again in a few seconds.", downSince: NOW - 4999 }
  assert.equal(statusBar(store, agent, down, NOW).kind, 'agent', 'within the grace')
  assert.deepEqual(statusBar(store, agent, { ...down, downSince: NOW - 10_000 }, NOW), { kind: 'connection_lost', text: "Offline: Couldn't reach your Ouro machine. Try again in a few seconds." })
  assert.deepEqual(statusBar(store, agent, { phase: 'connecting', detail: '', downSince: NOW - 10_000 }, NOW), { kind: 'connection_lost', text: 'Offline: no connection' }, 'a retry mid-outage')
  assert.deepEqual(statusBar(store, agent, { phase: 'unpaired', detail: '', downSince: NOW }, NOW), { kind: 'connection_lost', text: 'This server is not paired (or was revoked).' })
})

test('asks panel: answering one, the hint, and the placeholder', () => {
  const asks = [ask('x', 'a', 'waiting', 2), ask('y', 'a', 'urgent', 1)]
  const none = asksPanel(asks, null, NOW)
  assert.deepEqual(none.rows.map((r) => r.askId), ['y', 'x'])
  assert.equal(none.hint, 'A reply closes all 2; tap one to answer just it.')
  assert.equal(composerPlaceholder('alice', none.rows), 'Message alice')
  const answering = asksPanel(asks, 'x', NOW)
  assert.equal(answering.hint, null)
  assert.equal(composerPlaceholder('alice', answering.rows), 'Answer ask 2')
  assert.equal(asksPanel([asks[0]!], null, NOW).hint, null)
})

test('a second tap on one ask within 3 seconds is ignored; another ask is separate', () => {
  const guard = new ChoiceTapGuard()
  assert.equal(guard.accept('a', 1000), true)
  assert.equal(guard.accept('a', 3999), false)
  assert.equal(guard.accept('b', 3999), true)
  assert.equal(guard.accept('a', 4000), true)
})

test('choices show on the message that posed an open ask and vanish when it closes', () => {
  const posing = messageOf({ seq: 1, chatId: 'c', posesAskId: 'q' })
  const open = new Map([['q', ask('q', 'a', 'waiting', 1, null, ['yes', 'no'])]])
  assert.deepEqual(choicesForMessage(posing, open), { askId: 'q', options: ['yes', 'no'] })
  assert.equal(choicesForMessage(posing, new Map()), null)
  assert.equal(choicesForMessage(messageOf({ seq: 2, chatId: 'c' }), open), null)
})

// ---- master's chat ----

test('route chips: named agents in order of appearance, whole names only, at most four', () => {
  const names = ['ios', 'ios-push', 'api', 'web', 'db', 'ml']
  const store = storeWith({ agents: [agentOf({ id: 'm', name: 'master' }), ...names.map((name) => agentOf({ id: name, name }))] })
  const routed = (text: string) => routedAgents(text, store, 'm').map((a) => a.name)
  assert.deepEqual(routed('→ api is on it, then `ios`'), ['api', 'ios'])
  assert.deepEqual(routed('asked ios-push'), ['ios-push'], 'not also ios')
  assert.deepEqual(routed('radios and APIs'), [], 'not inside longer words')
  assert.deepEqual(routed('ios@mac handles it'), ['ios'])
  assert.deepEqual(routed('master ios api web db ml'), ['ios', 'api', 'web', 'db'], 'never itself, at most four')
})

test('the strip holds other agents\' open asks only', () => {
  const store = storeWith({
    agents: [agentOf({ id: 'm', name: 'master' }), agentOf({ id: 'a', name: 'a' })],
    asks: [ask('own', 'm', 'urgent', 1), ask('open', 'a', 'waiting', 1), ask('zz', 'a', 'urgent', 1, { kind: 'person_back' })],
  })
  assert.deepEqual(asksStrip(store, NOW).map((x) => x.askId), ['open'])
  assert.deepEqual(sortAsks([], NOW), [])
})

// ---- new agent ----

const option = (id: string, provider: ModelOption['provider'], available = true): ModelOption => ({ id, label: id.toUpperCase(), provider, available })

test('models group by source; unavailable ones are left out unless current', () => {
  const models = [option('opus', 'anthropic'), option('gpt', 'openai', false), option('ds', 'openrouter')]
  assert.deepEqual(modelGroups(models, null).map((g) => g.title), ['Subscription', 'OpenRouter'])
  assert.deepEqual(modelGroups(models, 'gpt').map((g) => g.title), ['Subscription', 'ChatGPT', 'OpenRouter'])
  assert.deepEqual(modelGroups(models, 'custom').at(-1), { title: 'Other', models: [{ id: 'custom', label: 'custom' }] })
})

test('models are named as the reference names them; one it does not name keeps the server label', () => {
  const named = (id: string, provider: ModelOption['provider'], label = `${id} label`) => modelName({ id, label, provider })
  assert.deepEqual(['opus', 'sonnet', 'haiku'].map((id) => named(id, 'anthropic')), ['Opus', 'Sonnet', 'Haiku'])
  assert.deepEqual(['deepseek', 'deepseek-flash', 'qwen-coder', 'gemini-flash', 'or-haiku'].map((id) => named(id, 'openrouter')),
    ['DeepSeek', 'DeepSeek Flash', 'Qwen Coder', 'Gemini Flash', 'Haiku'])
  assert.equal(named('gpt-5-codex', 'openai'), 'GPT-5-Codex')
  assert.equal(named('gpt-6.1-sol', 'openai'), 'GPT-6.1-Sol')
  assert.equal(named('stand-in', 'stand_in', 'Stand-in'), 'Stand-in')
  assert.deepEqual(modelGroups([{ id: 'or-haiku', label: 'Haiku via OpenRouter', provider: 'openrouter', available: true }], null)[0]!.models, [{ id: 'or-haiku', label: 'Haiku' }])
})

test('starting needs a task; a blank name lets the server generate one', () => {
  assert.equal(canStartAgent('  ', false), false)
  assert.equal(canStartAgent('do it', true), false)
  assert.equal(canStartAgent('do it', false), true)
  assert.equal(typedAgentName('my bot '), 'mybot', 'spaces are stripped as the name is typed')
  assert.deepEqual(newAgentInput('do it', '  ', 'opus', '5m'), { task: 'do it', name: null, model: 'opus', folder: null })
  assert.equal(newAgentInput('do it', ' bob ', null, null).name, 'bob')
  const models: ModelOption[] = [
    { id: 'opus', label: 'Opus', provider: 'anthropic', available: true },
    { id: 'gpt', label: 'GPT', provider: 'openai', available: true },
  ]
  assert.equal(hasPromptCache(models, 'opus'), true)
  assert.equal(hasPromptCache(models, 'gpt'), false, 'only Anthropic models offer the picker')
  assert.equal(hasPromptCache(models, null), false)
  assert.equal(newAgentInput('do it', '', 'opus', '1h').promptCacheLifetime, '1h', 'a 1 hour cache is sent')
  assert.equal('promptCacheLifetime' in newAgentInput('do it', '', 'gpt', null), false, 'a model without a cache sends none')
})

test('the Machine picker: here, then fully trusting computers by name; none of them, no picker', () => {
  const computer = (id: string, name: string, trust: ComputerEntity['trust']): ComputerEntity => ({
    id, name, trust, status: 'online', lastSeenAt: NOW, release: 'r1', agentsRunning: 0, agentCount: 0, incompatibility: null, joinedAt: 1,
  })
  assert.deepEqual(machineOptions([computer('c3', 'pi', 'limited')]), [])
  assert.deepEqual(machineOptions([computer('c1', 'mac', 'full'), computer('c2', 'linux', 'full'), computer('c3', 'pi', 'limited')]).map((option) => [option.label, option.computerId]),
    [['Cloud computer', null], ['linux', 'c2'], ['mac', 'c1']])
  assert.equal(machineFooter('mac'), 'It runs on mac and reports to you here.')
  assert.deepEqual(newRemoteAgentInput('c1', 'do it', ' bob ', null, null), { computerId: 'c1', task: 'do it', name: 'bob', model: null, folder: null })
  assert.equal(newRemoteAgentInput('c1', 'do it', '', 'opus', '1h').promptCacheLifetime, '1h', 'a 1 hour cache goes to the other computer too')
})

// ---- sending and files ----

test('a direct send targets the agent, keyed by its id because the chat may not exist yet', () => {
  const agent = agentOf({ id: 'a1', name: 'alice' })
  const file = { localId: 'l', uri: 'file:///x.png', fileName: 'x.png', byteLength: 5, mimeType: 'image/png', isImage: true }
  assert.deepEqual(directSend(agent, 'hi', [file], 'ask1'), {
    destination: { kind: 'direct', to: 'alice', answersAskId: 'ask1' },
    conversationId: 'a1',
    text: 'hi',
    attachments: [{ localId: 'l', uri: 'file:///x.png', fileName: 'x.png', byteLength: 5, mimeType: 'image/png' }],
  })
})

test('Edit on a failed send gets its files back', () => {
  const attachment = { localId: 'l', uri: 'u', fileName: 'a.pdf', mimeType: 'application/pdf', byteLength: 2, uploadedAttachmentId: 'up' }
  assert.deepEqual(composedFilesOf(outboxEntry('k', 'hi', undefined, [attachment])), [{ localId: 'l', uri: 'u', fileName: 'a.pdf', byteLength: 2, mimeType: 'application/pdf', isImage: false }])
})

test('images show inline by their server URL, with the device credentials; other files are named with a size (CHAT-40)', () => {
  const message = messageOf({ seq: 1, chatId: 'c', attachments: [
    { id: 'i1', fileName: 'p.png', mimeType: 'image/png', byteLength: 2048 },
    { id: 'f1', fileName: 'a.pdf', mimeType: 'application/pdf', byteLength: 10 },
  ] })
  const files = messageFiles(message, (id) => `https://s/${id}`, { authorization: 'Bearer t' })
  assert.deepEqual(files[0]!.imageSource, { uri: 'https://s/i1', headers: { authorization: 'Bearer t' } })
  assert.equal(files[0]!.isImage, true)
  assert.equal(files[1]!.imageSource, null)
  assert.equal(files[1]!.fileName, 'a.pdf')
  assert.equal(files[1]!.attachmentId, 'f1', 'a tap opens the File screen on this attachment')
})

test('a shared copy is saved under the file\'s own name, never a path', () => {
  assert.equal(sharedFileName('report.pdf'), 'report.pdf')
  assert.equal(sharedFileName('../a/b\\c.txt'), '.._a_b_c.txt')
  assert.equal(sharedFileName(''), 'file')
  // A failed share says so (CHAT-39); a file the server won't serve shows its status (CHAT-38).
  assert.equal(FILE_COPY.shareFailed, "Couldn't share it")
  assert.equal(FILE_COPY.httpError(404), 'HTTP 404')
})

test('read means the agent has said something since: its last output in a turn, else its last activity', () => {
  assert.equal(recipientLastOutputOf(undefined), null)
  assert.equal(recipientLastOutputOf(agentOf({ id: 'a', name: 'a', lastActivityAt: 7 })), 7)
  assert.equal(recipientLastOutputOf(agentOf({ id: 'a', name: 'a', lastActivityAt: 7, state: inTurn(99) })), 99)
})

// ---- log ----

const logPage = (startCursor: number, endCursor: number, texts: string[], hasEarlier = false) => ({
  records: texts.map((text, index) => ({ kind: 'text' as const, at: index, text })), startCursor, endCursor, hasEarlier,
})

test('log lines read as the terminal log does, with long results cut to six lines', () => {
  const at = new Date(2026, 0, 1, 9, 5, 7).getTime()
  assert.deepEqual(logLine({ kind: 'incoming', at, from: 'ada/human', text: ' hi ' }, 'k'), { key: 'k', text: '09:05:07 → from ada/human: hi', tone: 'incoming' })
  assert.equal(logLine({ kind: 'tool_use', at, toolName: 'Bash', input: 'ls' }, 'k').text, '09:05:07 ▸ Bash: ls')
  assert.equal(logLine({ kind: 'notice', at, text: 'turn done' }, 'k').tone, 'notice')
  const result = logLine({ kind: 'tool_result', at, text: 'a\nb\nc\nd\ne\nf\ng\nh\n', isError: false }, 'k').text
  assert.equal(result, '  ⎿ a\n    b\n    c\n    d\n    e\n    f\n    … 2 more lines')
  // Each kind has its own tone, which the screen colours (LOG-03).
  assert.deepEqual([
    logLine({ kind: 'incoming', at, from: 'x', text: 'hi' }, 'k').tone,
    logLine({ kind: 'text', at, text: 'thinking' }, 'k').tone,
    logLine({ kind: 'tool_use', at, toolName: 'Bash', input: 'ls' }, 'k').tone,
    logLine({ kind: 'tool_result', at, text: 'ok', isError: false }, 'k').tone,
    logLine({ kind: 'notice', at, text: 'turn done' }, 'k').tone,
  ], ['incoming', 'words', 'tool', 'result', 'notice'])
  assert.deepEqual(LOG_COPY, { earlier: 'Earlier', loading: 'Loading…', empty: 'Nothing logged yet.' })
  assert.equal(LOG_FOLLOW_EVERY_MS, 60_000)
})

test('the log reader pages earlier above and follows below, without repeating lines', async () => {
  const pages: Record<string, ReturnType<typeof logPage>> = {
    latest: logPage(100, 200, ['c', 'd'], true),
    'before:100': logPage(0, 100, ['a', 'b']),
    'after:200': logPage(200, 260, ['e']),
    'after:260': logPage(260, 260, []),
  }
  const asked: string[] = []
  const reader = new LogReader({
    read: async (position) => {
      const key = position === null ? 'latest' : 'before' in position ? `before:${position.before}` : `after:${position.after}`
      asked.push(key)
      return { ok: true, value: pages[key]! }
    },
    onChange: () => {},
  })
  const texts = () => reader.state.lines?.map((line) => line.text.split(' ').at(-1))
  assert.equal(reader.state.lines, null)
  await reader.follow()
  assert.deepEqual(texts(), ['c', 'd'])
  assert.equal(reader.state.hasEarlier, true)
  await reader.loadEarlier()
  assert.deepEqual(texts(), ['a', 'b', 'c', 'd'])
  assert.equal(reader.state.hasEarlier, false)
  await reader.loadEarlier()
  await reader.follow()
  await reader.follow()
  assert.deepEqual(texts(), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(asked, ['latest', 'before:100', 'after:200', 'after:260'])
})

test('a failed log read says why and keeps what was shown', async () => {
  let fail = false
  const reader = new LogReader({
    read: async () => (fail ? { ok: false as const, failure: { kind: 'timed_out' as const } } : { ok: true as const, value: logPage(0, 10, ['x']) }),
    onChange: () => {},
  })
  await reader.loadLatest()
  fail = true
  await reader.follow()
  assert.equal(reader.state.lines?.length, 1)
  assert.notEqual(reader.state.failure, null)
  assert.equal(reader.state.loading, false)
})

// ---- archived ----

test('archived agents, newest first, flagged when their name is taken again', () => {
  const store = storeWith({ agents: [
    agentOf({ id: 'old', name: 'alice', task: 'first try', state: { state: 'archived', since: 10 } }),
    agentOf({ id: 'other', name: 'bob', task: '  ', state: { state: 'archived', since: 20 } }),
    agentOf({ id: 'new', name: 'alice' }),
  ] })
  const rows = archivedRows(store)
  assert.deepEqual(rows.map((r) => [r.agentId, r.nameInUse, r.detail]), [['other', false, null], ['old', true, 'first try']])
  assert.equal(unarchivedNote('bob'), 'bob is back (stopped; a message wakes it)')
})

// ---- details ----

test('details rows hide what has no value, and say who in words', () => {
  const agent = agentOf({ id: 'a', name: 'alice', createdBy: VIEWER_ADDRESS, parent: 'master', folder: '/w', costUsd: 0, queuedDeliveries: 2, state: inTurn() })
  const model = detailsModel(storeWith({ agents: [agent] }), agent, NOW)
  assert.deepEqual(model.rows.map((r) => r.label), ['State', 'Now', 'Created by', 'Reports to', 'Folder', 'Started', 'Waiting messages'])
  assert.equal(model.rows.find((r) => r.label === 'Created by')!.value, 'You')
  assert.equal(model.rows.find((r) => r.label === 'Reports to')!.value, 'master')
  assert.equal(model.rows.find((r) => r.label === 'Folder')!.monospaced, true)
  assert.equal(model.canInterrupt, true)
  assert.equal(model.canStop, true)
  const stoppedAgent = { ...agent, state: stopped }
  const stoppedModel = detailsModel(storeWith({ agents: [stoppedAgent] }), stoppedAgent, NOW)
  assert.equal(stoppedModel.canInterrupt, false)
  assert.equal(stoppedModel.canStop, false)
  assert.equal(stoppedModel.mergeable, null, 'no branch, nothing to merge')
})

test('details: the latest summary as Lately with its age, stale once a turn began after it; the task, else a dash; the chats it is in (DET-09, DET-10, DET-11)', () => {
  const agent = agentOf({ id: 'a', name: 'alice', task: '  ' })
  const summary = { id: 'a', agentId: 'a', live: null, lastFailure: null, latest: { number: 1, at: NOW - 3 * 3_600_000, line: 'fixed the build', details: ['ran the tests'], coversThroughAt: NOW - 3 * 3_600_000 } }
  const chats = [chat('d', 'alice'), { ...chat('g', 'alice'), kind: 'group' as const, title: 'Team' }]
  const model = detailsModel(storeWith({ agents: [agent], summaries: [summary], chats }), agent, NOW)
  assert.equal(model.lately?.title, 'Lately · 3h')
  assert.equal(model.lately?.line, 'fixed the build')
  assert.deepEqual(model.lately?.details, ['ran the tests'])
  assert.equal(model.task, '—')
  assert.deepEqual(model.chats.map((found) => found.title).sort(), ['Team', 'You'])
  assert.deepEqual(DETAILS_COPY, { modelFooter: 'Applies from its next start; it keeps its context.', staleSummary: 'before its latest turn', earlierSummaries: 'Earlier summaries', noChats: 'None yet' })
})

test("the model picker's groups are in the reference's order, most capable first (DET-03)", () => {
  const models = ['or-haiku', 'gemini-flash', 'deepseek-flash', 'qwen-coder', 'deepseek', 'haiku', 'sonnet', 'opus'].map((id) => ({ id, label: id, provider: (['opus', 'sonnet', 'haiku'].includes(id) ? 'anthropic' : 'openrouter') as ModelOption['provider'], available: true }))
  assert.deepEqual(modelGroups(models, null).map((group) => [group.title, group.models.map((model) => model.label)]), [
    ['Subscription', ['Opus', 'Sonnet', 'Haiku']],
    ['OpenRouter', ['DeepSeek', 'Qwen Coder', 'DeepSeek Flash', 'Gemini Flash', 'Haiku']],
  ])
})

test('details show the branch, and offer Merge only once it is not running', () => {
  const branch = { name: 'agent/alice', base: 'main' }
  const running = agentOf({ id: 'a', name: 'alice', branch, state: inTurn() })
  const runningModel = detailsModel(storeWith({ agents: [running] }), running, NOW)
  assert.equal(runningModel.rows.find((r) => r.label === 'Branch')?.value, 'agent/alice → main')
  assert.equal(runningModel.mergeable, null)
  const done = { ...running, state: { state: 'done' as const, since: NOW, summary: 'ok' } }
  assert.deepEqual(detailsModel(storeWith({ agents: [done] }), done, NOW).mergeable, { branch: 'agent/alice', base: 'main' })
  assert.equal(branchMergeText({ kind: 'merged', branch: 'agent/alice', base: 'main', how: 'fast_forward' }), 'Merged agent/alice into main.')
  assert.equal(branchMergeText({ kind: 'merged', branch: 'agent/alice', base: 'main', how: 'rebase' }), 'Rebased agent/alice onto main and merged it.')
  assert.equal(branchMergeText({ kind: 'nothing_to_merge', branch: 'agent/alice', base: 'main' }), 'Nothing to merge: main already has agent/alice.')
  assert.equal(branchMergeText({ kind: 'not_merged', branch: 'agent/alice', base: 'main', why: 'a conflict in a.ts' }), 'Not merged: a conflict in a.ts')
})

test('archiving from details leaves every screen about that agent', () => {
  const routes = [{ params: undefined }, { params: { agentRef: 'a1' } }, { params: { agentRef: 'alice' } }]
  assert.equal(screensAboutAgent(routes, { id: 'a1', name: 'alice' }), 2)
  assert.equal(screensAboutAgent([{ params: undefined }, { params: { agentRef: 'bob' } }], { id: 'a1', name: 'alice' }), 1)
})

// ---- goal ----

test('the goal screen: state line, next cycle, kind, intervals and the actions that apply', () => {
  const active = goalScreenModel(goal('a', { status: 'active', waitingFor: null, nextCycleAt: NOW + 25_000, cycleRunning: false }), VIEWER_ADDRESS, NOW)
  assert.equal(active.stateText, '◎ active · cycle 12')
  assert.equal(active.nextCycleText, 'between goal cycles · next in 25 s')
  assert.equal(active.kindText, 'finishes when met')
  assert.deepEqual(active.actions, ['pause', 'edit', 'mark_done', 'clear'])
  assert.deepEqual(active.intervals.map((i) => i.label), ['Default (30s)', '1m', '5m', '10m', '30m', '1h', '2h', '6h', '1d'])
  assert.equal(active.selectedInterval, 0)
  assert.equal(active.intervals[0]!.chosenSeconds, null, 'Default is set as null')
  const chosen = goalScreenModel({ ...goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: true }), interval: { kind: 'chosen', seconds: 90 } }, VIEWER_ADDRESS, NOW)
  assert.deepEqual(chosen.intervals.map((i) => i.label), ['Default', '1m', '90s', '5m', '10m', '30m', '1h', '2h', '6h', '1d'], 'a chosen 90 s joins the choices')
  assert.deepEqual(chosen.intervals[chosen.selectedInterval], { label: '90s', chosenSeconds: 90 })
  const waiting = goalScreenModel(goal('a', { status: 'active', waitingFor: { kind: 'next_message_after_interrupt' }, nextCycleAt: null, cycleRunning: false }), VIEWER_ADDRESS, NOW)
  assert.equal(waiting.stateText, '◷ waiting: interrupted, until the next message')

  const paused = goalScreenModel(goal('a', { status: 'paused', by: VIEWER_ADDRESS, reason: 'lunch', at: NOW }, { kind: 'open_ended' }), VIEWER_ADDRESS, NOW)
  assert.equal(paused.stateText, '‖ paused by you: lunch')
  assert.equal(paused.kindText, 'open-ended (never completes)')
  assert.deepEqual(paused.actions, ['resume', 'edit', 'clear'], 'an open-ended goal is never marked done')

  const complete = goalScreenModel(goal('a', { status: 'complete', at: 1, summary: 'shipped' }, { kind: 'checked', checkCommand: 'npm test' }), VIEWER_ADDRESS, NOW)
  assert.deepEqual(complete.actions, ['reopen', 'edit', 'clear'])
  assert.equal(complete.summary, 'shipped')
  assert.equal(complete.checkCommand, 'npm test')
  assert.equal(GOAL_COPY.doneFooter('npm test'), 'Its check runs first: npm test')
  assert.equal(intervalText(90), '90s')
  assert.equal(canSetGoal('  ', false), false)
})

test('goal notes say what a command did, from the goal it returned', () => {
  const active = goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: false })
  assert.equal(goalChangeNote({ kind: 'set', replaced: false }, 'alice', active), "set alice's goal; it works on it whenever it is idle")
  assert.equal(goalChangeNote({ kind: 'set', replaced: true }, 'alice', { ...active, kind: { kind: 'open_ended' } }), "replaced alice's open-ended goal; it works on it whenever it is idle")
  assert.equal(goalChangeNote({ kind: 'interval' }, 'alice', { ...active, interval: { kind: 'chosen', seconds: 600 } }), "alice's goal cycles now come 10m after it goes idle")
  assert.equal(goalChangeNote({ kind: 'interval' }, 'alice', active), "alice's goal is back to the default interval (30s)")
  assert.equal(goalChangeNote({ kind: 'cleared' }, 'alice', null), "cleared alice's goal (its files are kept); alice stays")
  assert.equal(goalScreenModel({ ...active, costUsd: 1.5 }, VIEWER_ADDRESS, NOW).usedText, '$1.50')
  assert.equal(goalScreenModel(active, VIEWER_ADDRESS, NOW).usedText, null)
})

test('replacing a goal keeps its check and a chosen interval; open-ended drops the check', () => {
  const checked = { ...goal('a', { status: 'active', waitingFor: null, nextCycleAt: null, cycleRunning: false }, { kind: 'checked', checkCommand: 'npm test' }), interval: { kind: 'chosen' as const, seconds: 600 } }
  assert.deepEqual(setGoalInput('a', '  ship it ', false, checked), { agentId: 'a', text: 'ship it', kind: { kind: 'checked', checkCommand: 'npm test' }, intervalSeconds: 600 })
  assert.deepEqual(setGoalInput('a', 'explore', true, checked).kind, { kind: 'open_ended' })
  assert.deepEqual(setGoalInput('a', 'new', false, undefined), { agentId: 'a', text: 'new', kind: { kind: 'finishing' }, intervalSeconds: null })
})

// ---- summaries ----

test('summary cards: latest first under an uppercase date, then earlier, the latest not repeated; the last failure said', () => {
  const latest = { number: 3, at: 300, line: 'now', details: ['a'], coversThroughAt: 300 }
  const entity = { id: 'a', agentId: 'a', latest, live: null, lastFailure: { at: 400, message: 'model busy' } }
  const read = { records: [latest, { number: 1, at: 100, line: 'then', details: [], coversThroughAt: 100 }], hasOlder: false, loading: false, failure: null }
  const model = summariesModel(entity, read)
  assert.deepEqual(model.cards.map((card) => card.line), ['now', 'then'])
  assert.ok(model.cards.every((card) => card.dateText === card.dateText.toUpperCase() && /\d/.test(card.dateText)), 'an uppercase date over each card')
  assert.equal(model.lastAttemptFailedText, 'Last attempt failed: model busy')
  assert.equal(model.emptyText, null)
  const unread = { records: null, hasOlder: false, loading: true, failure: null }
  assert.equal(summariesModel(undefined, unread).loading, true)
  assert.equal(summariesModel(undefined, unread).emptyText, null)
  assert.equal(summariesModel(undefined, { ...unread, records: [], loading: false }).emptyText, 'No summary yet')
  assert.equal(summariesTitle('fixer'), 'fixer: summaries')
  assert.equal(NO_SUMMARY_YET_IN_LIST, 'no summary yet')
  assert.equal(summariesModel(undefined, { ...unread, loading: false, failure: 'request timed out' }).loadFailureText, 'request timed out')
})

test('the summaries reader pages back by number and starts again from the newest on refresh', async () => {
  const record = (number: number) => ({ number, at: number, line: `#${number}`, details: [], coversThroughAt: number })
  const asked: Array<number | null> = []
  let changes = 0
  const reader = new SummariesReader({
    read: async (position) => {
      asked.push(position.beforeNumber)
      if (position.beforeNumber === null) return { ok: true, value: { summaries: [record(5), record(4)], hasOlder: true } }
      return { ok: true, value: { summaries: [record(4), record(3)], hasOlder: false } }
    },
    onChange: () => { changes++ },
  })
  await reader.loadNewest()
  await reader.loadOlder()
  assert.deepEqual(reader.state.records?.map((summary) => summary.number), [5, 4, 3])
  assert.equal(reader.state.hasOlder, false)
  await reader.loadOlder()
  assert.deepEqual(asked, [null, 4])
  await reader.loadNewest()
  assert.deepEqual(reader.state.records?.map((summary) => summary.number), [5, 4])
  assert.ok(changes > 0)
})

test('a failed summaries read keeps what was shown and says why', async () => {
  const reader = new SummariesReader({ read: async () => ({ ok: false, failure: { kind: 'timed_out' } }), onChange: () => {} })
  await reader.loadNewest()
  assert.equal(reader.state.failure, 'request timed out')
  assert.equal(reader.state.records, null)
})

test('the Chats button counts group unread only; direct chats count on agent rows', () => {
  const groupChat = { ...chat('g', 'x'), kind: 'group' as const, title: 'T' }
  const store = storeWith({ agents: [agentOf({ id: 'a', name: 'alice' })], chats: [groupChat, chat('d', 'alice')], readStates: [readStateOf('g', 0, 3), readStateOf('d', 0, 5)] })
  assert.equal(agentsListModel(store, noUnreadDefaults).groupChatUnread, 3)
})

test('snooze choices: delays, tomorrow at 9:00 local time, done, back, and Remind me now only when snoozed', () => {
  const now = new Date(2026, 10, 9, 15, 30).getTime()
  const choices = snoozeChoices(false, now)
  assert.deepEqual(choices.map((choice) => choice.title), [
    'Remind me in 30 minutes', 'Remind me in 1 hour', 'Remind me in 3 hours', 'Remind me in Tomorrow 9:00', "Remind me when it's done", "Remind me when I'm back",
  ])
  assert.deepEqual(choices[1]!.snooze, { kind: 'until', at: now + 60 * 60_000 })
  assert.deepEqual(choices[3]!.snooze, { kind: 'until', at: new Date(2026, 10, 10, 9, 0).getTime() })
  assert.deepEqual(choices[4]!.snooze, { kind: 'agent_done_or_idle' })
  assert.deepEqual(choices[5]!.snooze, { kind: 'person_back' })
  assert.deepEqual(snoozeChoices(true, now).at(-1), { title: 'Remind me now', snooze: null })
  assert.deepEqual(quickSnooze(false, now), { title: 'Snooze 1h', snooze: { kind: 'until', at: now + 60 * 60_000 } })
  assert.deepEqual(quickSnooze(true, now), { title: 'Remind', snooze: null })
})

test("all summaries: every agent in list order with its latest, a stale one marked, and one with none says so", () => {
  const recent = agentOf({ id: 'r', name: 'recent', lastActivityAt: NOW - 1000 })
  const older = agentOf({ id: 'o', name: 'older', lastActivityAt: NOW - 600_000 })
  const latest = { number: 3, at: NOW - 120_000, line: 'did things', details: ['a detail'], coversThroughAt: NOW - 120_000 }
  const store = storeWith({ agents: [older, recent], summaries: [{ id: 'r', agentId: 'r', latest, live: null, lastFailure: null }] })
  assert.deepEqual(allSummariesModel(store, NOW), [
    { agentId: 'r', name: 'recent', dot: 'running', ageText: '2m', latest: { line: 'did things', details: ['a detail'], beforeLatestTurn: true } },
    { agentId: 'o', name: 'older', dot: 'running', ageText: null, latest: null },
  ])
})

test('the top of a chat: Load messages until its first page is here, also after a failed first load; then Earlier messages while older remain', () => {
  assert.deepEqual(historyFooter({ loaded: false, hasOlder: false, loading: true }), { kind: 'loading' })
  assert.deepEqual(historyFooter({ loaded: false, hasOlder: false, loading: false }), { kind: 'button', label: 'Load messages' })
  assert.deepEqual(historyFooter({ loaded: true, hasOlder: true, loading: false }), { kind: 'button', label: 'Earlier messages' })
  assert.equal(historyFooter({ loaded: true, hasOlder: false, loading: false }), null)
})

test('members read as You, a person by name, an agent here by its bare name, one elsewhere as name@node (ROOMS-17)', () => {
  const store = storeWith({ people: [{ id: 'p2', name: 'ada', address: 'human@ada', isOwner: false, joinedAt: 1 }] })
  assert.equal(memberLabel(store, VIEWER_ADDRESS), 'You')
  assert.equal(memberLabel(store, 'human@ada'), 'ada')
  assert.equal(memberLabel(store, 'human@bea'), 'bea', 'a person not listed here reads by the name in the address')
  assert.equal(memberLabel(store, 'fixer'), 'fixer')
  assert.equal(memberLabel(store, 'fixer@beta'), 'fixer@beta')
})

test('all summaries list every agent in the list order, idle ones unfolded, master included (SUM-05)', () => {
  const master = agentOf({ id: 'm', name: MASTER_AGENT_NAME, lastActivityAt: NOW - 50_000 })
  const busy = agentOf({ id: 'b', name: 'busy', state: inTurn(), lastActivityAt: NOW - 100_000 })
  const quiet = agentOf({ id: 'q', name: 'quiet', lastActivityAt: NOW - 5 * 60 * 60_000 })
  const server = snapshotOf().server
  const store = storeWith({ server: { ...server, limits: { ...server.limits, idleFoldMinutes: 30 } }, agents: [quiet, master, busy] })
  assert.deepEqual(listOrder(store, { kind: 'server_default' }, NOW).idle.map((agent) => agent.name), ['quiet'], 'the list folds it')
  assert.deepEqual(allSummariesModel(store, NOW).map((card) => card.name), ['busy', MASTER_AGENT_NAME, 'quiet'])
})

test('the top line dot: green live, yellow connecting, red once offline (AG-08)', () => {
  const store = storeWith({})
  assert.equal(agentsListModel(store, noUnreadDefaults).dotColor, 'green')
  assert.equal(agentsListModel(store, { ...noUnreadDefaults, connection: { phase: 'connecting', detail: '', downSince: NOW } }).dotColor, 'yellow')
  assert.equal(agentsListModel(store, { ...noUnreadDefaults, connection: { phase: 'offline', detail: 'x', downSince: NOW - 60_000 } }).dotColor, 'red')
})

test("the master's card previews its last message, yours with \"you: \", and counts its unread (AG-15)", () => {
  const master = agentOf({ id: 'm', name: MASTER_AGENT_NAME })
  const c = { ...chat('cm', MASTER_AGENT_NAME), latestMessage: { seq: 3, from: MASTER_AGENT_NAME, at: 1, text: 'routed to\nalice' } }
  const card = agentsListModel(storeWith({ agents: [master], chats: [c], readStates: [readStateOf('cm', 0, 2)] }), noUnreadDefaults).master!
  assert.equal(card.previewText, 'routed to alice')
  assert.equal(card.unread, 2)
  const mine = { ...c, latestMessage: { seq: 4, from: VIEWER_ADDRESS, at: 2, text: 'thanks' } }
  assert.equal(agentsListModel(storeWith({ agents: [master], chats: [mine] }), noUnreadDefaults).master!.previewText, 'you: thanks')
})

test('goal markers and colours: ◎ or ∞ orange while active, ◷ yellow waiting, ‖ yellow paused, ✓ secondary complete (AG-28, GOAL-03)', () => {
  const active = { status: 'active' as const, waitingFor: null, nextCycleAt: null, cycleRunning: false }
  const cases: [GoalEntity, string, string][] = [
    [goal('a', active), '◎', 'orange'],
    [goal('a', active, { kind: 'open_ended' }), '∞', 'orange'],
    [goal('a', { ...active, waitingFor: { kind: 'next_message_after_interrupt' } }), '◷', 'yellow'],
    [goal('a', { status: 'paused', by: 'x', reason: null, at: 1 }), '‖', 'yellow'],
    [goal('a', { status: 'complete', at: 1, summary: 'ok' }), '✓', 'secondary'],
  ]
  for (const [entity, marker, color] of cases) assert.deepEqual([goalMarkerOf(entity), goalColorOf(entity)], [marker, color])
})

test("an archived agent's line is its latest summary, else its task (ARC-02)", () => {
  const store = storeWith({
    agents: [agentOf({ id: 'a', name: 'alice', task: 'first try', state: { state: 'archived', since: 10 } })],
    summaries: [{ id: 'a', agentId: 'a', latest: { number: 1, at: 1, line: 'shipped the fix', details: [], coversThroughAt: 1 }, live: null, lastFailure: null }],
  })
  assert.equal(archivedRows(store)[0]!.detail, 'shipped the fix')
})

test('the badge for other servers adds their unread, leaving out the open one, and is zero (hidden) with none (AG-11)', () => {
  assert.equal(otherServersUnreadTotal(new Map([['s1', 4], ['s2', 2], ['s3', 0]]), 's1'), 2)
  assert.equal(otherServersUnreadTotal(new Map([['s1', 4]]), 's1'), 0)
  assert.equal(otherServersUnreadTotal(new Map(), 's1'), 0)
})

test("the chat's header: next unread and its words, and the More menu by what the agent is doing (CHAT-02, CHAT-03)", () => {
  assert.equal(nextUnreadLabel(2), 'Next unread, 2')
  assert.equal(nextUnreadLabel(0), 'No other unread')
  const titles = (agent: { hasGoal: boolean; running: boolean; busy: boolean }) => chatMoreMenu(agent).map((item) => `${item.title}${item.disabled ? ' (off)' : ''}${item.destructive ? ' (red)' : ''}`)
  assert.deepEqual(titles({ hasGoal: false, running: false, busy: false }), ['Log', 'Context', 'Set a goal', 'Summaries', 'Details'])
  assert.deepEqual(titles({ hasGoal: true, running: true, busy: false }), ['Log', 'Context', 'Goal', 'Summaries', 'Details', 'Interrupt (off)', 'Stop (red)'])
  assert.deepEqual(titles({ hasGoal: true, running: true, busy: true }).slice(-2), ['Interrupt', 'Stop (red)'])
  assert.deepEqual([STOP_COPY.confirmTitle('fixer'), STOP_COPY.confirmMessage, STOP_COPY.confirmAction, STOP_COPY.done('fixer')],
    ['Stop fixer?', 'It keeps its session; a message restarts it.', 'Stop', 'stopped fixer'])
})

test('a failed send offers Retry, Edit and a red Delete, in a chat and a room alike (CHAT-20, ROOM-06)', () => {
  assert.deepEqual(FAILED_SEND_ACTIONS.map((item) => [item.title, item.destructive ?? false]), [['Retry', false], ['Edit', false], ['Delete', true]])
})
