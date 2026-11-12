import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ComputerEntity } from '@ouro/contract'
import { inviteTarget, mayLinkOutsideNetworks, serversToLink } from './serverLinks.ts'
import type { SavedServer } from './savedServers.ts'

const saved = (id: string, url: string): SavedServer => ({ id, label: id, url, deviceName: 'phone', deviceId: 'd', personName: null, hostedServerId: null })
const computer = (address: string | null): ComputerEntity => ({
  id: `c-${address}`, name: 'x', trust: 'full', status: 'online', lastSeenAt: 1, release: 'r', agentsRunning: 0, agentCount: 0, incompatibility: null, joinedAt: 1, address,
})

test('a join goes to the address and code the invite carries, not to words meant for people', () => {
  assert.deepEqual(inviteTarget({ code: 'c0de', expiresAt: 1, command: 'Run this: something else entirely', address: 'https://a.test' }), { address: 'https://a.test', code: 'c0de' })
})

test("an older server's invite is read from its command, and one with no address is refused", () => {
  assert.deepEqual(inviteTarget({ code: 'c0de', expiresAt: 1, command: 'ouro computers join https://a.test c0de' }), { address: 'https://a.test', code: 'c0de' })
  assert.equal(inviteTarget({ code: 'c0de', expiresAt: 1, command: 'ouro computers join' }), null)
})

test('a new server links with every other saved server it has no computer for, slashes aside', () => {
  const added = saved('new', 'https://new.test')
  const servers = [added, saved('a', 'https://a.test/'), saved('b', 'https://b.test')]
  assert.deepEqual(serversToLink(added, servers, [computer('https://a.test'), computer(null)]).map((server) => server.id), ['b'])
  assert.deepEqual(serversToLink(added, [added], []), [])
})

test('a made server links itself only while no saved server is in a network, and one that can\'t be read counts as in one', () => {
  const network = { id: 'n', name: 'home', kind: 'private' as const, role: 'home' as const, addedAt: 1 }
  assert.equal(mayLinkOutsideNetworks([], [[], []]), true)
  assert.equal(mayLinkOutsideNetworks([], []), true)
  assert.equal(mayLinkOutsideNetworks([network], [[]]), false, 'the new one is in a network')
  assert.equal(mayLinkOutsideNetworks([], [[], [network]]), false, 'another is')
  assert.equal(mayLinkOutsideNetworks([], [[], null]), false, 'an unreachable server might be: fails closed')
})
