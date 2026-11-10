// The hub's records: invites, accounts and their servers, and the bases published. One process writes them; operator commands open the same file.
// Invite codes and account tokens are kept only as hashes.
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ProvisioningStep } from '@ouro/contract'
import type { HostedServer, HubBase } from '@ouro/contract'

const FIRST_STEP: ProvisioningStep = 'create'

export const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex')

export interface Account {
  id: string
  name: string
  createdAt: number
}

/** A ready server's current code, and whether a phone has paired with it since (then no code is handed out again). */
export interface PairingRecord {
  code: string
  expiresAt: number
}

export type ServerProgress =
  | { state: 'provisioning'; step: ProvisioningStep }
  | { state: 'ready'; address: string; pairing: PairingRecord | null; phonePaired: boolean }
  | { state: 'failed'; why: string }

export interface ServerRecord {
  id: string
  accountId: string
  label: string
  primary: boolean
  createdAt: number
  /** The commit of Ouro this server is made from, fixed when it was asked for, so a resumed step installs the same. */
  distributionCommit: string
  progress: ServerProgress
}

export interface NewServer {
  id: string
  accountId: string
  label: string
  primary: boolean
  createdAt: number
  distributionCommit: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL,
  is_primary INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  distribution_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed')),
  step TEXT CHECK ((state = 'provisioning') = (step IS NOT NULL)),
  address TEXT CHECK ((state = 'ready') = (address IS NOT NULL)),
  why TEXT CHECK ((state = 'failed') = (why IS NOT NULL)),
  pairing_code TEXT,
  pairing_expires_at INTEGER CHECK ((pairing_code IS NULL) = (pairing_expires_at IS NULL)),
  phone_paired INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS servers_by_account ON servers(account_id, created_at);
CREATE TABLE IF NOT EXISTS publishers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  granted_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bases (
  n INTEGER PRIMARY KEY CHECK (n >= 1),
  notes TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES accounts(id),
  published_at INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;
`

interface BaseRow {
  n: number
  notes: string
  tree_hash: string
}

const baseOf = (row: BaseRow): HubBase => ({ n: row.n, notes: row.notes, treeHash: row.tree_hash })

interface ServerRow {
  id: string
  account_id: string
  label: string
  is_primary: number
  created_at: number
  distribution_commit: string
  state: string
  step: string | null
  address: string | null
  why: string | null
  pairing_code: string | null
  pairing_expires_at: number | null
  phone_paired: number
}

function progressOf(row: ServerRow): ServerProgress {
  switch (row.state) {
    case 'provisioning':
      return { state: 'provisioning', step: ProvisioningStep.parse(row.step) }
    case 'ready': {
      const pairing = row.pairing_code !== null && row.pairing_expires_at !== null ? { code: row.pairing_code, expiresAt: row.pairing_expires_at } : null
      return { state: 'ready', address: row.address!, pairing, phonePaired: row.phone_paired === 1 }
    }
    case 'failed':
      return { state: 'failed', why: row.why! }
    default:
      throw new Error(`server ${row.id} has an unknown state ${row.state}`)
  }
}

function serverOf(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    primary: row.is_primary === 1,
    createdAt: row.created_at,
    distributionCommit: row.distribution_commit,
    progress: progressOf(row),
  }
}

/** What the app is shown of a server: never the pairing of one a phone has paired with, nor an expired one. */
export function hostedServerOf(server: ServerRecord, now: number): HostedServer {
  const { progress } = server
  const status: HostedServer['status'] = progress.state === 'ready'
    ? { state: 'ready', address: progress.address, pairing: !progress.phonePaired && progress.pairing !== null && progress.pairing.expiresAt > now ? progress.pairing : null }
    : progress
  return { id: server.id, label: server.label, createdAt: server.createdAt, primary: server.primary, status }
}

export type SignUpOutcome = 'opened' | 'invite_invalid' | 'hub_full'

export class HubStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addInvite(code: string, now: number): void {
    this.db.prepare('INSERT INTO invites (code_hash, created_at) VALUES (?, ?)').run(hashOf(code), now)
  }

  /**
   * Uses the invite and opens the account with its primary server, all or nothing: not if the invite doesn't exist or was
   * used already, nor if the hub has `serverLimit` servers already, which leaves the invite unused.
   */
  signUp(invite: string, account: Account, tokenHash: string, primary: NewServer, serverLimit: number | null): SignUpOutcome {
    return this.transaction(() => {
      const open = this.db.prepare('SELECT 1 FROM invites WHERE code_hash = ? AND used_by IS NULL').get(hashOf(invite))
      if (!open) return 'invite_invalid'
      if (this.atLimit(serverLimit)) return 'hub_full'
      this.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(account.id, account.createdAt, hashOf(invite))
      this.db.prepare('INSERT INTO accounts (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(account.id, account.name, tokenHash, account.createdAt)
      this.insertServer(primary)
      return 'opened'
    })
  }

  accountByTokenHash(tokenHash: string): Account | null {
    const row = this.db.prepare('SELECT id, name, created_at FROM accounts WHERE token_hash = ?').get(tokenHash) as { id: string; name: string; created_at: number } | undefined
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null
  }

  /** False, adding nothing, if the hub has `serverLimit` servers already. */
  addServer(server: NewServer, serverLimit: number | null): boolean {
    return this.transaction(() => {
      if (this.atLimit(serverLimit)) return false
      this.insertServer(server)
      return true
    })
  }

  /** Every server counts, failed ones too: a failed server may still hold its machine. */
  private atLimit(serverLimit: number | null): boolean {
    if (serverLimit === null) return false
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM servers').get() as { count: number }
    return count >= serverLimit
  }

  private insertServer(server: NewServer): void {
    this.db.prepare(`INSERT INTO servers (id, account_id, label, is_primary, created_at, distribution_commit, state, step)
      VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?)`).run(server.id, server.accountId, server.label, server.primary ? 1 : 0, server.createdAt, server.distributionCommit, FIRST_STEP)
  }

  /** Removes the record, so it no longer counts against the hub's limit; false if there was none. */
  deleteServer(id: string): boolean {
    return this.db.prepare('DELETE FROM servers WHERE id = ?').run(id).changes > 0
  }

  server(id: string): ServerRecord | null {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined
    return row ? serverOf(row) : null
  }

  /** The account's servers, its primary first, then oldest first. */
  serversOf(accountId: string): ServerRecord[] {
    const rows = this.db.prepare('SELECT * FROM servers WHERE account_id = ? ORDER BY is_primary DESC, created_at, id').all(accountId) as unknown as ServerRow[]
    return rows.map(serverOf)
  }

  serversProvisioning(): ServerRecord[] {
    const rows = this.db.prepare("SELECT * FROM servers WHERE state = 'provisioning' ORDER BY created_at, id").all() as unknown as ServerRow[]
    return rows.map(serverOf)
  }

  /** Only from the step it is at, so a step finishing twice can't skip one. */
  advance(id: string, from: ProvisioningStep, to: ProvisioningStep): void {
    this.db.prepare("UPDATE servers SET step = ? WHERE id = ? AND state = 'provisioning' AND step = ?").run(to, id, from)
  }

  markReady(id: string, address: string, pairing: PairingRecord): void {
    this.db.prepare(`UPDATE servers SET state = 'ready', step = NULL, address = ?, pairing_code = ?, pairing_expires_at = ?
      WHERE id = ? AND state = 'provisioning'`).run(address, pairing.code, pairing.expiresAt, id)
  }

  markFailed(id: string, why: string): void {
    this.db.prepare("UPDATE servers SET state = 'failed', step = NULL, why = ? WHERE id = ? AND state = 'provisioning'").run(why, id)
  }

  replacePairing(id: string, pairing: PairingRecord): void {
    this.db.prepare("UPDATE servers SET pairing_code = ?, pairing_expires_at = ? WHERE id = ? AND state = 'ready'").run(pairing.code, pairing.expiresAt, id)
  }

  /** A phone paired: its code is forgotten, and none is made again. */
  markPhonePaired(id: string): void {
    this.db.prepare("UPDATE servers SET phone_paired = 1, pairing_code = NULL, pairing_expires_at = NULL WHERE id = ? AND state = 'ready'").run(id)
  }

  /** False if there is no such account. */
  grantPublishing(accountId: string, now: number): boolean {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) return false
    this.db.prepare('INSERT OR IGNORE INTO publishers (account_id, granted_at) VALUES (?, ?)').run(accountId, now)
    return true
  }

  isPublisher(accountId: string): boolean {
    return this.db.prepare('SELECT 1 FROM publishers WHERE account_id = ?').get(accountId) !== undefined
  }

  base(n: number): HubBase | null {
    const row = this.db.prepare('SELECT n, notes, tree_hash FROM bases WHERE n = ?').get(n) as BaseRow | undefined
    return row ? baseOf(row) : null
  }

  /** The newest base not withdrawn: the one offered. */
  latestOfferedBase(): HubBase | null {
    const row = this.db.prepare('SELECT n, notes, tree_hash FROM bases WHERE withdrawn_at IS NULL ORDER BY n DESC LIMIT 1').get() as BaseRow | undefined
    return row ? baseOf(row) : null
  }

  /** One past the highest base ever published, withdrawn or not: a number is never used twice. */
  nextBaseNumber(): number {
    const row = this.db.prepare('SELECT MAX(n) AS highest FROM bases').get() as { highest: number | null }
    return (row.highest ?? 0) + 1
  }

  addBase(base: HubBase, publishedBy: string, now: number): void {
    this.db.prepare('INSERT INTO bases (n, notes, tree_hash, published_by, published_at) VALUES (?, ?, ?, ?, ?)').run(base.n, base.notes, base.treeHash, publishedBy, now)
  }

  /** Withdrawn once: withdrawing again keeps the first time. */
  withdrawBase(n: number, now: number): void {
    this.db.prepare('UPDATE bases SET withdrawn_at = ? WHERE n = ? AND withdrawn_at IS NULL').run(now, n)
  }
}
