// The guardian reads server/release-manifest.json without running the release's code, so the manifest repeats what the
// migrations say. This keeps the two in step: a migration added without bumping the manifest fails here, not at deploy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { migrations, SCHEMA_VERSION } from './schema.ts'

const manifest = JSON.parse(readFileSync(new URL('../../release-manifest.json', import.meta.url), 'utf8')) as { schemaVersion: number; dataReadableBySchemaFrom: number }

/** The oldest code a migration leaves the data readable by: the last value a contracting migration wrote. */
function dataReadableBySchemaFrom(): number {
  // A step written as a function looks before it changes anything, and only expands.
  const contracting = migrations.filter((migration): migration is string => typeof migration === 'string' && migration.includes('data_readable_by_schema_from'))
  const written = contracting.map((migration) => /'data_readable_by_schema_from',\s*'(\d+)'/.exec(migration))
  assert.ok(written.every((match) => match !== null), "each contracting migration writes the key as ('data_readable_by_schema_from', 'n')")
  return written.length === 0 ? 1 : Number(written.at(-1)![1])
}

test('the release manifest names the schema the migrations reach, and the oldest code that can read their data', () => {
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION, 'server/release-manifest.json schemaVersion: set it to the number of migrations')
  assert.equal(manifest.dataReadableBySchemaFrom, dataReadableBySchemaFrom(), 'server/release-manifest.json dataReadableBySchemaFrom: set it to what the last contracting migration writes')
})
