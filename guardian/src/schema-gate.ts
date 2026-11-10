// Rollback restores code, not data, so each switch has to know that the code can run on the data. Read directly, because
// the question is about the database, whatever any release believes about it.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { ReleaseManifest } from './release-build.ts'

export interface DatabaseSchema {
  version: number
  /** The oldest code schema the data still works with. Written by the migration that contracts it. */
  readableBySchemaFrom: number
}

export function readDatabaseSchema(databasePath: string): DatabaseSchema | null {
  if (!existsSync(databasePath)) return null
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 0) return null
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'data_readable_by_schema_from'`).get() as { value: string } | undefined
    return { version, readableBySchemaFrom: row ? Number(row.value) : 1 }
  } finally {
    db.close()
  }
}

/** Null if this release may run on this data, otherwise why not. */
export function schemaRefusal(database: DatabaseSchema | null, release: ReleaseManifest): string | null {
  if (database === null) return null
  if (release.schemaVersion < database.readableBySchemaFrom) {
    return `the database needs code of schema ${database.readableBySchemaFrom} or newer, and this release is schema ${release.schemaVersion}`
  }
  return null
}
