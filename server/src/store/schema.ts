// Migrations are expand-then-contract only. A rollback restores code, not data, so a release must keep working on a
// schema newer than itself until the older releases that could return are gone.
export const migrations: readonly string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL UNIQUE,
    is_owner INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    removed_at INTEGER
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    person_id TEXT NOT NULL REFERENCES people(id),
    token_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT 'phone',
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  ) STRICT;

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    invitee_person_name TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  ) STRICT;

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task TEXT NOT NULL,
    folder TEXT NOT NULL,
    model TEXT NOT NULL,
    parent TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state_name TEXT NOT NULL,
    state_json TEXT NOT NULL,
    state_note TEXT,
    instance_generation INTEGER NOT NULL,
    consecutive_crashes INTEGER NOT NULL,
    provider_session_id TEXT,
    runner_pid INTEGER,
    runner_release TEXT,
    journal_cursor INTEGER NOT NULL DEFAULT 0,
    last_output_at INTEGER,
    last_activity_at INTEGER NOT NULL,
    interrupted_by TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    credential_hash TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE UNIQUE INDEX agents_active_name ON agents(name) WHERE state_name <> 'archived';
  CREATE INDEX agents_state ON agents(state_name);

  CREATE TABLE agent_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    generation INTEGER NOT NULL,
    cause TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX agent_transitions_agent ON agent_transitions(agent_id, id);

  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    home_machine TEXT NOT NULL,
    latest_message_seq INTEGER
  ) STRICT;

  CREATE TABLE chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id),
    address TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, address)
  ) STRICT;
  CREATE INDEX chat_members_address ON chat_members(address);

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    from_address TEXT NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    attachments_json TEXT NOT NULL,
    purpose TEXT NOT NULL,
    client_key TEXT,
    poses_ask_id TEXT,
    answers_ask_id TEXT
  ) STRICT;
  CREATE INDEX messages_chat ON messages(chat_id, seq);

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    message_seq INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    wake TEXT NOT NULL,
    state_name TEXT NOT NULL,
    state_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX deliveries_message ON deliveries(message_id);
  CREATE INDEX deliveries_agent_state ON deliveries(agent_id, state_name, message_seq);

  CREATE TABLE delivery_attempts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    turn_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX delivery_attempts_delivery ON delivery_attempts(delivery_id);

  CREATE TABLE read_marks (
    person_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    read_through_seq INTEGER NOT NULL,
    PRIMARY KEY (person_id, chat_id)
  ) STRICT;

  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    agent_name TEXT NOT NULL,
    to_address TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    choices_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    snooze_json TEXT,
    closed_at INTEGER
  ) STRICT;
  CREATE INDEX asks_open ON asks(agent_id) WHERE closed_at IS NULL;

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE idempotent_results (
    caller TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    command TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (caller, idempotency_key)
  ) STRICT;
  CREATE INDEX idempotent_results_at ON idempotent_results(at);

  -- The latest change per entity. Replacing a row gives it a new, higher cursor, so the log stays the size of the entities
  -- and a client catching up sees each entity once. Values are read from the entity tables when sent. A deleted entity
  -- keeps its row (deleted = 1) forever: that tombstone is how a client that was offline learns of the deletion.
  CREATE TABLE changes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    audience_person_id TEXT,
    deleted INTEGER NOT NULL,
    UNIQUE (entity, entity_id)
  ) STRICT;
  `,
  // 2: goals, and spacing out credit retries. Expand only: older code ignores both.
  `
  ALTER TABLE agents ADD COLUMN consecutive_credit_failures INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE goals (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    record_json TEXT NOT NULL
  ) STRICT;
  `,
  // 3: phone updates. Expand only.
  `
  CREATE TABLE app_updates (
    update_number INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    source_commit TEXT,
    created_at INTEGER NOT NULL,
    launch_asset_json TEXT NOT NULL,
    assets_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX app_updates_runtime ON app_updates(platform, runtime_version, update_number);
  `,
  // 4: a failed turn the app explains. Expand only.
  `
  ALTER TABLE agents ADD COLUMN last_turn_failure_json TEXT;
  `,
  // 5: summaries. Expand only.
  `
  CREATE TABLE summaries (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    number INTEGER NOT NULL,
    at INTEGER NOT NULL,
    line TEXT NOT NULL,
    details_json TEXT NOT NULL,
    covers_through_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    PRIMARY KEY (agent_id, number)
  ) STRICT;
  CREATE TABLE summary_progress (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE live_lines (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    at INTEGER NOT NULL,
    line TEXT NOT NULL,
    covers_through_at INTEGER NOT NULL,
    covered_through_cursor INTEGER NOT NULL,
    model TEXT NOT NULL
  ) STRICT;
  `,
  // 6: a person's words carried by the master agent say so. Expand only.
  `
  ALTER TABLE messages ADD COLUMN relayed_by TEXT;
  `,
  // 7: notifications. Expand only.
  `
  CREATE TABLE notification_settings (
    person_id TEXT PRIMARY KEY REFERENCES people(id),
    settings_json TEXT NOT NULL
  ) STRICT;
  ALTER TABLE devices ADD COLUMN push_json TEXT;
  ALTER TABLE asks ADD COLUMN last_notified_at INTEGER;
  `,
  // 8: accounts, as last seen from each provider's own tool. Expand only.
  `
  CREATE TABLE integrations (
    provider TEXT PRIMARY KEY,
    entity_json TEXT NOT NULL
  ) STRICT;
  `,
  // 9: agents' memory: personal notes, every version of them by hash, and which version each project's memory has.
  // Expand only.
  `
  CREATE TABLE note_texts (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL
  ) STRICT;
  CREATE TABLE personal_notes (
    file TEXT PRIMARY KEY,
    version_kind TEXT NOT NULL CHECK (version_kind IN ('live', 'deleted')),
    hash TEXT,
    history_json TEXT NOT NULL,
    written_by TEXT NOT NULL,
    written_at INTEGER NOT NULL,
    CHECK ((version_kind = 'live') = (hash IS NOT NULL))
  ) STRICT;
  CREATE TABLE personal_note_copies (
    project_key TEXT NOT NULL,
    file TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (project_key, file)
  ) STRICT;
  `,
  // 10: the person's other computers. Expand only.
  `
  CREATE TABLE peers (
    machine_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    public_key TEXT NOT NULL,
    trust TEXT NOT NULL CHECK (trust IN ('full', 'limited')),
    joined_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    hello_json TEXT
  ) STRICT;
  `,
  // 11: messages on their way to other machines, in order per machine. Expand only.
  `
  CREATE TABLE peer_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_machine_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'undeliverable')),
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    settled_at INTEGER,
    reason TEXT
  ) STRICT;
  CREATE INDEX peer_outbox_queue ON peer_outbox(peer_machine_id, state, seq);
  CREATE INDEX peer_outbox_message ON peer_outbox(message_id);
  `,
  // 12: the outbox carries group updates and posts too, in the same order per machine. A group update for a change of
  // members has no message. Rebuilt, as SQLite can't drop a NOT NULL; every column keeps its name and meaning.
  `
  CREATE TABLE peer_outbox_12 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_machine_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('/messages', '/group-updates', '/group-posts')),
    message_id TEXT,
    recipient TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'undeliverable')),
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    settled_at INTEGER,
    reason TEXT,
    CHECK ((route = '/group-updates') OR (message_id IS NOT NULL))
  ) STRICT;
  INSERT INTO peer_outbox_12 (seq, peer_machine_id, route, message_id, recipient, request_json, state, queued_at, attempts, next_attempt_at, settled_at, reason)
    SELECT seq, peer_machine_id, '/messages', message_id, recipient, request_json, state, queued_at, attempts, next_attempt_at, settled_at, reason FROM peer_outbox;
  DROP TABLE peer_outbox;
  ALTER TABLE peer_outbox_12 RENAME TO peer_outbox;
  CREATE INDEX peer_outbox_queue ON peer_outbox(peer_machine_id, state, seq);
  CREATE INDEX peer_outbox_message ON peer_outbox(message_id);
  `,
  // 13: moves between computers. Each agent's ownership epoch rises with each move; the computer it moves to remembers
  // each handoff it took, by its id, so a handoff sent again is answered as before and taken once.
  `
  ALTER TABLE agents ADD COLUMN ownership_epoch INTEGER NOT NULL DEFAULT 0;
  -- An agent that moved away no longer holds its name here.
  DROP INDEX agents_active_name;
  CREATE UNIQUE INDEX agents_active_name ON agents(name) WHERE state_name NOT IN ('archived', 'moved');
  CREATE TABLE moves_taken (
    move_id TEXT PRIMARY KEY,
    from_machine_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    taken_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 14: what an agent says to the person goes also to the person's other computers they talked to it from, through the
  // outbox. Rebuilt for the route's CHECK; every column keeps its name and meaning.
  `
  CREATE TABLE peer_outbox_14 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_machine_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('/messages', '/owner-messages', '/group-updates', '/group-posts')),
    message_id TEXT,
    recipient TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'undeliverable')),
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    settled_at INTEGER,
    reason TEXT,
    CHECK ((route = '/group-updates') OR (message_id IS NOT NULL))
  ) STRICT;
  INSERT INTO peer_outbox_14 SELECT * FROM peer_outbox;
  DROP TABLE peer_outbox;
  ALTER TABLE peer_outbox_14 RENAME TO peer_outbox;
  CREATE INDEX peer_outbox_queue ON peer_outbox(peer_machine_id, state, seq);
  CREATE INDEX peer_outbox_message ON peer_outbox(message_id);
  -- The person's other computers that show an agent's chat with the person: they sent the person's words to it, or
  -- started it.
  CREATE TABLE owner_chat_peers (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    peer_machine_id TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (agent_id, peer_machine_id)
  ) STRICT;
  `,
  // 15: asks of an agent go to the person's other computers they talk to it from, and a copy is kept there while open.
  // The outbox is rebuilt for the route's CHECK: a closed ask's update concerns no message. Every column keeps its name
  // and meaning.
  `
  CREATE TABLE peer_outbox_15 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_machine_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('/messages', '/owner-messages', '/owner-asks', '/group-updates', '/group-posts')),
    message_id TEXT,
    recipient TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted', 'undeliverable')),
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    settled_at INTEGER,
    reason TEXT,
    CHECK ((route IN ('/group-updates', '/owner-asks')) OR (message_id IS NOT NULL))
  ) STRICT;
  INSERT INTO peer_outbox_15 SELECT * FROM peer_outbox;
  DROP TABLE peer_outbox;
  ALTER TABLE peer_outbox_15 RENAME TO peer_outbox;
  CREATE INDEX peer_outbox_queue ON peer_outbox(peer_machine_id, state, seq);
  CREATE INDEX peer_outbox_message ON peer_outbox(message_id);
  -- Open asks of agents on peers, to the person here. Only open ones: a copy is removed when it closes.
  CREATE TABLE remote_asks (
    id TEXT PRIMARY KEY,
    peer_machine_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('waiting', 'blocked', 'urgent')),
    text TEXT NOT NULL,
    choices_json TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id)
  ) STRICT;
  CREATE INDEX remote_asks_agent ON remote_asks(peer_machine_id, agent_name);
  `,
  // 16: memory kept the same on fully trusted computers. For each peer and note, the version the two last agreed on, as
  // the base of the next three-way merge. Expand only.
  `
  CREATE TABLE personal_note_peer_bases (
    peer_machine_id TEXT NOT NULL,
    file TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (peer_machine_id, file)
  ) STRICT;
  CREATE TABLE project_note_peer_bases (
    peer_machine_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    file TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (peer_machine_id, project_key, file)
  ) STRICT;
  `,
  // 17: the turn whose long run was last reported to the agent's parent. Expand only.
  `
  ALTER TABLE agents ADD COLUMN long_turn_reported_turn_id TEXT;
  `,
  // 18: how far each agent's owed replies are settled. Expand only. Existing agents start settled, so an upgrade doesn't
  // remind them of old messages.
  `
  ALTER TABLE agents ADD COLUMN replies_settled_through_seq INTEGER NOT NULL DEFAULT 0;
  UPDATE agents SET replies_settled_through_seq = (SELECT coalesce(max(seq), 0) FROM messages);
  `,
  // 19: the agent's own git worktree, while it has one. Expand only.
  `
  ALTER TABLE agents ADD COLUMN worktree_json TEXT;
  `,
  // 20: each agent's prompt cache lifetime, and its prompt cache as last reported. Expand only.
  `
  ALTER TABLE agents ADD COLUMN prompt_cache_lifetime TEXT NOT NULL DEFAULT '5m';
  ALTER TABLE agents ADD COLUMN prompt_cache_json TEXT;
  `,
  // 21: each subscription's usage windows as last read, and what each turn on one cost and when, to split a window's usage
  // among agents. Turn costs older than any window are dropped. Expand only.
  `
  CREATE TABLE plan_readings (
    account TEXT PRIMARY KEY,
    reading_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE plan_turn_costs (
    agent_id TEXT NOT NULL,
    account TEXT NOT NULL,
    at INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  ) STRICT;
  CREATE INDEX plan_turn_costs_by_time ON plan_turn_costs (account, at);
  `,
  // 22: a delivery in a turn is handed to the runner or taken in. Contracts: older code can't read either state. A delivery
  // already in a turn was shown as delivered, so it stays that way.
  `
  UPDATE deliveries SET state_name = 'taken_in', state_json = json_set(state_json, '$.state', 'taken_in') WHERE state_name = 'in_turn';
  INSERT INTO meta (key, value) VALUES ('data_readable_by_schema_from', '22')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value;
  `,
  // 23: stalls in a row, so repeated ones reach the person. Expand only.
  `
  ALTER TABLE agents ADD COLUMN consecutive_stalls INTEGER NOT NULL DEFAULT 0;
  `,
  // 24: each window of a plan reading says when it was read, so the newest of each can be told apart across computers.
  // Contracts: older code would save readings whose windows don't say. A window saved before was read no later than its
  // reading.
  `
  UPDATE plan_readings SET reading_json = json_set(reading_json, '$.windows', (
    SELECT json_group_array(json(stamped)) FROM (
      SELECT json_set(window.value, '$.observedAt', json_extract(plan_readings.reading_json, '$.observedAt')) AS stamped
      FROM json_each(plan_readings.reading_json, '$.windows') AS window ORDER BY window.key
    )
  ));
  INSERT INTO meta (key, value) VALUES ('data_readable_by_schema_from', '24')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value;
  `,
  // 25: a copy of an ask from another computer carries its snooze as that computer last told it, when this computer last
  // pushed it, and the phones its own computer pushes, so this one reminds only its other phones. A copy made before was
  // pushed when it came; which phones its computer pushed wasn't kept. Expand only.
  `
  ALTER TABLE remote_asks ADD COLUMN snooze_json TEXT;
  ALTER TABLE remote_asks ADD COLUMN last_notified_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE remote_asks ADD COLUMN sender_push_token_hashes_json TEXT NOT NULL DEFAULT '[]';
  UPDATE remote_asks SET last_notified_at = asked_at;
  `,
  // 26: posts of groups whose home is another computer that this one has pushed its phones about, so an update the home
  // sends again after a lost answer doesn't push them again. Expand only.
  `
  CREATE TABLE group_posts_pushed (
    message_id TEXT PRIMARY KEY REFERENCES messages(id)
  ) STRICT;
  `,
  // 27: networks. The networks this server holds keys for (the keys themselves are in a file of their own), at most one
  // of them its home. Each peer gains the network it lives in
  // (null: none of this server's), whether it only visits this server's home network, whether it may still speak without
  // a network's signature (a full trust link from before networks, until it signs once), and its owner's name. A peer
  // known only from another server's address book has no public key yet: ''. An agent copied from a shared network
  // keeps where it came from, and whether it still waits to be started. A person arriving from another server in a shared
  // network is that server's owner, kept by its machine id: their name is a label, never who they are. A computer removed
  // from a network leaves its machine id behind, so another server's hello or its own introduction doesn't bring it back.
  // Expand only.
  `
  CREATE TABLE networks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('private', 'shared')),
    role TEXT NOT NULL CHECK (role IN ('home', 'extra')),
    added_at INTEGER NOT NULL,
    invite_hash TEXT,
    invite_expires_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX networks_one_home ON networks(role) WHERE role = 'home';
  ALTER TABLE peers ADD COLUMN network_id TEXT;
  ALTER TABLE peers ADD COLUMN visiting INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE peers ADD COLUMN unkeyed_allowed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE peers ADD COLUMN owner_name TEXT;
  UPDATE peers SET unkeyed_allowed = 1 WHERE trust = 'full';
  ALTER TABLE agents ADD COLUMN pulled_json TEXT;
  ALTER TABLE people ADD COLUMN origin_machine_id TEXT;
  CREATE UNIQUE INDEX people_origin_machine ON people(origin_machine_id) WHERE origin_machine_id IS NOT NULL;
  CREATE TABLE network_removed_peers (
    network_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    removed_at INTEGER NOT NULL,
    PRIMARY KEY (network_id, machine_id)
  ) STRICT;
  `,
]

export const SCHEMA_VERSION = migrations.length
