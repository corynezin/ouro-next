// Publishing bases (J-34, publisher side): the publisher machine makes the version live on it the next base, with notes.
// What ships is cut from its source by distribution.json, scanned and checked; a withdrawn base is offered no more. A
// folder stands in for the hub it publishes to; takers read the same folder (m5-base-updates).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { folderBases } from '../server/src/adapters/base-source.ts'
import { GuardianRun } from './guardian-harness.ts'

const run = new GuardianRun()
const publishedDir = join(run.dir, 'published-bases')
const SERVER_NOTE = 'server/published-note.txt'

const RULE = {
  ships: ['server', 'packages', '.gitignore'],
  internal: ['docs'],
  dependencies: ['node_modules'],
  checks: ['test -f server/package.json', 'test -L node_modules'],
}

before(async () => {
  await run.createSource()
  writeFileSync(join(run.source, 'distribution.json'), JSON.stringify(RULE))
  writeFileSync(join(run.source, SERVER_NOTE), 'the first\n')
  await run.commitAll('what ships')
  const privateNames = join(run.dir, 'private-names')
  // Built, not written out, so this file holds no private name for a real publish to find.
  writeFileSync(privateNames, `${['zor', 'blax'].join('')}\n`)
  run.extraOurodEnv = { OURO_BASE_PUBLISH_DIR: publishedDir, OURO_PRIVATE_NAMES_FILE: privateNames }
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
})
after(() => run.cleanup())

async function cliRefusal(...args: string[]): Promise<string> {
  try {
    await run.cli(...args)
  } catch (error) {
    return (error as { stderr: string }).stderr
  }
  assert.fail(`ouro ${args.join(' ')} succeeded`)
}

async function deploy(): Promise<void> {
  const started = await run.control('POST', '/deploy', { reference: 'main', requestedBy: null }) as { id: string }
  const outcome = await run.deploymentOutcome(started.id)
  assert.equal(outcome.phase, 'live', `the deploy didn't go live: ${outcome.reason}`)
}

const fetched = async (n: number): Promise<string> => {
  const into = join(run.dir, `fetched-${n}`)
  mkdirSync(into)
  await folderBases(publishedDir).fetch(n, into)
  return into
}

test('the publisher publishes only its live version, cut down to what ships, and the same files again make no base', async () => {
  writeFileSync(join(run.source, SERVER_NOTE), 'not committed yet\n')
  assert.match(await cliRefusal('base', 'publish', 'half done'), /commit or discard the changes in .*: server\/published-note\.txt \(base_source_uncommitted\)/)
  await run.git('checkout', '-q', SERVER_NOTE)

  assert.equal(await run.cli('base', 'publish', 'the first base'), 'published base 1: the first base\n')
  const first = await fetched(1)
  assert.equal(readFileSync(join(first, SERVER_NOTE), 'utf8'), 'the first\n')
  assert.ok(existsSync(join(first, 'packages/contract/package.json')))
  assert.ok(!existsSync(join(first, 'distribution.json')), 'the rule doesn\'t ship itself')
  assert.ok(!existsSync(join(first, 'node_modules')), 'dependencies don\'t ship')
  assert.equal(await run.cli('base', 'publish', 'the first base, again'), 'base 1 already has these files: the first base\n')

  writeFileSync(join(run.source, SERVER_NOTE), 'the second\n')
  const committed = await run.commitAll('a better note')
  assert.match(await cliRefusal('base', 'publish', 'not live yet'), new RegExp(`${committed.slice(0, 8)} isn't the version live here .*deploy it first.*\\(base_not_live\\)`))
  assert.equal((await folderBases(publishedDir).latest())?.n, 1, 'nothing more is published')

  await deploy()
  assert.equal((await run.status()).activeCommit, committed)
  assert.equal(await run.cli('base', 'publish', 'a better note'), 'published base 2: a better note\n')
  assert.equal(readFileSync(join(await fetched(2), SERVER_NOTE), 'utf8'), 'the second\n')
})

test('a live version that names someone private isn\'t published', async () => {
  writeFileSync(join(run.source, SERVER_NOTE), `written by ${['Zor', 'blax'].join('')}\n`)
  await run.commitAll('a private name')
  await deploy()
  assert.match(await cliRefusal('base', 'publish', 'leaky'), /this would ship what must stay private:\nserver\/published-note\.txt:1: written by /)
  assert.equal((await folderBases(publishedDir).latest())?.n, 2)
})

test('a withdrawn base is offered no more, and withdrawing a base that isn\'t there is refused', async () => {
  assert.equal(await run.cli('base', 'withdraw', '2'), 'base 2 is withdrawn: it is offered no more\n')
  assert.equal(await run.cli('base', 'withdraw', '2'), 'base 2 is withdrawn: it is offered no more\n')
  assert.equal((await folderBases(publishedDir).latest())?.n, 1)
  assert.match(await cliRefusal('base', 'withdraw', '9'), /there is no base 9 \(not_found\)/)
  assert.match(await cliRefusal('base', 'withdraw', 'two'), /usage: ouro base/)
})
