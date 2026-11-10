import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenedLinks, openedLinkAction } from './openedLinks.ts'

const PAIR = 'ouronext://pair?url=https%3A%2F%2Fmac.example&code=abc123'

test('a pair link pairs and switches with a server active, opens the Pair form without one; an invite fills its code', () => {
  assert.deepEqual(openedLinkAction(PAIR, true), { kind: 'pair_and_switch', url: 'https://mac.example', code: 'abc123' })
  assert.deepEqual(openedLinkAction(PAIR, false), { kind: 'open_pair_form', link: PAIR })
  assert.deepEqual(openedLinkAction('ouronext://invite?code=alpha7', true), { kind: 'fill_invite_code', code: 'alpha7' })
  assert.equal(openedLinkAction('https://example.com', false), null)
})

test('a link that arrives while startup reads the server list waits for it, then is handled once', () => {
  let hasActiveServer = false
  const actions: unknown[] = []
  const links = new OpenedLinks((link) => actions.push(openedLinkAction(link, hasActiveServer)))
  links.arrived(PAIR)
  assert.deepEqual(actions, [], 'not yet: a paired phone would look unpaired')
  hasActiveServer = true
  links.startupFinished()
  links.startupFinished()
  assert.deepEqual(actions, [{ kind: 'pair_and_switch', url: 'https://mac.example', code: 'abc123' }])
  links.arrived('ouronext://invite?code=x')
  assert.equal(actions.length, 2, 'after startup, at once')
})
