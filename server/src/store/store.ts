// The only code that touches SQL. One connection, one writer: `ourod`. Every call is synchronous, so a transaction can't
// interleave with anything else in the process.
import { DatabaseSync } from 'node:sqlite'
import { AgentState, DEFAULT_NOTIFICATION_SETTINGS, DeliveryState, PeerHello, PromptCacheLifetime } from '@ouro/contract'
import type {
  AgentEntity, AskEntity, AttachmentRef, ChatEntity, DeliveryWake, DeviceEntity, EntityKind, IntegrationEntity, IntegrationProvider, MessageEntity, MessagePurpose,
  AskLevel, AskSnooze, ComputerTrust, NetworkKind, NetworkRole, NotificationSettings, PeerGroupPost, PeerGroupUpdate, PeerMessage, PeerOwnerAsk, PeerOwnerMessage, PersonEntity, PlanWindow, RemoteAskEntity, RemoteDelivery, PushTokenRegistration, ReadStateEntity, SummaryEntity, SummaryRecord,
} from '@ouro/contract'
import type { AgentLifecycle } from '../domain/agent.ts'
import { cacheStateOf } from '../domain/compaction.ts'
import type { PromptCacheRecord } from '../domain/compaction.ts'
import type { GoalRecord } from '../domain/goal.ts'
import type { PersonalNote } from '../domain/memory.ts'
import { containsEveryWord } from '../domain/search.ts'
import type { SummaryProgress } from '../domain/summary.ts'
import { NO_BASE_UPDATE } from '../domain/base-update.ts'
import type { BaseUpdateRecord } from '../domain/base-update.ts'
import { LONGEST_WINDOW_MS } from '../domain/usage.ts'
import type { PlanAccount, PlanReading } from '../domain/usage.ts'
import type { AgentWorktree } from '../domain/worktree.ts'
import { migrations, SCHEMA_VERSION } from './schema.ts'

type SqlValue = string | number | null

export interface AgentRow {
  id: string
  name: string
  task: string
  folder: string
  model: string
  parent: string
  createdBy: string
  createdAt: number
  lifecycle: AgentLifecycle
  stateNote: string | null
  providerSessionId: string | null
  runnerPid: number | null
  runnerRelease: string | null
  journalCursor: number
  lastOutputAt: number | null
  lastActivityAt: number
  interruptedBy: string | null
  costUsd: number
  lastTurnFailure: AgentEntity['lastTurnFailure']
  /** The turn already reported to the parent as running long; null until one is. */
  longTurnReportedTurnId: string | null
  /** Messages up to this seq owe no reply any more: answered, reminded of, or dropped with an interrupted turn. */
  repliesSettledThroughSeq: number
  /** Its own worktree, while it has one; null when it works in its folder directly. */
  worktree: AgentWorktree | null
  promptCacheLifetime: PromptCacheLifetime
  /** A copy pulled from a shared network; null: not one. */
  pulled: AgentPulled | null
  /** Null until a turn reports its context, and for models without a timed prompt cache. */
  promptCache: PromptCacheRecord | null
}

export interface TakenMessageRow {
  message: MessageRow
  wake: DeliveryWake
  chatKind: ChatEntity['kind']
  answersOwnAsk: boolean
  followsOwnMessage: boolean
  answeredInChat: boolean
}

export interface AgentPulled { from: string; network: string; at: number; awaitingStart: boolean }

export interface NewAgent {
  id: string
  name: string
  task: string
  folder: string
  model: string
  parent: string
  createdBy: string
  createdAt: number
  lifecycle: AgentLifecycle
  credentialHash: string
  worktree: AgentWorktree | null
  promptCacheLifetime: PromptCacheLifetime
}

export interface DeliveryRow {
  id: string
  messageId: string
  messageSeq: number
  recipient: string
  agentId: string
  wake: DeliveryWake
  state: DeliveryState
}

export interface MessageRow {
  seq: number
  id: string
  chatId: string
  from: string
  at: number
  text: string
  attachments: AttachmentRef[]
  purpose: MessagePurpose
  clientKey: string | null
  posesAskId: string | null
  answersAskId: string | null
  relayedBy: string | null
}

export type NewMessage = Omit<MessageRow, 'seq'>

export interface AppUpdateRow {
  updateNumber: number
  id: string
  platform: string
  runtimeVersion: string
  commit: string | null
  createdAt: number
  /** Rows published before keys were derived from hashes also carry a `key`, which is no longer read. */
  launchAsset: { fileName: string; hash: string }
  assets: { fileName: string; contentType: string; fileExtension: string; hash: string }[]
}

export interface PersonRow { id: string; name: string; address: string; isOwner: boolean; joinedAt: number }
export interface DeviceRow { id: string; name: string; personId: string; pairedAt: number; lastSeenAt: number | null; revokedAt: number | null }
export interface ChangeRow { cursor: number; entity: EntityKind; entityId: string; deleted: boolean }
export interface AgentTransitionRow { fromState: string; toState: string; generation: number; cause: string; at: number }

export class Store {
  private readonly db: DatabaseSync
  private transactionDepth = 0

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    // SQLite's own lower() and LIKE fold only ASCII; search must match "École" for "école".
    this.db.function('contains_every_word', { deterministic: true }, (text, wordsJson) => (containsEveryWord(String(text), JSON.parse(String(wordsJson)) as string[]) ? 1 : 0))
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    // A newer schema is fine by itself (see schema.ts); the guardian refuses releases that can't run on it.
    for (let index = version; index < SCHEMA_VERSION; index++) {
      this.transaction(() => {
        this.db.exec(migrations[index]!)
        this.db.exec(`PRAGMA user_version = ${index + 1}`)
      })
    }
  }

  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  }

  transaction<T>(body: () => T): T {
    if (this.transactionDepth > 0) return body()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth++
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth--
    }
  }

  /** How many rows it changed. */
  private run(sql: string, ...params: SqlValue[]): { changes: number } {
    return { changes: Number(this.db.prepare(sql).run(...params).changes) }
  }

  private get<R>(sql: string, ...params: SqlValue[]): R | undefined {
    return this.db.prepare(sql).get(...params) as R | undefined
  }

  private all<R>(sql: string, ...params: SqlValue[]): R[] {
    return this.db.prepare(sql).all(...params) as R[]
  }

  // Phone updates: immutable once inserted.

  insertAppUpdate(update: Omit<AppUpdateRow, 'updateNumber'>): AppUpdateRow {
    const result = this.db.prepare('INSERT INTO app_updates (id, platform, runtime_version, source_commit, created_at, launch_asset_json, assets_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(update.id, update.platform, update.runtimeVersion, update.commit, update.createdAt, JSON.stringify(update.launchAsset), JSON.stringify(update.assets))
    return { ...update, updateNumber: Number(result.lastInsertRowid) }
  }

  private toAppUpdateRow(row: Record<string, SqlValue>): AppUpdateRow {
    return {
      updateNumber: row.update_number as number,
      id: row.id as string,
      platform: row.platform as string,
      runtimeVersion: row.runtime_version as string,
      commit: row.source_commit as string | null,
      createdAt: row.created_at as number,
      launchAsset: JSON.parse(row.launch_asset_json as string) as AppUpdateRow['launchAsset'],
      assets: JSON.parse(row.assets_json as string) as AppUpdateRow['assets'],
    }
  }

  latestAppUpdate(platform: string, runtimeVersion: string): AppUpdateRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM app_updates WHERE platform = ? AND runtime_version = ? ORDER BY update_number DESC LIMIT 1', platform, runtimeVersion)
    return row ? this.toAppUpdateRow(row) : null
  }

  newestAppUpdate(platform: string): AppUpdateRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM app_updates WHERE platform = ? ORDER BY update_number DESC LIMIT 1', platform)
    return row ? this.toAppUpdateRow(row) : null
  }

  appUpdateByNumber(updateNumber: number): AppUpdateRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM app_updates WHERE update_number = ?', updateNumber)
    return row ? this.toAppUpdateRow(row) : null
  }

  // Meta

  getMeta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  // Change log

  markChanged(entity: EntityKind, entityId: string, audiencePersonId: string | null = null): void {
    this.run('INSERT OR REPLACE INTO changes (entity, entity_id, audience_person_id, deleted) VALUES (?, ?, ?, 0)', entity, entityId, audiencePersonId)
  }

  markDeleted(entity: EntityKind, entityId: string, audiencePersonId: string | null = null): void {
    this.run('INSERT OR REPLACE INTO changes (entity, entity_id, audience_person_id, deleted) VALUES (?, ?, ?, 1)', entity, entityId, audiencePersonId)
  }

  currentCursor(): number {
    return this.get<{ cursor: number | null }>('SELECT max(cursor) AS cursor FROM changes')?.cursor ?? 0
  }

  changesAfter(cursor: number, personId: string, limit: number): ChangeRow[] {
    const rows = this.all<{ cursor: number; entity: EntityKind; entity_id: string; deleted: number }>(
      'SELECT cursor, entity, entity_id, deleted FROM changes WHERE cursor > ? AND (audience_person_id IS NULL OR audience_person_id = ?) ORDER BY cursor LIMIT ?',
      cursor, personId, limit,
    )
    return rows.map((row) => ({ cursor: row.cursor, entity: row.entity, entityId: row.entity_id, deleted: row.deleted === 1 }))
  }

  // People and devices

  insertPerson(person: PersonRow): void {
    this.run('INSERT INTO people (id, name, address, is_owner, joined_at) VALUES (?, ?, ?, ?, ?)', person.id, person.name, person.address, person.isOwner ? 1 : 0, person.joinedAt)
    this.markChanged('person', person.id)
  }

  private toPersonRow(row: { id: string; name: string; address: string; is_owner: number; joined_at: number }): PersonRow {
    return { id: row.id, name: row.name, address: row.address, isOwner: row.is_owner === 1, joinedAt: row.joined_at }
  }

  personById(id: string): PersonRow | null {
    const row = this.get<Parameters<Store['toPersonRow']>[0]>('SELECT * FROM people WHERE id = ?', id)
    return row ? this.toPersonRow(row) : null
  }

  personByAddress(address: string): PersonRow | null {
    const row = this.get<Parameters<Store['toPersonRow']>[0]>('SELECT * FROM people WHERE address = ? AND removed_at IS NULL', address)
    return row ? this.toPersonRow(row) : null
  }

  /** Whether or not they were removed: a name stays theirs. */
  personByName(name: string): { person: PersonRow; removed: boolean } | null {
    const row = this.get<Parameters<Store['toPersonRow']>[0] & { removed_at: number | null }>('SELECT * FROM people WHERE name = ?', name)
    return row ? { person: this.toPersonRow(row), removed: row.removed_at !== null } : null
  }

  /** Their devices are revoked separately; what they said stays. */
  removePerson(id: string, now: number): void {
    this.run('UPDATE people SET removed_at = ? WHERE id = ?', now, id)
    this.markDeleted('person', id)
  }

  /** Invited again after being removed: the same person, with their history. */
  restorePerson(id: string): void {
    this.run('UPDATE people SET removed_at = NULL WHERE id = ?', id)
    this.markChanged('person', id)
  }

  ownerPerson(): PersonRow | null {
    const row = this.get<Parameters<Store['toPersonRow']>[0]>('SELECT * FROM people WHERE is_owner = 1')
    return row ? this.toPersonRow(row) : null
  }

  listPeople(): PersonRow[] {
    return this.all<Parameters<Store['toPersonRow']>[0]>('SELECT * FROM people WHERE removed_at IS NULL ORDER BY joined_at').map((row) => this.toPersonRow(row))
  }

  insertPairingCode(codeHash: string, inviteePersonName: string | null, expiresAt: number): void {
    this.run('INSERT INTO pairing_codes (code_hash, invitee_person_name, expires_at) VALUES (?, ?, ?)', codeHash, inviteePersonName, expiresAt)
  }

  /** Returns the code's invitee if it's unused and unexpired, and uses it up. */
  consumePairingCode(codeHash: string, now: number): { inviteePersonName: string | null } | null {
    const row = this.get<{ invitee_person_name: string | null }>('SELECT invitee_person_name FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', codeHash, now)
    if (!row) return null
    this.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', now, codeHash)
    return { inviteePersonName: row.invitee_person_name }
  }

  insertDevice(device: DeviceRow, tokenHash: string): void {
    this.run('INSERT INTO devices (id, name, person_id, token_hash, paired_at) VALUES (?, ?, ?, ?, ?)', device.id, device.name, device.personId, tokenHash, device.pairedAt)
    this.markChanged('device', device.id)
  }

  /** The guardian's probe: a real credential that reads like a phone, and that isn't one of the person's devices. */
  insertProbeDevice(device: DeviceRow, tokenHash: string): void {
    this.run(`INSERT INTO devices (id, name, person_id, token_hash, purpose, paired_at) VALUES (?, ?, ?, ?, 'guardian_probe', ?)`, device.id, device.name, device.personId, tokenHash, device.pairedAt)
  }

  private toDeviceRow(row: { id: string; name: string; person_id: string; paired_at: number; last_seen_at: number | null; revoked_at: number | null }): DeviceRow {
    return { id: row.id, name: row.name, personId: row.person_id, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }
  }

  deviceByTokenHash(tokenHash: string): DeviceRow | null {
    const row = this.get<Parameters<Store['toDeviceRow']>[0]>('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', tokenHash)
    return row ? this.toDeviceRow(row) : null
  }

  deviceById(id: string): DeviceRow | null {
    const row = this.get<Parameters<Store['toDeviceRow']>[0]>('SELECT * FROM devices WHERE id = ?', id)
    return row ? this.toDeviceRow(row) : null
  }

  /** Every device still able to connect as this person, the guardian's probe included. */
  activeDeviceIdsOf(personId: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM devices WHERE person_id = ? AND revoked_at IS NULL', personId).map((row) => row.id)
  }

  revokeDevice(id: string, now: number): void {
    this.run('UPDATE devices SET revoked_at = ? WHERE id = ?', now, id)
    this.markDeleted('device', id)
  }

  // Agents

  insertAgent(agent: NewAgent): void {
    this.run(
      `INSERT INTO agents (id, name, task, folder, model, parent, created_by, created_at, state_name, state_json, instance_generation, consecutive_crashes, ownership_epoch, last_activity_at, credential_hash, worktree_json, prompt_cache_lifetime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id, agent.name, agent.task, agent.folder, agent.model, agent.parent, agent.createdBy, agent.createdAt,
      agent.lifecycle.state.state, JSON.stringify(agent.lifecycle.state), agent.lifecycle.instanceGeneration, agent.lifecycle.consecutiveCrashes,
      agent.lifecycle.ownershipEpoch, agent.createdAt, agent.credentialHash, agent.worktree === null ? null : JSON.stringify(agent.worktree), agent.promptCacheLifetime,
    )
    this.markChanged('agent', agent.id)
  }

  private toAgentRow(row: Record<string, SqlValue>): AgentRow {
    return {
      id: row.id as string,
      name: row.name as string,
      task: row.task as string,
      folder: row.folder as string,
      model: row.model as string,
      parent: row.parent as string,
      createdBy: row.created_by as string,
      createdAt: row.created_at as number,
      lifecycle: {
        state: AgentState.parse(JSON.parse(row.state_json as string)),
        instanceGeneration: row.instance_generation as number,
        consecutiveCrashes: row.consecutive_crashes as number,
        consecutiveCreditFailures: row.consecutive_credit_failures as number,
        ownershipEpoch: row.ownership_epoch as number,
        consecutiveStalls: row.consecutive_stalls as number,
      },
      stateNote: row.state_note as string | null,
      providerSessionId: row.provider_session_id as string | null,
      runnerPid: row.runner_pid as number | null,
      runnerRelease: row.runner_release as string | null,
      journalCursor: row.journal_cursor as number,
      lastOutputAt: row.last_output_at as number | null,
      lastActivityAt: row.last_activity_at as number,
      interruptedBy: row.interrupted_by as string | null,
      costUsd: row.cost_usd as number,
      lastTurnFailure: row.last_turn_failure_json === null ? null : JSON.parse(row.last_turn_failure_json as string) as AgentEntity['lastTurnFailure'],
      longTurnReportedTurnId: row.long_turn_reported_turn_id as string | null,
      repliesSettledThroughSeq: row.replies_settled_through_seq as number,
      worktree: row.worktree_json === null ? null : JSON.parse(row.worktree_json as string) as AgentWorktree,
      promptCacheLifetime: PromptCacheLifetime.parse(row.prompt_cache_lifetime),
      pulled: row.pulled_json === null || row.pulled_json === undefined ? null : JSON.parse(row.pulled_json as string) as AgentPulled,
      promptCache: row.prompt_cache_json === null ? null : JSON.parse(row.prompt_cache_json as string) as PromptCacheRecord,
    }
  }

  agentById(id: string): AgentRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM agents WHERE id = ?', id)
    return row ? this.toAgentRow(row) : null
  }

  activeAgentByName(name: string): AgentRow | null {
    const row = this.get<Record<string, SqlValue>>(`SELECT * FROM agents WHERE name = ? AND state_name NOT IN ('archived', 'moved')`, name)
    return row ? this.toAgentRow(row) : null
  }

  newestArchivedAgentByName(name: string): AgentRow | null {
    const row = this.get<Record<string, SqlValue>>(`SELECT * FROM agents WHERE name = ? AND state_name = 'archived' ORDER BY created_at DESC LIMIT 1`, name)
    return row ? this.toAgentRow(row) : null
  }

  agentByCredentialHash(credentialHash: string): AgentRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM agents WHERE credential_hash = ?', credentialHash)
    return row ? this.toAgentRow(row) : null
  }

  listAgents(): AgentRow[] {
    return this.all<Record<string, SqlValue>>('SELECT * FROM agents ORDER BY created_at').map((row) => this.toAgentRow(row))
  }

  /** Everything the scheduler may need to act on. The archive can grow forever, so it's excluded. */
  listUnarchivedAgents(): AgentRow[] {
    return this.all<Record<string, SqlValue>>(`SELECT * FROM agents WHERE state_name NOT IN ('archived', 'moved') ORDER BY created_at`).map((row) => this.toAgentRow(row))
  }

  countAgentsWithRunners(): number {
    return this.get<{ count: number }>(`SELECT count(*) AS count FROM agents WHERE state_name IN ('starting', 'idle', 'in_turn', 'interrupting', 'compacting', 'stopping')`)!.count
  }

  saveAgentLifecycle(id: string, lifecycle: AgentLifecycle, stateNote: string | null): void {
    this.run('UPDATE agents SET state_name = ?, state_json = ?, instance_generation = ?, consecutive_crashes = ?, consecutive_credit_failures = ?, consecutive_stalls = ?, state_note = ? WHERE id = ?',
      lifecycle.state.state, JSON.stringify(lifecycle.state), lifecycle.instanceGeneration, lifecycle.consecutiveCrashes, lifecycle.consecutiveCreditFailures, lifecycle.consecutiveStalls, stateNote, id)
    this.markChanged('agent', id)
  }

  recordAgentTransition(agentId: string, transition: AgentTransitionRow): void {
    this.run('INSERT INTO agent_transitions (agent_id, from_state, to_state, generation, cause, at) VALUES (?, ?, ?, ?, ?, ?)',
      agentId, transition.fromState, transition.toState, transition.generation, transition.cause, transition.at)
  }

  agentTransitions(agentId: string, limit: number): AgentTransitionRow[] {
    return this.all<{ from_state: string; to_state: string; generation: number; cause: string; at: number }>(
      'SELECT from_state, to_state, generation, cause, at FROM agent_transitions WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agentId, limit,
    ).reverse().map((row) => ({ fromState: row.from_state, toState: row.to_state, generation: row.generation, cause: row.cause, at: row.at }))
  }

  /** The agent that last lived here under this name and moved to another computer. */
  newestMovedAgentByName(name: string): AgentRow | null {
    const row = this.get<Record<string, SqlValue>>(`SELECT * FROM agents WHERE name = ? AND state_name = 'moved' ORDER BY created_at DESC LIMIT 1`, name)
    return row ? this.toAgentRow(row) : null
  }

  /** Helpers here whose parent was `from` report to `to` from now on. */
  reparentAgents(from: string, to: string): void {
    for (const row of this.all<{ id: string }>(`SELECT id FROM agents WHERE parent = ? AND state_name NOT IN ('archived', 'moved')`, from)) {
      this.run('UPDATE agents SET parent = ? WHERE id = ?', to, row.id)
      this.markChanged('agent', row.id)
    }
  }

  /** Remembers a move taken from another computer, so the same handoff sent again is taken once. */
  recordMoveTaken(moveId: string, fromMachineId: string, agentId: string, now: number): void {
    this.run('INSERT INTO moves_taken (move_id, from_machine_id, agent_id, taken_at) VALUES (?, ?, ?, ?)', moveId, fromMachineId, agentId, now)
  }

  moveTaken(moveId: string): { fromMachineId: string; agentId: string } | null {
    const row = this.get<{ from_machine_id: string; agent_id: string }>('SELECT from_machine_id, agent_id FROM moves_taken WHERE move_id = ?', moveId)
    return row ? { fromMachineId: row.from_machine_id, agentId: row.agent_id } : null
  }

  updateAgentFields(id: string, fields: Partial<{
    model: string; providerSessionId: string | null; runnerPid: number | null; runnerRelease: string | null; journalCursor: number
    lastOutputAt: number; lastActivityAt: number; interruptedBy: string | null; costUsd: number; longTurnReportedTurnId: string
    repliesSettledThroughSeq: number
  }>): void {
    const columns: Record<string, string> = {
      model: 'model', providerSessionId: 'provider_session_id', runnerPid: 'runner_pid', runnerRelease: 'runner_release', journalCursor: 'journal_cursor',
      lastOutputAt: 'last_output_at', lastActivityAt: 'last_activity_at', interruptedBy: 'interrupted_by', costUsd: 'cost_usd',
      longTurnReportedTurnId: 'long_turn_reported_turn_id', repliesSettledThroughSeq: 'replies_settled_through_seq',
    }
    const entries = Object.entries(fields)
    if (entries.length === 0) return
    const assignments = entries.map(([field]) => `${columns[field]} = ?`).join(', ')
    this.run(`UPDATE agents SET ${assignments} WHERE id = ?`, ...entries.map(([, value]) => value as SqlValue), id)
    // Bookkeeping no client sees changes nothing to sync.
    if (entries.some(([field]) => field !== 'journalCursor' && field !== 'repliesSettledThroughSeq')) this.markChanged('agent', id)
  }

  savePromptCache(id: string, cache: PromptCacheRecord | null): void {
    this.run('UPDATE agents SET prompt_cache_json = ? WHERE id = ?', cache === null ? null : JSON.stringify(cache), id)
    this.markChanged('agent', id)
  }

  /** Where an agent works from now on: back in the main checkout once its own worktree is removed. */
  moveAgentFolder(id: string, folder: string, worktree: AgentWorktree | null): void {
    this.run('UPDATE agents SET folder = ?, worktree_json = ? WHERE id = ?', folder, worktree === null ? null : JSON.stringify(worktree), id)
    this.markChanged('agent', id)
  }

  setLastTurnFailure(id: string, failure: AgentEntity['lastTurnFailure']): void {
    this.run('UPDATE agents SET last_turn_failure_json = ? WHERE id = ?', failure === null ? null : JSON.stringify(failure), id)
    this.markChanged('agent', id)
  }

  setAgentCredential(id: string, credentialHash: string): void {
    this.run('UPDATE agents SET credential_hash = ? WHERE id = ?', credentialHash, id)
  }

  saveAgentNote(id: string, stateNote: string): void {
    this.run('UPDATE agents SET state_note = ? WHERE id = ?', stateNote, id)
    this.markChanged('agent', id)
  }

  // Chats

  insertChat(chat: { id: string; kind: 'direct' | 'group'; title: string | null; createdBy: string; createdAt: number; homeMachine: string; members: { address: string; joinedAt: number }[] }): void {
    this.run('INSERT INTO chats (id, kind, title, created_by, created_at, home_machine) VALUES (?, ?, ?, ?, ?, ?)',
      chat.id, chat.kind, chat.title, chat.createdBy, chat.createdAt, chat.homeMachine)
    for (const member of chat.members) {
      this.run('INSERT INTO chat_members (chat_id, address, joined_at) VALUES (?, ?, ?)', chat.id, member.address, member.joinedAt)
    }
    this.markChanged('chat', chat.id)
  }

  chatExists(chatId: string): boolean {
    return this.get('SELECT 1 FROM chats WHERE id = ?', chatId) !== undefined
  }

  chatMembers(chatId: string): { address: string; joinedAt: number }[] {
    return this.all<{ address: string; joined_at: number }>('SELECT address, joined_at FROM chat_members WHERE chat_id = ? ORDER BY joined_at, address', chatId)
      .map((row) => ({ address: row.address, joinedAt: row.joined_at }))
  }

  addChatMember(chatId: string, address: string, joinedAt: number): void {
    this.run('INSERT INTO chat_members (chat_id, address, joined_at) VALUES (?, ?, ?)', chatId, address, joinedAt)
    this.markChanged('chat', chatId)
  }

  removeChatMember(chatId: string, address: string): void {
    this.run('DELETE FROM chat_members WHERE chat_id = ? AND address = ?', chatId, address)
    this.markChanged('chat', chatId)
  }

  groupChats(): ChatEntity[] {
    return this.all<{ id: string }>("SELECT id FROM chats WHERE kind = 'group' ORDER BY created_at").map((row) => this.chatEntity(row.id)!)
  }

  /** Everything agents have spent, archived ones included: the budget counts it all. */
  totalSpendUsd(): number {
    return this.get<{ total: number | null }>('SELECT sum(cost_usd) AS total FROM agents')?.total ?? 0
  }

  // Plan usage

  baseUpdateRecord(): BaseUpdateRecord {
    const json = this.getMeta('base_update')
    return json === null ? NO_BASE_UPDATE : JSON.parse(json) as BaseUpdateRecord
  }

  saveBaseUpdateRecord(record: BaseUpdateRecord): void {
    this.setMeta('base_update', JSON.stringify(record))
    this.markChanged('server', 'server')
  }

  planReading(account: PlanAccount): PlanReading | null {
    const row = this.get<{ reading_json: string }>('SELECT reading_json FROM plan_readings WHERE account = ?', account)
    return row ? JSON.parse(row.reading_json) as PlanReading : null
  }

  savePlanReading(account: PlanAccount, reading: PlanReading): void {
    this.run('INSERT OR REPLACE INTO plan_readings (account, reading_json) VALUES (?, ?)', account, JSON.stringify(reading))
    this.markChanged('server', 'server')
  }

  /** A turn's cost on a plan, kept while some window can still contain it. */
  addPlanTurnCost(agentId: string, account: PlanAccount, at: number, costUsd: number): void {
    this.run('DELETE FROM plan_turn_costs WHERE at < ?', at - LONGEST_WINDOW_MS)
    this.run('INSERT INTO plan_turn_costs (agent_id, account, at, cost_usd) VALUES (?, ?, ?, ?)', agentId, account, at, costUsd)
  }

  /** What turns on the plan cost since `since`, per agent, archived ones included. */
  planTurnCostsSince(account: PlanAccount, since: number): Map<string, number> {
    const rows = this.all<{ agent_id: string; total: number }>('SELECT agent_id, sum(cost_usd) AS total FROM plan_turn_costs WHERE account = ? AND at >= ? GROUP BY agent_id', account, since)
    return new Map(rows.map((row) => [row.agent_id, row.total]))
  }

  // Integrations: the last state seen from each provider's own tool.

  integrationOf(provider: IntegrationProvider): IntegrationEntity | null {
    const row = this.get<{ entity_json: string }>('SELECT entity_json FROM integrations WHERE provider = ?', provider)
    return row ? JSON.parse(row.entity_json) as IntegrationEntity : null
  }

  listIntegrations(): IntegrationEntity[] {
    return this.all<{ entity_json: string }>('SELECT entity_json FROM integrations ORDER BY provider').map((row) => JSON.parse(row.entity_json) as IntegrationEntity)
  }

  /** Only a changed state is a change: a check that saw the same thing moves `checkedAt` without waking any client. */
  saveIntegration(integration: IntegrationEntity): boolean {
    const previous = this.integrationOf(integration.provider)
    const changed = previous === null || JSON.stringify(previous.state) !== JSON.stringify(integration.state)
    this.run('INSERT OR REPLACE INTO integrations (provider, entity_json) VALUES (?, ?)', integration.provider, JSON.stringify(integration))
    if (changed) {
      this.markChanged('integration', integration.id)
      // Which models are available follows from the accounts.
      this.markChanged('server', 'server')
    }
    return changed
  }

  // Messages

  insertMessage(message: NewMessage): MessageRow {
    const result = this.db.prepare(
      'INSERT INTO messages (id, chat_id, from_address, at, text, attachments_json, purpose, client_key, poses_ask_id, answers_ask_id, relayed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(message.id, message.chatId, message.from, message.at, message.text, JSON.stringify(message.attachments), message.purpose, message.clientKey, message.posesAskId, message.answersAskId, message.relayedBy)
    const seq = Number(result.lastInsertRowid)
    this.run('UPDATE chats SET latest_message_seq = ? WHERE id = ?', seq, message.chatId)
    this.markChanged('message', message.id)
    this.markChanged('chat', message.chatId)
    return { ...message, seq }
  }

  private toMessageRow(row: Record<string, SqlValue>): MessageRow {
    return {
      seq: row.seq as number,
      id: row.id as string,
      chatId: row.chat_id as string,
      from: row.from_address as string,
      at: row.at as number,
      text: row.text as string,
      attachments: JSON.parse(row.attachments_json as string) as AttachmentRef[],
      purpose: row.purpose as MessagePurpose,
      clientKey: row.client_key as string | null,
      posesAskId: row.poses_ask_id as string | null,
      answersAskId: row.answers_ask_id as string | null,
      relayedBy: row.relayed_by as string | null,
    }
  }

  messageById(id: string): MessageRow | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM messages WHERE id = ?', id)
    return row ? this.toMessageRow(row) : null
  }

  /** Oldest first, ending just before `beforeSeq`. One more than `limit` rows tells whether there's older history. */
  chatHistory(chatId: string, beforeSeq: number | null, limit: number): { messages: MessageRow[]; hasOlder: boolean } {
    const rows = this.all<Record<string, SqlValue>>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      chatId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1,
    )
    const page = rows.slice(0, limit).reverse()
    return { messages: page.map((row) => this.toMessageRow(row)), hasOlder: rows.length > limit }
  }

  /**
   * Newest first: messages holding every word, except in archived agents' direct chats (a direct chat is an agent's when
   * a message in it was delivered to that agent). `more`: there were others past the limit.
   */
  searchMessages(words: string[], limit: number): { messages: MessageRow[]; more: boolean } {
    const rows = this.all<Record<string, SqlValue>>(
      `SELECT * FROM messages WHERE contains_every_word(text, ?) AND chat_id NOT IN (
         SELECT m.chat_id FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN chats c ON c.id = m.chat_id JOIN agents a ON a.id = d.agent_id
         WHERE c.kind = 'direct' AND a.state_name = 'archived')
       ORDER BY seq DESC LIMIT ?`, JSON.stringify(words), limit + 1)
    return { messages: rows.slice(0, limit).map((row) => this.toMessageRow(row)), more: rows.length > limit }
  }

  // Deliveries

  insertDelivery(delivery: DeliveryRow): void {
    this.run('INSERT INTO deliveries (id, message_id, message_seq, recipient, agent_id, wake, state_name, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      delivery.id, delivery.messageId, delivery.messageSeq, delivery.recipient, delivery.agentId, delivery.wake, delivery.state.state, JSON.stringify(delivery.state))
    this.markChanged('agent', delivery.agentId)
    this.markChanged('message', delivery.messageId)
  }

  private toDeliveryRow(row: Record<string, SqlValue>): DeliveryRow {
    return {
      id: row.id as string,
      messageId: row.message_id as string,
      messageSeq: row.message_seq as number,
      recipient: row.recipient as string,
      agentId: row.agent_id as string,
      wake: row.wake as DeliveryWake,
      state: DeliveryState.parse(JSON.parse(row.state_json as string)),
    }
  }

  /**
   * What an agent last took part in, oldest first: messages it took in through finished turns, and what it said in those
   * chats since. Failed and undelivered messages are left out.
   */
  recentConversationOf(agentId: string, agentName: string, limit: number): MessageRow[] {
    const taken = this.all<{ message_seq: number }>(
      "SELECT message_seq FROM deliveries WHERE agent_id = ? AND state_name = 'completed' ORDER BY message_seq DESC LIMIT ?", agentId, limit)
    if (taken.length === 0) return []
    const oldest = Math.min(...taken.map((row) => row.message_seq))
    const takenRows = taken.map((row) => this.get<Record<string, SqlValue>>('SELECT * FROM messages WHERE seq = ?', row.message_seq)!)
    const chatIds = [...new Set(takenRows.map((row) => row.chat_id as string))]
    const said = chatIds.flatMap((chatId) => this.all<Record<string, SqlValue>>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq >= ? AND from_address = ? ORDER BY seq DESC LIMIT ?', chatId, oldest, agentName, limit))
    return [...takenRows, ...said].sort((a, b) => (a.seq as number) - (b.seq as number)).slice(-limit).map((row) => this.toMessageRow(row))
  }

  deliveriesOfMessage(messageId: string): DeliveryRow[] {
    return this.all<Record<string, SqlValue>>('SELECT * FROM deliveries WHERE message_id = ?', messageId).map((row) => this.toDeliveryRow(row))
  }

  deliveriesOfAgentInState(agentId: string, stateName: DeliveryState['state']): DeliveryRow[] {
    return this.all<Record<string, SqlValue>>('SELECT * FROM deliveries WHERE agent_id = ? AND state_name = ? ORDER BY message_seq', agentId, stateName).map((row) => this.toDeliveryRow(row))
  }

  /** Something queued that will start a turn, as an FYI won't. */
  hasQueuedWakingDelivery(agentId: string): boolean {
    return this.get(`SELECT 1 FROM deliveries WHERE agent_id = ? AND state_name = 'queued' AND wake = 'wake' LIMIT 1`, agentId) !== undefined
  }

  /** Handed to its runner or taken in: the deliveries of the agent's current turn. */
  deliveriesOfAgentInTurn(agentId: string): DeliveryRow[] {
    return this.all<Record<string, SqlValue>>(
      "SELECT * FROM deliveries WHERE agent_id = ? AND state_name IN ('handed_to_runner', 'taken_in') ORDER BY message_seq", agentId).map((row) => this.toDeliveryRow(row))
  }

  countQueuedDeliveries(agentId: string): number {
    return this.get<{ count: number }>(`SELECT count(*) AS count FROM deliveries WHERE agent_id = ? AND state_name = 'queued'`, agentId)!.count
  }

  updateDeliveryState(delivery: DeliveryRow, state: DeliveryState): void {
    this.run('UPDATE deliveries SET state_name = ?, state_json = ? WHERE id = ?', state.state, JSON.stringify(state), delivery.id)
    this.markChanged('message', delivery.messageId)
    this.markChanged('agent', delivery.agentId)
  }

  insertDeliveryAttempt(attempt: { id: string; deliveryId: string; turnId: string; generation: number; startedAt: number }): void {
    this.run('INSERT INTO delivery_attempts (id, delivery_id, turn_id, generation, started_at) VALUES (?, ?, ?, ?, ?)',
      attempt.id, attempt.deliveryId, attempt.turnId, attempt.generation, attempt.startedAt)
  }

  countDeliveryAttempts(deliveryId: string): number {
    return this.get<{ count: number }>('SELECT count(*) AS count FROM delivery_attempts WHERE delivery_id = ?', deliveryId)!.count
  }

  /**
   * Messages this agent took in through finished turns after `afterSeq`, with what decides whether each still owes a
   * reply. Only real messages from people and agents: the rest never owe one.
   */
  takenMessagesAfter(agentId: string, agentName: string, afterSeq: number): TakenMessageRow[] {
    return this.all<Record<string, SqlValue>>(
      `SELECT m.*, d.wake AS delivery_wake, c.kind AS chat_kind,
         EXISTS (SELECT 1 FROM asks a WHERE a.id = m.answers_ask_id AND a.agent_id = d.agent_id) AS answers_own_ask,
         coalesce((SELECT p.from_address = ? FROM messages p WHERE p.chat_id = m.chat_id AND p.seq < m.seq ORDER BY p.seq DESC LIMIT 1), 0) AS follows_own_message,
         EXISTS (SELECT 1 FROM messages r WHERE r.chat_id = m.chat_id AND r.seq > m.seq AND r.from_address = ?) AS answered_in_chat
       FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN chats c ON c.id = m.chat_id
       WHERE d.agent_id = ? AND d.state_name = 'completed' AND d.message_seq > ? AND m.purpose = 'message'
       ORDER BY d.message_seq`, agentName, agentName, agentId, afterSeq,
    ).map((row) => ({
      message: this.toMessageRow(row),
      wake: row.delivery_wake as DeliveryWake,
      chatKind: row.chat_kind as ChatEntity['kind'],
      answersOwnAsk: row.answers_own_ask === 1,
      followsOwnMessage: row.follows_own_message === 1,
      answeredInChat: row.answered_in_chat === 1,
    }))
  }

  /** The newest message this agent has taken into a turn, or 0. */
  takenThroughSeq(agentId: string): number {
    return this.get<{ seq: number | null }>(`SELECT max(message_seq) AS seq FROM deliveries WHERE agent_id = ? AND state_name <> 'queued'`, agentId)!.seq ?? 0
  }

  /** The newest message this agent took in that asked something of it, for `reply`. */
  latestAnswerableMessage(agentId: string): MessageRow | null {
    const row = this.get<Record<string, SqlValue>>(
      `SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.agent_id = ? AND d.wake = 'wake' AND d.state_name IN ('taken_in', 'completed') AND m.purpose IN ('message', 'task', 'done_report')
       ORDER BY d.message_seq DESC LIMIT 1`, agentId)
    return row ? this.toMessageRow(row) : null
  }

  // Read marks

  readThroughSeq(personId: string, chatId: string): number {
    return this.get<{ read_through_seq: number }>('SELECT read_through_seq FROM read_marks WHERE person_id = ? AND chat_id = ?', personId, chatId)?.read_through_seq ?? 0
  }

  setReadThroughSeq(personId: string, chatId: string, seq: number): void {
    this.run(`INSERT INTO read_marks (person_id, chat_id, read_through_seq) VALUES (?, ?, ?)
              ON CONFLICT (person_id, chat_id) DO UPDATE SET read_through_seq = max(read_through_seq, excluded.read_through_seq)`, personId, chatId, seq)
    this.markChanged('read_state', readStateId(personId, chatId), personId)
  }

  countUnread(chatId: string, afterSeq: number, viewerAddress: string): number {
    return this.get<{ count: number }>('SELECT count(*) AS count FROM messages WHERE chat_id = ? AND seq > ? AND from_address <> ?', chatId, afterSeq, viewerAddress)!.count
  }

  // Attachments

  insertAttachment(attachment: AttachmentRef, now: number): void {
    this.run('INSERT OR IGNORE INTO attachments (id, file_name, mime_type, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      attachment.id, attachment.fileName, attachment.mimeType, attachment.byteLength, now)
  }

  attachmentById(id: string): AttachmentRef | null {
    const row = this.get<{ id: string; file_name: string; mime_type: string; byte_length: number }>('SELECT * FROM attachments WHERE id = ?', id)
    return row ? { id: row.id, fileName: row.file_name, mimeType: row.mime_type, byteLength: row.byte_length } : null
  }

  // Idempotency

  idempotentResult(caller: string, key: string): { command: string; inputHash: string; resultJson: string } | null {
    const row = this.get<{ command: string; input_hash: string; result_json: string }>('SELECT command, input_hash, result_json FROM idempotent_results WHERE caller = ? AND idempotency_key = ?', caller, key)
    return row ? { command: row.command, inputHash: row.input_hash, resultJson: row.result_json } : null
  }

  saveIdempotentResult(caller: string, key: string, command: string, inputHash: string, resultJson: string, now: number): void {
    this.run('INSERT INTO idempotent_results (caller, idempotency_key, command, input_hash, result_json, at) VALUES (?, ?, ?, ?, ?, ?)', caller, key, command, inputHash, resultJson, now)
  }

  pruneIdempotentResults(olderThan: number): void {
    this.run('DELETE FROM idempotent_results WHERE at < ?', olderThan)
  }

  // Entities: values as the API sends them

  agentEntity(row: AgentRow, currentRelease: string, planShare: PlanWindow[] | null): AgentEntity {
    return {
      id: row.id,
      name: row.name,
      task: row.task,
      folder: row.folder,
      model: row.model,
      parent: row.parent,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      state: row.lifecycle.state,
      stateNote: row.stateNote,
      queuedDeliveries: this.countQueuedDeliveries(row.id),
      lastOutputAt: row.lastOutputAt,
      lastActivityAt: row.lastActivityAt,
      interruptedBy: row.interruptedBy,
      runningRelease: row.runnerRelease,
      runningOldRelease: row.runnerRelease !== null && row.runnerRelease !== currentRelease,
      costUsd: row.costUsd,
      cache: row.promptCache === null ? null : cacheStateOf(row.promptCache),
      planShare,
      lastTurnFailure: row.lastTurnFailure,
      branch: row.worktree === null ? null : { name: row.worktree.branch, base: row.worktree.base },
      ...(row.pulled === null ? {} : { pulled: row.pulled }),
    }
  }

  setAgentPulled(id: string, pulled: AgentPulled | null): void {
    this.run('UPDATE agents SET pulled_json = ? WHERE id = ?', pulled === null ? null : JSON.stringify(pulled), id)
    this.markChanged('agent', id)
  }

  messageEntity(row: MessageRow): MessageEntity {
    const deliveries = this.deliveriesOfMessage(row.id).map((delivery) => ({
      recipient: delivery.recipient,
      recipientAgentId: delivery.agentId,
      wake: delivery.wake,
      state: delivery.state,
    }))
    return {
      id: row.id, seq: row.seq, chatId: row.chatId, from: row.from, at: row.at, text: row.text, attachments: row.attachments,
      purpose: row.purpose, clientKey: row.clientKey, posesAskId: row.posesAskId, answersAskId: row.answersAskId, relayedBy: row.relayedBy, deliveries,
      remoteDeliveries: this.remoteDeliveriesOf(row.id),
    }
  }

  chatEntity(chatId: string): ChatEntity | null {
    const row = this.get<{ id: string; kind: 'direct' | 'group'; title: string | null; created_by: string; created_at: number; home_machine: string; latest_message_seq: number | null }>('SELECT * FROM chats WHERE id = ?', chatId)
    if (!row) return null
    const latest = row.latest_message_seq === null
      ? null
      : this.get<{ seq: number; from_address: string; at: number; text: string }>('SELECT seq, from_address, at, text FROM messages WHERE seq = ?', row.latest_message_seq) ?? null
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      members: this.chatMembers(chatId),
      createdBy: row.created_by,
      createdAt: row.created_at,
      homeMachine: row.home_machine,
      latestMessage: latest && { seq: latest.seq, from: latest.from_address, at: latest.at, text: latest.text.slice(0, 300) },
    }
  }

  listChatIds(): string[] {
    return this.all<{ id: string }>('SELECT id FROM chats ORDER BY created_at').map((row) => row.id)
  }

  readStateEntity(personId: string, chatId: string, viewerAddress: string): ReadStateEntity {
    const readThroughSeq = this.readThroughSeq(personId, chatId)
    return { id: readStateId(personId, chatId), chatId, readThroughSeq, unreadCount: this.countUnread(chatId, readThroughSeq, viewerAddress) }
  }

  personEntity(row: PersonRow): PersonEntity {
    return { id: row.id, name: row.name, address: row.address, isOwner: row.isOwner, joinedAt: row.joinedAt }
  }

  deviceEntity(row: DeviceRow): DeviceEntity {
    return { id: row.id, name: row.name, personId: row.personId, pairedAt: row.pairedAt, lastSeenAt: row.lastSeenAt }
  }

  listDevices(): DeviceRow[] {
    return this.all<Parameters<Store['toDeviceRow']>[0]>(`SELECT * FROM devices WHERE revoked_at IS NULL AND purpose = 'phone' ORDER BY paired_at`).map((row) => this.toDeviceRow(row))
  }

  // Asks

  insertAsk(ask: AskEntity): void {
    this.run('INSERT INTO asks (id, agent_id, agent_name, to_address, level, text, choices_json, source_json, at, snooze_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ask.id, ask.agentId, ask.agentName, ask.to, ask.level, ask.text, JSON.stringify(ask.choices), JSON.stringify(ask.source), ask.at, ask.snooze === null ? null : JSON.stringify(ask.snooze))
    this.markChanged('ask', ask.id)
  }

  private toAskEntity(row: Record<string, SqlValue>): AskEntity {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      agentName: row.agent_name as string,
      to: row.to_address as string,
      level: row.level as AskEntity['level'],
      text: row.text as string,
      choices: JSON.parse(row.choices_json as string) as string[],
      source: JSON.parse(row.source_json as string) as AskEntity['source'],
      at: row.at as number,
      snooze: row.snooze_json === null ? null : JSON.parse(row.snooze_json as string) as AskEntity['snooze'],
    }
  }

  openAskById(id: string): AskEntity | null {
    const row = this.get<Record<string, SqlValue>>('SELECT * FROM asks WHERE id = ? AND closed_at IS NULL', id)
    return row ? this.toAskEntity(row) : null
  }

  openAsksOfAgent(agentId: string): AskEntity[] {
    return this.all<Record<string, SqlValue>>('SELECT * FROM asks WHERE agent_id = ? AND closed_at IS NULL ORDER BY at', agentId).map((row) => this.toAskEntity(row))
  }

  closeAsk(id: string, now: number): void {
    this.run('UPDATE asks SET closed_at = ? WHERE id = ?', now, id)
    this.markDeleted('ask', id)
  }

  countAsksSince(agentId: string, level: AskEntity['level'], since: number): number {
    return this.get<{ count: number }>('SELECT count(*) AS count FROM asks WHERE agent_id = ? AND level = ? AND at >= ?', agentId, level, since)!.count
  }

  openAskIdsTo(address: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM asks WHERE closed_at IS NULL AND to_address = ?', address).map((row) => row.id)
  }

  listAskEntities(): AskEntity[] {
    return this.all<Record<string, SqlValue>>('SELECT * FROM asks WHERE closed_at IS NULL ORDER BY at').map((row) => this.toAskEntity(row))
  }

  // Goals: the record is the domain's, kept whole, since only the domain interprets it.

  goalOf(agentId: string): GoalRecord | null {
    const row = this.get<{ record_json: string }>('SELECT record_json FROM goals WHERE agent_id = ?', agentId)
    return row ? JSON.parse(row.record_json) as GoalRecord : null
  }

  saveGoal(goal: GoalRecord): void {
    this.run('INSERT INTO goals (agent_id, record_json) VALUES (?, ?) ON CONFLICT (agent_id) DO UPDATE SET record_json = excluded.record_json', goal.agentId, JSON.stringify(goal))
    this.markChanged('goal', goal.agentId)
  }

  deleteGoal(agentId: string): void {
    this.run('DELETE FROM goals WHERE agent_id = ?', agentId)
    this.markDeleted('goal', agentId)
  }

  listGoals(): GoalRecord[] {
    return this.all<{ record_json: string }>('SELECT record_json FROM goals').map((row) => JSON.parse(row.record_json) as GoalRecord)
  }

  setAskSnooze(id: string, snooze: AskEntity['snooze']): void {
    this.run('UPDATE asks SET snooze_json = ? WHERE id = ?', snooze === null ? null : JSON.stringify(snooze), id)
    this.markChanged('ask', id)
  }

  /** Open asks snoozed until something happens, of one kind. */
  openAsksSnoozedFor(kind: 'agent_done_or_idle' | 'person_back', filter: { agentId?: string; to?: string }): AskEntity[] {
    return this.listAskEntities().filter((ask) => ask.snooze?.kind === kind && (filter.agentId === undefined || ask.agentId === filter.agentId) && (filter.to === undefined || ask.to === filter.to))
  }

  // Summaries arrive with their slice; the snapshot's section exists already, so the shape won't change.
  // Summaries. The progress record is the domain's, kept whole.

  summaryProgressOf(agentId: string): SummaryProgress | null {
    const row = this.get<{ record_json: string }>('SELECT record_json FROM summary_progress WHERE agent_id = ?', agentId)
    return row ? JSON.parse(row.record_json) as SummaryProgress : null
  }

  /** The entity shows the latest failure, so saving progress is a change to it. */
  saveSummaryProgress(agentId: string, progress: SummaryProgress): void {
    const before = this.summaryProgressOf(agentId)
    this.run('INSERT INTO summary_progress (agent_id, record_json) VALUES (?, ?) ON CONFLICT (agent_id) DO UPDATE SET record_json = excluded.record_json', agentId, JSON.stringify(progress))
    if (JSON.stringify(before?.lastFailure ?? null) !== JSON.stringify(progress.lastFailure)) this.markChanged('summary', agentId)
  }

  addSummary(agentId: string, summary: Omit<SummaryRecord, 'number'> & { model: string; costUsd: number }): SummaryRecord {
    const previous = this.get<{ number: number }>('SELECT MAX(number) AS number FROM summaries WHERE agent_id = ?', agentId)
    const number = (previous?.number ?? 0) + 1
    this.run('INSERT INTO summaries (agent_id, number, at, line, details_json, covers_through_at, model, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      agentId, number, summary.at, summary.line, JSON.stringify(summary.details), summary.coversThroughAt, summary.model, summary.costUsd)
    this.markChanged('summary', agentId)
    return { number, at: summary.at, line: summary.line, details: summary.details, coversThroughAt: summary.coversThroughAt }
  }

  /** Newest first. */
  summariesOf(agentId: string, before: number | null, limit: number): { summaries: SummaryRecord[]; hasOlder: boolean } {
    const rows = this.all<SummaryRow>('SELECT number, at, line, details_json, covers_through_at FROM summaries WHERE agent_id = ? AND number < ? ORDER BY number DESC LIMIT ?',
      agentId, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    return { summaries: rows.slice(0, limit).map(summaryRecordOf), hasOlder: rows.length > limit }
  }

  liveLineOf(agentId: string): (LiveLine & { coveredThroughCursor: number }) | null {
    const row = this.get<{ at: number; line: string; covers_through_at: number; covered_through_cursor: number }>(
      'SELECT at, line, covers_through_at, covered_through_cursor FROM live_lines WHERE agent_id = ?', agentId)
    return row ? { at: row.at, line: row.line, coversThroughAt: row.covers_through_at, coveredThroughCursor: row.covered_through_cursor } : null
  }

  saveLiveLine(agentId: string, live: LiveLine & { coveredThroughCursor: number; model: string }): void {
    this.run(`INSERT INTO live_lines (agent_id, at, line, covers_through_at, covered_through_cursor, model) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id) DO UPDATE SET at = excluded.at, line = excluded.line, covers_through_at = excluded.covers_through_at,
      covered_through_cursor = excluded.covered_through_cursor, model = excluded.model`,
    agentId, live.at, live.line, live.coversThroughAt, live.coveredThroughCursor, live.model)
    this.markChanged('summary', agentId)
  }

  summaryEntity(agentId: string): SummaryEntity | null {
    const latest = this.summariesOf(agentId, null, 1).summaries[0] ?? null
    const lastFailure = this.summaryProgressOf(agentId)?.lastFailure ?? null
    const stored = this.liveLineOf(agentId)
    const live = stored && { at: stored.at, line: stored.line, coversThroughAt: stored.coversThroughAt }
    if (!latest && !lastFailure && !live) return null
    return { id: agentId, agentId, latest, live, lastFailure }
  }

  // Memory

  noteText(hash: string): string | null {
    return this.get<{ text: string }>('SELECT text FROM note_texts WHERE hash = ?', hash)?.text ?? null
  }

  saveNoteText(hash: string, text: string): void {
    this.run('INSERT OR IGNORE INTO note_texts (hash, text) VALUES (?, ?)', hash, text)
  }

  personalNote(file: string): PersonalNote | null {
    const row = this.get<PersonalNoteRow>('SELECT * FROM personal_notes WHERE file = ?', file)
    return row ? personalNoteOf(row) : null
  }

  listPersonalNotes(): PersonalNote[] {
    return this.all<PersonalNoteRow>('SELECT * FROM personal_notes ORDER BY file').map(personalNoteOf)
  }

  savePersonalNote(note: PersonalNote): void {
    this.run(
      'INSERT OR REPLACE INTO personal_notes (file, version_kind, hash, history_json, written_by, written_at) VALUES (?, ?, ?, ?, ?, ?)',
      note.file, note.version.kind, note.version.kind === 'live' ? note.version.hash : null, JSON.stringify(note.history), note.writtenBy, note.writtenAt,
    )
  }

  /** Which version of each personal note was last copied into a project's memory, or seen there. */
  personalNoteCopiesOf(projectKey: string): Map<string, string> {
    return new Map(this.all<{ file: string; hash: string }>('SELECT file, hash FROM personal_note_copies WHERE project_key = ?', projectKey).map((row) => [row.file, row.hash]))
  }

  setPersonalNoteCopy(projectKey: string, file: string, hash: string | null): void {
    if (hash === null) this.run('DELETE FROM personal_note_copies WHERE project_key = ? AND file = ?', projectKey, file)
    else this.run('INSERT OR REPLACE INTO personal_note_copies (project_key, file, hash) VALUES (?, ?, ?)', projectKey, file, hash)
  }

  /** For each note, the hash of the version this machine and a peer last agreed on. */
  noteBasesWithPeer(peerMachineId: string, scope: NoteScope): Map<string, string> {
    const rows = scope.kind === 'personal'
      ? this.all<{ file: string; hash: string }>('SELECT file, hash FROM personal_note_peer_bases WHERE peer_machine_id = ?', peerMachineId)
      : this.all<{ file: string; hash: string }>('SELECT file, hash FROM project_note_peer_bases WHERE peer_machine_id = ? AND project_key = ?', peerMachineId, scope.projectKey)
    return new Map(rows.map((row) => [row.file, row.hash]))
  }

  /** Null: they agree it is absent. */
  setNoteBaseWithPeer(peerMachineId: string, scope: NoteScope, file: string, hash: string | null): void {
    if (scope.kind === 'personal') {
      if (hash === null) this.run('DELETE FROM personal_note_peer_bases WHERE peer_machine_id = ? AND file = ?', peerMachineId, file)
      else this.run('INSERT OR REPLACE INTO personal_note_peer_bases (peer_machine_id, file, hash) VALUES (?, ?, ?)', peerMachineId, file, hash)
      return
    }
    if (hash === null) this.run('DELETE FROM project_note_peer_bases WHERE peer_machine_id = ? AND project_key = ? AND file = ?', peerMachineId, scope.projectKey, file)
    else this.run('INSERT OR REPLACE INTO project_note_peer_bases (peer_machine_id, project_key, file, hash) VALUES (?, ?, ?, ?)', peerMachineId, scope.projectKey, file, hash)
  }

  // Peers

  peerById(machineId: string): PeerRow | null {
    const row = this.get<PeerRecord>('SELECT * FROM peers WHERE machine_id = ?', machineId)
    return row ? peerRowOf(row) : null
  }

  peerByName(name: string): PeerRow | null {
    const row = this.get<PeerRecord>('SELECT * FROM peers WHERE name = ?', name)
    return row ? peerRowOf(row) : null
  }

  listPeers(): PeerRow[] {
    return this.all<PeerRecord>('SELECT * FROM peers ORDER BY name').map(peerRowOf)
  }

  /** A machine joining again keeps its trust and history of contact; its name, address and key are what it says now. A link
   * made this way, before networks, may speak unsigned until it signs with a network's key, if it is trusted fully. */
  savePeer(peer: { machineId: string; name: string; address: string; publicKey: string; trust: ComputerTrust; joinedAt: number }): void {
    this.run(
      `INSERT INTO peers (machine_id, name, address, public_key, trust, joined_at, unkeyed_allowed) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, address = excluded.address, public_key = excluded.public_key`,
      peer.machineId, peer.name, peer.address, peer.publicKey, peer.trust, peer.joinedAt, peer.trust === 'full' ? 1 : 0,
    )
    this.markChanged('computer', peer.machineId)
  }

  notePeerHello(machineId: string, at: number, hello: PeerHello): void {
    this.run('UPDATE peers SET last_seen_at = ?, hello_json = ? WHERE machine_id = ?', at, JSON.stringify(hello), machineId)
  }

  /** A machine heard from in a network, or named in an address book (`publicKey` ''): what it says now replaces what was
   * kept, but an address book never replaces a key already heard. */
  savePeerInNetwork(peer: { machineId: string; name: string; address: string; publicKey: string; networkId: string; visiting: boolean; ownerName: string | null; joinedAt: number }): void {
    this.run(
      `INSERT INTO peers (machine_id, name, address, public_key, trust, joined_at, network_id, visiting, unkeyed_allowed, owner_name) VALUES (?, ?, ?, ?, 'full', ?, ?, ?, 0, ?)
       ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, address = excluded.address,
         public_key = CASE WHEN excluded.public_key = '' THEN peers.public_key ELSE excluded.public_key END,
         network_id = excluded.network_id, visiting = excluded.visiting, owner_name = COALESCE(excluded.owner_name, peers.owner_name)`,
      peer.machineId, peer.name, peer.address, peer.publicKey, peer.joinedAt, peer.networkId, peer.visiting ? 1 : 0, peer.ownerName,
    )
    this.markChanged('computer', peer.machineId)
  }

  /** It signed with a network's key: where it lives now, and never again without a signature. A visitor stays one in that
   * network whatever it says: it lives there only once let in by an invite as a home. */
  notePeerNetwork(machineId: string, networkId: string, said: boolean): void {
    const before = this.peerById(machineId)
    const visiting = said || (before !== null && before.visiting && before.networkId === networkId)
    if (!before || (before.networkId === networkId && before.visiting === visiting && !before.unkeyedAllowed)) return
    this.run('UPDATE peers SET network_id = ?, visiting = ?, unkeyed_allowed = 0, trust = \'full\' WHERE machine_id = ?', networkId, visiting ? 1 : 0, machineId)
    this.markChanged('computer', machineId)
  }

  notePeerOwnerName(machineId: string, ownerName: string): void {
    this.run('UPDATE peers SET owner_name = ? WHERE machine_id = ? AND (owner_name IS NULL OR owner_name != ?)', ownerName, machineId, ownerName)
  }

  /** A link from before networks given a network: it lives there now, still unkeyed until it signs once. */
  setPeerNetwork(machineId: string, networkId: string | null): void {
    this.run('UPDATE peers SET network_id = ? WHERE machine_id = ?', networkId, machineId)
    this.markChanged('computer', machineId)
  }

  // Networks

  listNetworks(): NetworkRow[] {
    return this.all<NetworkRecord>("SELECT * FROM networks ORDER BY role = 'home' DESC, name").map(networkRowOf)
  }

  networkById(id: string): NetworkRow | null {
    const row = this.get<NetworkRecord>('SELECT * FROM networks WHERE id = ?', id)
    return row ? networkRowOf(row) : null
  }

  homeNetwork(): NetworkRow | null {
    const row = this.get<NetworkRecord>("SELECT * FROM networks WHERE role = 'home'")
    return row ? networkRowOf(row) : null
  }

  /** A network held again keeps its id; held as home, it replaces the home network held before, which is let go. */
  saveNetwork(network: { id: string; name: string; kind: NetworkKind; role: NetworkRole; addedAt: number }): void {
    if (network.role === 'home') this.run("DELETE FROM networks WHERE role = 'home' AND id != ?", network.id)
    this.run(
      `INSERT INTO networks (id, name, kind, role, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, role = excluded.role`,
      network.id, network.name, network.kind, network.role, network.addedAt,
    )
    this.markChanged('server', 'server')
  }

  deleteNetwork(id: string): void {
    this.run('DELETE FROM networks WHERE id = ?', id)
    this.markChanged('server', 'server')
  }

  setNetworkInvite(id: string, inviteHash: string | null, expiresAt: number | null): void {
    this.run('UPDATE networks SET invite_hash = ?, invite_expires_at = ? WHERE id = ?', inviteHash, expiresAt, id)
  }

  setPeerTrust(machineId: string, trust: ComputerTrust): void {
    this.run('UPDATE peers SET trust = ?, unkeyed_allowed = ? WHERE machine_id = ?', trust, trust === 'full' ? 1 : 0, machineId)
    this.markChanged('computer', machineId)
  }

  deletePeer(machineId: string): void {
    this.run('DELETE FROM peers WHERE machine_id = ?', machineId)
    this.run('DELETE FROM owner_chat_peers WHERE peer_machine_id = ?', machineId)
    this.run('DELETE FROM personal_note_peer_bases WHERE peer_machine_id = ?', machineId)
    this.run('DELETE FROM project_note_peer_bases WHERE peer_machine_id = ?', machineId)
    for (const { id } of this.all<{ id: string }>('SELECT id FROM remote_asks WHERE peer_machine_id = ?', machineId)) this.removeRemoteAsk(id)
    this.markDeleted('computer', machineId)
  }

  // Copies of open asks that agents on peers put to the person here

  /** `notifiedAt`: it is pushed as it comes. */
  insertRemoteAsk(ask: { id: string; peerMachineId: string; agentName: string; level: AskLevel; text: string; choices: string[]; askedAt: number; chatId: string; senderPushTokenHashes: string[]; notifiedAt: number }): void {
    this.run('INSERT INTO remote_asks (id, peer_machine_id, agent_name, level, text, choices_json, asked_at, chat_id, sender_push_token_hashes_json, last_notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ask.id, ask.peerMachineId, ask.agentName, ask.level, ask.text, JSON.stringify(ask.choices), ask.askedAt, ask.chatId, JSON.stringify(ask.senderPushTokenHashes), ask.notifiedAt)
    this.markChanged('remote_ask', ask.id)
  }

  setRemoteAskSnooze(id: string, snooze: AskSnooze | null): void {
    this.run('UPDATE remote_asks SET snooze_json = ? WHERE id = ?', snooze === null ? null : JSON.stringify(snooze), id)
    this.markChanged('remote_ask', id)
  }

  setRemoteAskNotifiedAt(id: string, at: number): void {
    this.run('UPDATE remote_asks SET last_notified_at = ? WHERE id = ?', at, id)
  }

  /** The phones the ask's own computer pushes, which this one leaves to it: those it pushed the ask to, and those its last
   * hello names, which covers a copy made before copies kept them. */
  remoteAskSenderPushTokenHashes(id: string): string[] {
    const row = this.get<{ sender_push_token_hashes_json: string; peer_machine_id: string }>('SELECT sender_push_token_hashes_json, peer_machine_id FROM remote_asks WHERE id = ?', id)
    if (!row) return []
    const named = this.peerById(row.peer_machine_id)?.hello?.ownerPushTokenHashes ?? []
    return [...new Set([...JSON.parse(row.sender_push_token_hashes_json) as string[], ...named])]
  }

  remoteAsksLastNotifiedBefore(before: number): (RemoteAskEntity & { lastNotifiedAt: number })[] {
    return this.all<RemoteAskRow>(`${REMOTE_ASK_SELECT} WHERE remote_asks.last_notified_at < ?`, before)
      .map((row) => ({ ...remoteAskEntityOf(row), lastNotifiedAt: row.last_notified_at }))
  }

  /** Whether it was here to remove. */
  removeRemoteAsk(id: string): boolean {
    const removed = this.run('DELETE FROM remote_asks WHERE id = ?', id).changes > 0
    if (removed) this.markDeleted('remote_ask', id)
    return removed
  }

  remoteAskById(id: string): RemoteAskEntity | null {
    const row = this.get<RemoteAskRow>(`${REMOTE_ASK_SELECT} WHERE remote_asks.id = ?`, id)
    return row ? remoteAskEntityOf(row) : null
  }

  remoteAskIdsOfAgent(peerMachineId: string, agentName: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM remote_asks WHERE peer_machine_id = ? AND agent_name = ?', peerMachineId, agentName).map((row) => row.id)
  }

  listRemoteAskEntities(): RemoteAskEntity[] {
    return this.all<RemoteAskRow>(`${REMOTE_ASK_SELECT} ORDER BY remote_asks.asked_at`).map(remoteAskEntityOf)
  }

  // The person's other computers that show an agent's chat with the person

  addOwnerChatPeer(agentId: string, peerMachineId: string, now: number): void {
    this.run('INSERT INTO owner_chat_peers (agent_id, peer_machine_id, since) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', agentId, peerMachineId, now)
  }

  ownerChatPeersOf(agentId: string): string[] {
    return this.all<{ peer_machine_id: string }>('SELECT peer_machine_id FROM owner_chat_peers WHERE agent_id = ? ORDER BY since', agentId).map((row) => row.peer_machine_id)
  }

  // The outbox to other machines

  /** `recipient`: who it is for, as a sender's message shows it; for a group update, the machine. */
  enqueueForPeer(entry: { peerMachineId: string; request: PeerOutboxRequest; messageId: string | null; recipient: string; now: number }): void {
    this.run(
      `INSERT INTO peer_outbox (peer_machine_id, route, message_id, recipient, request_json, state, queued_at, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
      entry.peerMachineId, entry.request.route, entry.messageId, entry.recipient, JSON.stringify(entry.request.body), entry.now, entry.now,
    )
    if (entry.messageId !== null) this.markChanged('message', entry.messageId)
  }

  /** Whether a request for another machine waits that has been tried fewer than `attempts` times. */
  hasPeerOutboxTriedFewerThan(attempts: number): boolean {
    return this.get(`SELECT 1 FROM peer_outbox WHERE state = 'queued' AND attempts < ? LIMIT 1`, attempts) !== undefined
  }

  /** The next request for a machine: the oldest still queued. Later ones wait for it, so they arrive in order. */
  headOfPeerOutbox(peerMachineId: string): PeerOutboxEntry | null {
    const row = this.get<{ seq: number; route: PeerOutboxRequest['route']; message_id: string | null; request_json: string; attempts: number; next_attempt_at: number }>(
      `SELECT seq, route, message_id, request_json, attempts, next_attempt_at FROM peer_outbox WHERE peer_machine_id = ? AND state = 'queued' ORDER BY seq LIMIT 1`, peerMachineId,
    )
    if (!row) return null
    return { seq: row.seq, messageId: row.message_id, request: { route: row.route, body: JSON.parse(row.request_json) } as PeerOutboxRequest, attempts: row.attempts, nextAttemptAt: row.next_attempt_at }
  }

  notePeerOutboxAttemptFailed(seq: number, nextAttemptAt: number): void {
    this.run('UPDATE peer_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE seq = ?', nextAttemptAt, seq)
    this.markOutboxMessageChanged(seq)
  }

  settlePeerOutbox(seq: number, outcome: { state: 'accepted'; at: number } | { state: 'undeliverable'; at: number; reason: string }): void {
    this.run('UPDATE peer_outbox SET state = ?, settled_at = ?, reason = ? WHERE seq = ?', outcome.state, outcome.at, outcome.state === 'undeliverable' ? outcome.reason : null, seq)
    this.markOutboxMessageChanged(seq)
  }

  private markOutboxMessageChanged(seq: number): void {
    const messageId = this.get<{ message_id: string | null }>('SELECT message_id FROM peer_outbox WHERE seq = ?', seq)?.message_id
    if (messageId) this.markChanged('message', messageId)
  }

  /** A machine that is gone takes nothing more: what still waits for it is undeliverable. */
  abandonPeerOutbox(peerMachineId: string, reason: string, at: number): void {
    const waiting = this.all<{ message_id: string | null }>(`SELECT message_id FROM peer_outbox WHERE peer_machine_id = ? AND state = 'queued'`, peerMachineId)
    this.run(`UPDATE peer_outbox SET state = 'undeliverable', settled_at = ?, reason = ? WHERE peer_machine_id = ? AND state = 'queued'`, at, reason, peerMachineId)
    for (const { message_id: messageId } of waiting) if (messageId) this.markChanged('message', messageId)
  }

  /** A group's copy as its home has it: the chat made the first time, its members replaced each time. */
  /** Whether this is the first time: a post of a group whose home is elsewhere is pushed here once. */
  noteGroupPostPushed(messageId: string): boolean {
    return this.run('INSERT OR IGNORE INTO group_posts_pushed (message_id) VALUES (?)', messageId).changes > 0
  }

  saveGroupCopy(copy: { id: string; title: string | null; createdBy: string; createdAt: number; homeMachine: string; members: { address: string; joinedAt: number }[] }): void {
    if (!this.chatExists(copy.id)) {
      this.insertChat({ ...copy, kind: 'group' })
      return
    }
    this.run('DELETE FROM chat_members WHERE chat_id = ?', copy.id)
    for (const member of copy.members) this.run('INSERT INTO chat_members (chat_id, address, joined_at) VALUES (?, ?, ?)', copy.id, member.address, member.joinedAt)
    this.markChanged('chat', copy.id)
  }

  remoteDeliveriesOf(messageId: string): RemoteDelivery[] {
    return this.all<{ recipient: string; state: 'queued' | 'accepted' | 'undeliverable'; queued_at: number; attempts: number; settled_at: number | null; reason: string | null }>(
      // A group's own updates to its members' machines are the home's business, not the post's sender's; copies of what an
      // agent said to the person, for the person's other computers, are not deliveries to anyone.
      `SELECT recipient, state, queued_at, attempts, settled_at, reason FROM peer_outbox WHERE message_id = ? AND route NOT IN ('/group-updates', '/owner-messages', '/owner-asks') ORDER BY seq`, messageId,
    ).map((row) => ({
      recipient: row.recipient,
      state: row.state === 'queued'
        ? { state: 'queued', since: row.queued_at, attempts: row.attempts }
        : row.state === 'accepted' ? { state: 'accepted', at: row.settled_at! } : { state: 'undeliverable', at: row.settled_at!, reason: row.reason ?? '' },
    }))
  }

  // Notifications

  notificationSettingsOf(personId: string): NotificationSettings {
    const row = this.get<{ settings_json: string }>('SELECT settings_json FROM notification_settings WHERE person_id = ?', personId)
    return row ? JSON.parse(row.settings_json) as NotificationSettings : DEFAULT_NOTIFICATION_SETTINGS
  }

  saveNotificationSettings(personId: string, settings: NotificationSettings): void {
    this.run('INSERT INTO notification_settings (person_id, settings_json) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET settings_json = excluded.settings_json', personId, JSON.stringify(settings))
    this.markChanged('notification_settings', personId, personId)
  }

  setDevicePushToken(deviceId: string, registration: PushTokenRegistration | null): void {
    this.run('UPDATE devices SET push_json = ? WHERE id = ?', registration === null ? null : JSON.stringify(registration), deviceId)
  }

  /** The person's phones that can take a push. */
  pushTargetsOf(personId: string): { deviceId: string; registration: PushTokenRegistration }[] {
    return this.all<{ id: string; push_json: string }>(
      "SELECT id, push_json FROM devices WHERE person_id = ? AND revoked_at IS NULL AND purpose = 'phone' AND push_json IS NOT NULL", personId,
    ).map((row) => ({ deviceId: row.id, registration: JSON.parse(row.push_json) as PushTokenRegistration }))
  }

  /** The message that posed this ask, if a message did. */
  messageIdPosingAsk(askId: string): string | null {
    return this.get<{ id: string }>('SELECT id FROM messages WHERE poses_ask_id = ? LIMIT 1', askId)?.id ?? null
  }

  /** The chat of the message that posed this ask, if a message did. */
  chatOfAsk(askId: string): string | null {
    return this.get<{ chat_id: string }>('SELECT chat_id FROM messages WHERE poses_ask_id = ? LIMIT 1', askId)?.chat_id ?? null
  }

  /** What the app's icon badge counts: unread across the person's direct chats with listed (not archived or moved) agents, as the app counts. */
  unreadWithAgents(person: PersonRow): number {
    const chatIds = this.all<{ chat_id: string }>(
      `SELECT m.chat_id FROM chat_members m JOIN chats c ON c.id = m.chat_id
       WHERE m.address = ? AND c.kind = 'direct'
         AND EXISTS (SELECT 1 FROM chat_members o JOIN agents a ON a.name = o.address WHERE o.chat_id = m.chat_id AND o.address <> ?
                       AND a.state_name NOT IN ('archived', 'moved'))`,
      person.address, person.address).map((row) => row.chat_id)
    return chatIds.reduce((total, chatId) => total + this.countUnread(chatId, this.readThroughSeq(person.id, chatId), person.address), 0)
  }

  /** Open asks not pushed since `before`: candidates for a reminder. */
  asksLastNotifiedBefore(before: number): (AskEntity & { lastNotifiedAt: number })[] {
    return this.all<{ id: string; last_notified_at: number }>('SELECT id, last_notified_at FROM asks WHERE closed_at IS NULL AND last_notified_at IS NOT NULL AND last_notified_at < ?', before)
      .flatMap((row) => {
        const ask = this.openAskById(row.id)
        return ask ? [{ ...ask, lastNotifiedAt: row.last_notified_at }] : []
      })
  }

  setAskNotifiedAt(askId: string, at: number): void {
    this.run('UPDATE asks SET last_notified_at = ? WHERE id = ?', at, askId)
  }

  listSummaryEntities(): SummaryEntity[] {
    const agentIds = this.all<{ agent_id: string }>('SELECT agent_id FROM summaries UNION SELECT agent_id FROM summary_progress UNION SELECT agent_id FROM live_lines').map((row) => row.agent_id)
    return agentIds.map((agentId) => this.summaryEntity(agentId)).filter((entity) => entity !== null)
  }
}

export const readStateId = (personId: string, chatId: string): string => `${personId}:${chatId}`


type LiveLine = NonNullable<SummaryEntity['live']>

interface SummaryRow { number: number; at: number; line: string; details_json: string; covers_through_at: number }

const summaryRecordOf = (row: SummaryRow): SummaryRecord => ({
  number: row.number, at: row.at, line: row.line, details: JSON.parse(row.details_json) as string[], coversThroughAt: row.covers_through_at,
})

interface PersonalNoteRow { file: string; version_kind: 'live' | 'deleted'; hash: string | null; history_json: string; written_by: string; written_at: number }

function personalNoteOf(row: PersonalNoteRow): PersonalNote {
  return {
    file: row.file,
    version: row.version_kind === 'live' ? { kind: 'live', hash: row.hash! } : { kind: 'deleted' },
    history: JSON.parse(row.history_json) as string[],
    writtenBy: row.written_by,
    writtenAt: row.written_at,
  }
}

/** Which notes: those about the person, or one project's shared notes. */
export type NoteScope = { kind: 'personal' } | { kind: 'project'; projectKey: string }

interface RemoteAskRow { id: string; peer_machine_id: string; peer_name: string; agent_name: string; level: AskLevel; text: string; choices_json: string; asked_at: number; chat_id: string; snooze_json: string | null; last_notified_at: number }
const REMOTE_ASK_SELECT = 'SELECT remote_asks.*, peers.name AS peer_name FROM remote_asks JOIN peers ON peers.machine_id = remote_asks.peer_machine_id'

function remoteAskEntityOf(row: RemoteAskRow): RemoteAskEntity {
  return {
    id: row.id,
    computerId: row.peer_machine_id,
    remoteAgentId: `${row.peer_machine_id}:${row.agent_name}`,
    agentName: row.agent_name,
    address: `${row.agent_name}@${row.peer_name}`,
    level: row.level,
    text: row.text,
    choices: JSON.parse(row.choices_json) as string[],
    at: row.asked_at,
    chatId: row.chat_id,
    snooze: row.snooze_json === null ? null : JSON.parse(row.snooze_json) as AskSnooze,
  }
}

export type PeerOutboxRequest =
  | { route: '/messages'; body: PeerMessage }
  | { route: '/owner-messages'; body: PeerOwnerMessage }
  | { route: '/owner-asks'; body: PeerOwnerAsk }
  | { route: '/group-updates'; body: PeerGroupUpdate }
  | { route: '/group-posts'; body: PeerGroupPost }

export interface PeerOutboxEntry {
  seq: number
  messageId: string | null
  request: PeerOutboxRequest
  attempts: number
  nextAttemptAt: number
}

export interface PeerRow {
  machineId: string
  name: string
  address: string
  /** '': known only from an address book, not yet heard from. */
  publicKey: string
  trust: ComputerTrust
  joinedAt: number
  lastSeenAt: number | null
  /** What it last said in a hello; null until it has. */
  hello: PeerHello | null
  /** The network it lives in, of this server's; null: none of them. */
  networkId: string | null
  /** It lives elsewhere and visits this server's home network with an extra key. */
  visiting: boolean
  /** A full trust link from before networks that hasn't yet signed with a network's key. */
  unkeyedAllowed: boolean
  ownerName: string | null
}

export interface NetworkRow { id: string; name: string; kind: NetworkKind; role: NetworkRole; addedAt: number; inviteHash: string | null; inviteExpiresAt: number | null }

interface PeerRecord { machine_id: string; name: string; address: string; public_key: string; trust: ComputerTrust; joined_at: number; last_seen_at: number | null; hello_json: string | null; network_id: string | null; visiting: number; unkeyed_allowed: number; owner_name: string | null }
interface NetworkRecord { id: string; name: string; kind: NetworkKind; role: NetworkRole; added_at: number; invite_hash: string | null; invite_expires_at: number | null }

function networkRowOf(row: NetworkRecord): NetworkRow {
  return { id: row.id, name: row.name, kind: row.kind, role: row.role, addedAt: row.added_at, inviteHash: row.invite_hash, inviteExpiresAt: row.invite_expires_at }
}

function peerRowOf(row: PeerRecord): PeerRow {
  return {
    machineId: row.machine_id,
    name: row.name,
    address: row.address,
    publicKey: row.public_key,
    trust: row.trust,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    // Parsed, so a hello kept from an older machine gains the fields it didn't say.
    hello: row.hello_json === null ? null : PeerHello.parse(JSON.parse(row.hello_json)),
    networkId: row.network_id,
    visiting: row.visiting === 1,
    unkeyedAllowed: row.unkeyed_allowed === 1,
    ownerName: row.owner_name,
  }
}
