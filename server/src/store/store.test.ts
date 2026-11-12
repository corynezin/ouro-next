import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { migrations, runMigration } from './schema.ts'
import { Store } from './store.ts'

test('the change log keeps only the latest change per entity', () => {
  const store = new Store(':memory:')
  store.markChanged('agent', 'a')
  store.markChanged('agent', 'b')
  store.markChanged('agent', 'a')
  assert.deepEqual(store.changesAfter(0, 'p', 10).map((row) => [row.entityId, row.cursor]), [['b', 2], ['a', 3]])
  store.close()
})

test('a deletion stays as a tombstone for a client that was offline', () => {
  const store = new Store(':memory:')
  store.markChanged('agent', 'gone')
  const clientCursor = store.currentCursor()
  store.markChanged('agent', 'other')
  store.markDeleted('agent', 'gone')
  for (let unrelated = 0; unrelated < 100; unrelated++) store.markChanged('agent', `busy-${unrelated}`)
  const missed = store.changesAfter(clientCursor, 'p', 1000)
  const tombstone = missed.find((row) => row.entityId === 'gone')
  assert.ok(tombstone, 'the deletion must still be in the log')
  assert.equal(tombstone.deleted, true)
  // The tombstone is ordered by when the deletion happened, so catching up from before it still reaches it in place.
  assert.ok(tombstone.cursor > clientCursor)
  store.close()
})

test('a change to one viewer is visible only to that viewer', () => {
  const store = new Store(':memory:')
  store.markChanged('read_state', 'mine', 'p1')
  store.markChanged('agent', 'everyone')
  assert.deepEqual(store.changesAfter(0, 'p2', 10).map((row) => row.entityId), ['everyone'])
  assert.deepEqual(store.changesAfter(0, 'p1', 10).map((row) => row.entityId), ['mine', 'everyone'])
  store.close()
})

test('a failed transaction leaves nothing behind', () => {
  const store = new Store(':memory:')
  assert.throws(() => store.transaction(() => {
    store.markChanged('agent', 'x')
    throw new Error('boom')
  }))
  assert.equal(store.currentCursor(), 0)
  store.close()
})

test('reopening a database does not rerun migrations', () => {
  const store = new Store(':memory:')
  assert.ok(store.schemaVersion() >= 1)
  store.close()
})

test('a delivery left in a turn by a schema 21 server is taken in, and older code is told it can\'t read the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-store-'))
  try {
    const path = join(dir, 'ouro.db')
    const old = new DatabaseSync(path)
    for (const migration of migrations.slice(0, 21)) runMigration(old, migration)
    old.exec('PRAGMA user_version = 21; PRAGMA foreign_keys = OFF')
    const inTurn = { state: 'in_turn', since: 5, turnId: 't', attemptId: 'a', possiblySeen: false }
    old.prepare(`INSERT INTO deliveries (id, message_id, message_seq, recipient, agent_id, wake, state_name, state_json) VALUES ('d', 'm', 1, 'alice', 'agent', 'wake', 'in_turn', ?)`).run(JSON.stringify(inTurn))
    old.close()

    const store = new Store(path)
    assert.deepEqual(store.deliveriesOfAgentInTurn('agent').map((delivery) => delivery.state), [{ ...inTurn, state: 'taken_in' }])
    assert.ok(Number(store.getMeta('data_readable_by_schema_from')) >= 22, 'a later contract may raise it further')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a schema 23 plan reading's windows take its time as when each was read", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-store-'))
  try {
    const path = join(dir, 'ouro.db')
    const old = new DatabaseSync(path)
    for (const migration of migrations.slice(0, 23)) runMigration(old, migration)
    old.exec('PRAGMA user_version = 23; PRAGMA foreign_keys = OFF')
    const fiveHour = { windowMinutes: 300, usedFraction: 0.1, resetsAt: 50, status: 'allowed' }
    const weekly = { windowMinutes: 10_080, usedFraction: 0.2, resetsAt: 90, status: null }
    old.prepare(`INSERT INTO plan_readings (account, reading_json) VALUES ('claude', ?), ('chatgpt', ?)`).run(JSON.stringify({ windows: [fiveHour, weekly], observedAt: 7 }), JSON.stringify({ windows: [], observedAt: 8 }))
    old.close()

    const store = new Store(path)
    assert.deepEqual(store.planReading('claude'), { windows: [{ ...fiveHour, observedAt: 7 }, { ...weekly, observedAt: 7 }], observedAt: 7 })
    assert.deepEqual(store.planReading('chatgpt'), { windows: [], observedAt: 8 })
    assert.equal(store.getMeta('data_readable_by_schema_from'), '24')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a schema 24 copy of an ask from another computer is not snoozed and was last pushed when it was asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-store-'))
  try {
    const path = join(dir, 'ouro.db')
    const old = new DatabaseSync(path)
    for (const migration of migrations.slice(0, 24)) runMigration(old, migration)
    old.exec('PRAGMA user_version = 24; PRAGMA foreign_keys = OFF')
    old.exec(`INSERT INTO peers (machine_id, name, address, public_key, trust, joined_at) VALUES ('m', 'beta', 'http://beta', 'k', 'full', 1)`)
    old.exec(`INSERT INTO remote_asks (id, peer_machine_id, agent_name, level, text, choices_json, asked_at, chat_id) VALUES ('a', 'm', 'asker', 'blocked', 'Ship it?', '[]', 40, 'c')`)
    old.close()

    const store = new Store(path)
    assert.equal(store.remoteAskById('a')?.snooze, null)
    assert.deepEqual(store.remoteAsksLastNotifiedBefore(41).map((copy) => [copy.id, copy.lastNotifiedAt]), [['a', 40]])
    assert.deepEqual(store.remoteAskSenderPushTokenHashes('a'), [])
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a copy of an ask leaves to its computer the phones it was pushed to there and those that computer's last hello names", () => {
  const store = new Store(':memory:')
  store.savePeer({ machineId: 'm', name: 'beta', address: 'http://beta', publicKey: 'k', trust: 'full', joinedAt: 1 })
  store.insertChat({ id: 'c', kind: 'direct', title: null, createdBy: 'asker@beta', createdAt: 1, homeMachine: 'alpha', members: [] })
  store.transaction(() => {
    store.insertRemoteAsk({ id: 'old', peerMachineId: 'm', agentName: 'asker', level: 'blocked', text: 'Ship it?', choices: [], askedAt: 1, chatId: 'c', senderPushTokenHashes: [], notifiedAt: 1 })
    store.insertRemoteAsk({ id: 'new', peerMachineId: 'm', agentName: 'asker', level: 'blocked', text: 'Deploy?', choices: [], askedAt: 2, chatId: 'c', senderPushTokenHashes: ['h1'], notifiedAt: 2 })
  })
  assert.deepEqual(store.remoteAskSenderPushTokenHashes('old'), [], 'nothing said yet')
  store.notePeerHello('m', 3, { protocol: 5, minProtocol: 1, release: 'r', agentsRunning: 0, agentCount: 1, sleeps: false, heldAwake: false, ownerPushTokenHashes: ['h1', 'h2'] })
  assert.deepEqual(store.remoteAskSenderPushTokenHashes('old'), ['h1', 'h2'], 'a copy made before copies kept them')
  assert.deepEqual(store.remoteAskSenderPushTokenHashes('new'), ['h1', 'h2'])
  store.close()
})

test('a client is sent changes of an opt-in kind only when it asks for them', () => {
  const store = new Store(':memory:')
  store.markChanged('agent', 'a')
  store.markChanged('pin', 'p1', 'p')
  assert.deepEqual(store.changesAfter(0, 'p', 10).map((row) => row.entity), ['agent', 'pin'])
  assert.deepEqual(store.changesAfter(0, 'p', 10, ['pin']).map((row) => row.entity), ['agent'])
  store.close()
})

test('a savepoint that throws undoes only its own writes, and the transaction around it goes on', () => {
  const store = new Store(':memory:')
  store.transaction(() => {
    store.setMeta('kept', '1')
    assert.throws(() => store.savepoint(() => {
      store.setMeta('undone', '1')
      throw new Error('refused')
    }), /refused/)
    store.setMeta('after', '1')
  })
  assert.equal(store.getMeta('kept'), '1')
  assert.equal(store.getMeta('undone'), null)
  assert.equal(store.getMeta('after'), '1')
  assert.throws(() => store.savepoint(() => 1), /inside a transaction/)
  store.close()
})

test("a database that ran the 27 and 28 from before base 6 is brought to base 6's shape, its pins kept", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-store-'))
  try {
    const path = join(dir, 'ouro.db')
    const old = new DatabaseSync(path)
    for (const migration of migrations.slice(0, 26)) runMigration(old, migration)
    // The 27 and 28 from before base 6: pins by kind, reference and position, and networks without 28's later additions.
    const own27 = (migrations[26] as string).replace(/target_key TEXT NOT NULL,\s*target_json TEXT NOT NULL,/, "target_kind TEXT NOT NULL, target_ref TEXT NOT NULL, position REAL NOT NULL,")
      .replace('UNIQUE (person_id, target_key)', 'UNIQUE (person_id, target_kind, target_ref)')
    const own28 = (migrations[27] as string).split('ALTER TABLE people ADD COLUMN origin_machine_id')[0]!
    assert.notEqual(own27, migrations[26])
    old.exec(own27)
    old.exec(own28)
    old.exec(migrations[28] as string)
    old.exec('PRAGMA user_version = 29; PRAGMA foreign_keys = OFF')
    old.exec(`INSERT INTO people (id, name, address, is_owner, joined_at) VALUES ('p', 'Owner', 'human', 1, 1)`)
    old.exec(`INSERT INTO pins (id, person_id, target_kind, target_ref, position, pinned_at) VALUES ('a', 'p', 'agent', 'ag1', 0, 5), ('b', 'p', 'remote_agent', 'x@beta', 1, 6), ('c', 'p', 'chat', 'ch1', 2, 7)`)
    old.close()

    const store = new Store(path)
    assert.deepEqual(store.listPins('p').map((pin) => pin.target), [
      { kind: 'agent', agentId: 'ag1' }, { kind: 'remote_agent', address: 'x@beta' }, { kind: 'chat', chatId: 'ch1' },
    ])
    assert.equal(store.pinOf('p', { kind: 'chat', chatId: 'ch1' })?.id, 'c')
    store.close()
    const after = new DatabaseSync(path)
    const columns = (table: string) => (after.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
    assert.ok(columns('people').includes('origin_machine_id'))
    assert.ok(columns('network_removed_peers').includes('machine_id'))
    assert.ok(columns('pins').includes('target_kind'), 'a release from before still finds its columns')
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a database that ran base 6's own 27 and 28 is left as it was, its pins kept", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-store-'))
  try {
    const path = join(dir, 'ouro.db')
    const old = new DatabaseSync(path)
    for (const migration of migrations.slice(0, 29)) runMigration(old, migration)
    old.exec('PRAGMA user_version = 29; PRAGMA foreign_keys = OFF')
    old.exec(`INSERT INTO people (id, name, address, is_owner, joined_at) VALUES ('p', 'Owner', 'human', 1, 1)`)
    old.exec(`INSERT INTO pins (id, person_id, target_key, target_json, pinned_at) VALUES ('a', 'p', 'agent:ag1', '{"kind":"agent","agentId":"ag1"}', 5)`)
    const shape = (db: DatabaseSync) => db.prepare(`SELECT type, name, sql FROM sqlite_schema ORDER BY name`).all()
    const before = shape(old)
    old.close()

    const store = new Store(path)
    assert.deepEqual(store.listPins('p').map((pin) => pin.target), [{ kind: 'agent', agentId: 'ag1' }])
    store.close()
    const after = new DatabaseSync(path)
    assert.deepEqual(shape(after), before)
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
