import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileSpritesTools, shortToken } from './sprites-account.ts'
import type { SpritesTokenCheck } from './sprites-account.ts'

const GOOD = 'sprites-token-0123456789'

test('a Sprites token is kept only once the API accepts it, privately, and shown shortened', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sprites-')), 'secrets', 'sprites-token')
  let answer: SpritesTokenCheck = { kind: 'refused', why: 'the Sprites API rejected that token' }
  const tools = fileSpritesTools(path, async () => answer)
  assert.deepEqual(await tools.spritesStatus(), { status: 'not_connected' })
  assert.deepEqual(await tools.spritesSetToken('has spaces in it'), { accepted: false, why: "that doesn't look like a Sprites API token" })
  assert.deepEqual(await tools.spritesSetToken(GOOD), { accepted: false, why: 'the Sprites API rejected that token' })
  assert.equal(tools.spritesToken(), null)

  answer = { kind: 'accepted' }
  assert.deepEqual(await tools.spritesSetToken(`  ${GOOD}\n`), { accepted: true })
  assert.equal(readFileSync(path, 'utf8'), GOOD)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(tools.spritesToken(), GOOD)
  assert.deepEqual(await tools.spritesStatus(), { status: 'connected', token: 'sprite…6789', problem: null })

  answer = { kind: 'unreachable', why: "couldn't reach the Sprites API; try again" }
  assert.deepEqual(await tools.spritesStatus(), { status: 'connected', token: 'sprite…6789', problem: "couldn't reach the Sprites API; try again" })

  await tools.spritesDisconnect()
  assert.equal(tools.spritesToken(), null)
  assert.deepEqual(await tools.spritesStatus(), { status: 'not_connected' })
})

test('a short token shows nothing of itself', () => {
  assert.equal(shortToken('abcdefghijkl'), '…')
})
