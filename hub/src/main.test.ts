// The hub's command line as its operator uses it: making invites, letting an account publish, and refusing to start
// with a configuration it can't honour.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HubStore } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-main-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const main = join(import.meta.dirname, 'main.ts')

let configs = 0
function configFile(provisioner: object): { path: string; hubDir: string } {
  const hubDir = join(dir, `hub-${++configs}`)
  const path = join(dir, `config-${configs}.json`)
  writeFileSync(path, JSON.stringify({ dir: hubDir, port: 0, distribution: { source: join(dir, 'no-source') }, provisioner }))
  return { path, hubDir }
}

const LOCAL = { kind: 'local', computersDir: join(dir, 'computers') }

function hub(args: string[], env: Record<string, string> = {}) {
  const environment: Record<string, string | undefined> = { ...process.env, ...env }
  if (!('SPRITES_TOKEN' in env)) delete environment.SPRITES_TOKEN
  const result = spawnSync(process.execPath, ['--no-warnings', main, ...args], { env: environment, encoding: 'utf8', timeout: 20_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('grant-publishing lets an existing account publish, refuses an unknown one, and needs its arguments', () => {
  const { path, hubDir } = configFile(LOCAL)
  const invited = hub(['invite', path])
  assert.equal(invited.status, 0)
  const code = invited.stdout.trim()
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  const store = new HubStore(join(hubDir, 'hub.db'))
  try {
    const signedUp = store.signUp(code, { id: 'acct-1', name: 'Ada', createdAt: 1 }, 'token-hash', { id: 'srv-1', accountId: 'acct-1', label: "Ada's computer", primary: true, createdAt: 1, distributionCommit: 'c0ffee' }, null)
    assert.equal(signedUp, 'opened')
    assert.equal(store.isPublisher('acct-1'), false)

    assert.equal(hub(['grant-publishing', path, 'acct-1']).status, 0)
    assert.equal(store.isPublisher('acct-1'), true)
    assert.equal(hub(['grant-publishing', path, 'acct-1']).status, 0, 'granting again changes nothing')

    const unknown = hub(['grant-publishing', path, 'acct-nobody'])
    assert.equal(unknown.status, 1)
    assert.equal(unknown.stderr, 'no account acct-nobody\n')
    assert.equal(store.isPublisher('acct-nobody'), false)
  } finally {
    store.close()
  }
  const missing = hub(['grant-publishing', path])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /^usage: /)
})

test('the hub refuses to start with a configuration it cannot honour, and says why', () => {
  const refusals: [object, Record<string, string>, RegExp][] = [
    [{ kind: 'sprites', maxSprites: 3 }, { SPRITES_TOKEN: 't' }, /the sprites provisioner needs namePrefix/],
    [{ kind: 'sprites', namePrefix: 'Ouro_', maxSprites: 3 }, { SPRITES_TOKEN: 't' }, /the Sprite name prefix "Ouro_" must be lowercase words joined and ended by hyphens/],
    [{ kind: 'sprites', namePrefix: 'ouro-next-h-' }, { SPRITES_TOKEN: 't' }, /the sprites provisioner needs maxSprites/],
    [{ kind: 'sprites', namePrefix: 'ouro-next-h-', maxSprites: 0 }, { SPRITES_TOKEN: 't' }, /maxSprites must be a whole number of at least 1, not 0/],
    [{ kind: 'sprites', namePrefix: 'ouro-next-h-', maxSprites: 3 }, {}, /the sprites provisioner needs the Sprites API token in SPRITES_TOKEN/],
    [{ kind: 'local' }, {}, /the local provisioner needs computersDir/],
    [{ kind: 'ec2' }, {}, /no provisioner of kind ec2/],
  ]
  for (const [provisioner, env, why] of refusals) {
    const started = hub(['serve', configFile(provisioner).path], env)
    assert.notEqual(started.status, 0, JSON.stringify(provisioner))
    assert.match(started.stderr, why)
    assert.doesNotMatch(started.stdout, /"listening"/, 'it never listened')
  }
})
