import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ComputerEntity, HostedServer } from '@ouro/contract'
import { NETWORKS_COPY, parseInvite, networksSummary, checkingNote, createFailureText, hostedRows, inviteMessage, joinChoices, networkSections, newServerLabelOf, renamedLabel, serverRows, unpairedComputerRows } from './model.ts'

const server = (id: string, personName: string | null = null) => ({ id, label: `L${id}`, url: `https://${id}`, deviceName: 'mac', deviceId: 'd', personName, hostedServerId: null })

test('rows mark the active server, which cannot be removed from here', () => {
  const rows = serverRows([server('a', 'ada'), server('b')], 'a', { counts: new Map(), checking: false })
  assert.deepEqual(rows.map((r) => [r.id, r.isActive, r.canRemove, r.personText]), [['a', true, false, 'You: ada'], ['b', false, true, null]])
})

const computer = (id: string, name: string, address: string | null, partial: Partial<ComputerEntity> = {}): ComputerEntity => ({
  id, name, trust: 'full', status: 'online', lastSeenAt: 1, release: 'r1', agentsRunning: 1, agentCount: 2, incompatibility: null, joinedAt: 1, address, ...partial,
})

test('another saved server is linked when the open one has a computer at its address, and says how it is; else Not linked', () => {
  const computers = [computer('m-b', 'ec2', 'https://b/', { trust: 'limited' })]
  const rows = serverRows([server('a'), server('b'), server('c')], 'a', { counts: new Map(), checking: false }, computers)
  assert.equal(rows[0]!.link, null, 'the open server is not its own computer')
  assert.deepEqual(rows[1]!.link, { kind: 'linked', computerId: 'm-b', stateText: 'Online · 1 of 2 agents running', fullTrust: false, incompatibility: null })
  assert.deepEqual(rows[2]!.link, { kind: 'not_linked' })
})

test('computers the open server is linked to that this phone is not paired with are listed after the servers, by name', () => {
  const computers = [computer('m-z', 'zed', 'https://z'), computer('m-b', 'ec2', 'https://b'), computer('m-m', 'mac', null, { status: 'offline', agentCount: null })]
  assert.deepEqual(unpairedComputerRows(computers, [server('a'), server('b')]).map((row) => [row.name, row.stateText]), [['mac', 'Offline'], ['zed', 'Online · 1 of 2 agents running']])
})

test('a rename that is blank or unchanged does nothing', () => {
  assert.equal(renamedLabel('  ', 'Home'), null)
  assert.equal(renamedLabel(' Home ', 'Home'), null)
  assert.equal(renamedLabel(' Work ', 'Home'), 'Work')
})

test('other servers show their unread as a badge, a spinner while a check has nothing for them yet, and the total below', () => {
  const unread = { counts: new Map([['a', 9], ['b', 2], ['c', 0]]), checking: true }
  const rows = serverRows([server('a'), server('b'), server('c')], 'a', unread)
  assert.deepEqual(rows.map((r) => [r.id, r.unreadBadge, r.checking]), [['a', null, false], ['b', 2, false], ['c', null, true]])
  assert.equal(checkingNote(rows, true), 'Checking other servers (2 unread)…', "the open server's count is not in it")
  assert.equal(checkingNote(serverRows([server('b')], 'a', { counts: new Map(), checking: true }), true), 'Checking other servers…')
  assert.equal(checkingNote(rows, false), null)
})

const hosted = (id: string, status: HostedServer['status']): HostedServer => ({ id, label: `H${id}`, createdAt: 1, primary: false, status })

test("the account's servers not on this phone: by hosted id, or by address for one paired before ids were kept", () => {
  const saved = [{ ...server('a'), hostedServerId: 'h1' }, { ...server('b'), url: 'https://b.example/' }]
  const rows = hostedRows([
    hosted('h1', { state: 'ready', address: 'https://a', pairing: null }),
    hosted('h2', { state: 'ready', address: 'https://b.example', pairing: null }),
    hosted('h3', { state: 'ready', address: 'https://c', pairing: { code: 'x', expiresAt: 1 } }),
    hosted('h4', { state: 'failed', why: 'The disk is full.' }),
    hosted('h5', { state: 'failed', why: '' }),
    hosted('h6', { state: 'provisioning', step: 'install' }),
  ], saved)
  assert.deepEqual(rows.map((row) => [row.id, row.detail]), [
    ['h3', 'Ready — tap to connect'], ['h4', 'Error: The disk is full.'], ['h5', 'Error: unknown'], ['h6', 'Installing tools…'],
  ])
})

test('a new server needs a short, printable name', () => {
  assert.equal(newServerLabelOf('   '), null)
  assert.deepEqual(newServerLabelOf(' Work '), { label: 'Work' })
  assert.deepEqual(newServerLabelOf('x'.repeat(41)), { error: 'Name too long (max 40 characters).' })
  assert.deepEqual(newServerLabelOf('a\tb'), { error: 'Name contains invalid characters.' })
  assert.equal(createFailureText({ kind: 'refused', code: 'invalid_request', message: 'Give the server a name.', retryable: false }), 'Give the server a name.')
  assert.equal(createFailureText({ kind: 'invalid_answer', status: 500 }), 'Could not create the server.')
})

test('New server offers the open server\'s providers, ready ones to make and the rest to set up, then the hosted account', async () => {
  const { newServerChoices, integrationRouteOf } = await import('./model.ts')
  const providers = [
    { id: 'aws', name: 'AWS', available: true, detail: 'EC2 t3.medium in us-east-1', setup: 'aws' },
    { id: 'sprite', name: 'Sprite', available: false, detail: 'Connect Sprites first', setup: 'sprites' },
    { id: 'gcp', name: 'Google Cloud', available: false, detail: 'Connect it first', setup: 'gcp' },
  ]
  assert.deepEqual(newServerChoices(providers, true), [
    { kind: 'machine', provider: 'aws', title: 'AWS', detail: 'EC2 t3.medium in us-east-1' },
    { kind: 'set_up', provider: 'sprite', title: 'Set up Sprite…', detail: 'Connect Sprites first', route: 'Sprites' },
    { kind: 'set_up', provider: 'gcp', title: 'Set up Google Cloud…', detail: 'Connect it first', route: null },
    { kind: 'hosted', title: 'Ouro hosted' },
  ])
  assert.deepEqual(newServerChoices([], false), [])
  assert.equal(integrationRouteOf('aws'), 'AWS')
  assert.equal(integrationRouteOf(null), null)
})

test('machines being made show their provider and step; only settled ones can be removed; one paired elsewhere offers Destroy', async () => {
  const { machineRows } = await import('./model.ts')
  const providers = [{ id: 'aws', name: 'AWS', available: true, detail: '', setup: 'aws' }]
  const machine = (id: string, provider: string, status: HostedServer['status'], paired = false) => ({ id, label: `M${id}`, provider, createdAt: 1, status, paired })
  const rows = machineRows([
    machine('1', 'aws', { state: 'provisioning', step: 'install' }),
    machine('2', 'sprite', { state: 'failed', why: 'no room' }),
    machine('3', 'aws', { state: 'ready', address: 'https://c/', pairing: { code: 'x', expiresAt: 9 } }),
    machine('4', 'aws', { state: 'ready', address: 'https://d', pairing: null }),
    machine('5', 'aws', { state: 'ready', address: 'https://e', pairing: null }, true),
    machine('6', 'aws', { state: 'ready', address: 'https://c', pairing: null }, true),
  ], providers, [server('c')])
  assert.deepEqual(rows, [
    { kind: 'setting_up', id: '1', label: 'M1', detail: 'AWS · Installing tools…', canRemove: false },
    { kind: 'setting_up', id: '2', label: 'M2', detail: 'sprite · Error: no room', canRemove: true },
    { kind: 'setting_up', id: '4', label: 'M4', detail: 'AWS · Ready — tap to connect', canRemove: true },
    { kind: 'paired_elsewhere', id: '5', label: 'M5', detail: 'AWS · Paired with another phone' },
  ], 'a server saved here shows Destroy on its own row instead')
})

test("the New server hint is the open server's own word on how long it takes", async () => {
  const { NEW_SERVER_COPY } = await import('./model.ts')
  assert.equal(NEW_SERVER_COPY.hintFor('An EC2 t3.medium in us-east-1. Takes 10–15 minutes.'), 'An EC2 t3.medium in us-east-1. Takes 10–15 minutes. You can leave and come back.')
})

test('a saved server finds the ready machine made for it, by address, paired or not', async () => {
  const { machineOfServer } = await import('./model.ts')
  const machine = (id: string, status: HostedServer['status'], paired = false) => ({ id, label: `M${id}`, provider: 'aws', createdAt: 1, status, paired })
  const machines = [
    machine('1', { state: 'provisioning', step: 'install' }),
    machine('2', { state: 'ready', address: 'https://c/', pairing: null }),
    machine('3', { state: 'ready', address: 'https://e', pairing: null }, true),
  ]
  assert.equal(machineOfServer('https://c', machines)?.id, '2')
  assert.equal(machineOfServer('https://e/', machines)?.id, '3', 'one a phone has paired with, as Destroy needs')
  assert.equal(machineOfServer('https://d', machines), null)
})

test('a machine reads as a hosted server to the setup flow, and an unreachable server means try again', async () => {
  const { machineAsHosted } = await import('./model.ts')
  const status = { state: 'provisioning', step: 'create' } as const
  assert.deepEqual(machineAsHosted({ ok: true, value: { id: 'm', label: 'Work', provider: 'aws', createdAt: 5, status, paired: false } }),
    { ok: true, value: { id: 'm', label: 'Work', createdAt: 5, primary: false, status } })
  assert.equal((machineAsHosted({ ok: false, failure: { kind: 'machine_unreachable', status: 502 } }) as { failure: { kind: string } }).failure.kind, 'unreachable')
  assert.deepEqual(machineAsHosted({ ok: false, failure: { kind: 'refused', status: 404, error: { code: 'not_found', message: 'No such server.', retryable: false } } }),
    { ok: false, failure: { kind: 'refused', code: 'not_found', message: 'No such server.', retryable: false } })
  assert.deepEqual(machineAsHosted({ ok: false, failure: { kind: 'unauthenticated', status: 401 } }), { ok: false, failure: { kind: 'unauthenticated' } })
})

const network = (id: string, name: string, kind: 'private' | 'shared', role: 'home' | 'extra') => ({ id, name, kind, role, addedAt: 1 })

test('without networks the servers are one untitled list, as before', () => {
  const rows = serverRows([server('a'), server('b')], 'a', { counts: new Map(), checking: false })
  const sections = networkSections(rows, [], new Map())
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.title, null)
  assert.deepEqual(sections[0]!.rows.map((row) => row.id), ['a', 'b'])
})

test('servers are grouped by the network they live in, the open one in its home, the rest not in a network', () => {
  const networks = [network('p', 'private', 'private', 'home'), network('s', 'team', 'shared', 'extra')]
  const computers = [computer('m-b', 'b', 'https://b', { networkId: 'p' }), computer('m-c', 'c', 'https://c', { networkId: 's' }), computer('m-x', 'x', null, { networkId: 's' })]
  const saved = [server('a'), server('b'), server('c'), server('d')]
  const rows = serverRows(saved, 'a', { counts: new Map(), checking: false }, computers)
  const sections = networkSections(rows, unpairedComputerRows(computers, saved), new Map([['a', { networks, computers }]]))
  assert.deepEqual(sections.map((section) => [section.key, section.title, section.detail, section.rows.map((row) => row.id), section.unpaired.map((row) => row.name)]), [
    ['p', 'private', 'Private', ['a', 'b'], []],
    ['s', 'team', 'Shared · visiting', ['c'], ['x']],
    ['outside', 'Not in a network', null, ['d'], []],
  ])
})

test('every server is shown in the network it lives in, the same whichever is open, and none is listed where it only visits', () => {
  // r lives in private and visits team; s lives in team; m runs code from before networks, and r says it lives in private.
  const priv = network('p', 'private', 'private', 'home')
  const places = new Map([
    ['r', { networks: [priv, network('t', 'team', 'shared', 'extra')], computers: [computer('m-m', 'm', 'https://m', { networkId: 'p' }), computer('m-s', 's', 'https://s', { networkId: 't' })] }],
    ['s', { networks: [network('t', 'team', 'shared', 'home')], computers: [computer('m-r', 'r', 'https://r', { networkId: 't', visiting: true })] }],
    ['m', { networks: [], computers: [computer('m-r', 'r', 'https://r')] }],
  ])
  const saved = [server('r'), server('s'), server('m')]
  const grouped = (open: string) => {
    const computers = places.get(open)!.computers
    const rows = serverRows(saved, open, { counts: new Map(), checking: false }, computers)
    return networkSections(rows, unpairedComputerRows(computers, saved), places).map((section) => [section.title, section.rows.map((row) => row.id), section.network !== null])
  }
  assert.deepEqual(grouped('r'), [['private', ['r', 'm'], true], ['team', ['s'], true]])
  assert.deepEqual(grouped('s'), [['team', ['s'], true], ['private', ['r', 'm'], false]], 'only the open server\'s own networks offer Invite')
  assert.deepEqual(grouped('m'), [['private', ['r', 'm'], false], ['team', ['s'], false]])
})

test('a server joins a private network as its home; a shared one as a shared server, or holding its key while visiting', () => {
  const choices = joinChoices([network('p', 'private', 'private', 'home'), network('s', 'team', 'shared', 'extra')])
  assert.deepEqual(choices.map((choice) => [choice.networkId, choice.role]), [['p', 'home'], ['s', 'home'], ['s', 'extra']])
})

test('an invite carries the server and code, never the key', () => {
  const text = inviteMessage(network('s', 'team', 'shared', 'extra'), { address: 'http://100.64.0.1:7777', code: 'abc' })
  assert.match(text, /team/)
  assert.match(text, /http:\/\/100\.64\.0\.1:7777/)
  assert.match(text, /Code: abc/)
})

test('the top line says where the open server lives and what it visits; an empty network says how to add a server', () => {
  const networks = [network('p', 'private', 'private', 'home'), network('s', 'studio', 'shared', 'extra')]
  assert.equal(networksSummary(networks, 'work'), 'work lives in private and visits studio.')
  assert.equal(networksSummary([], 'work'), null)
  const rows = serverRows([server('a')], 'a', { counts: new Map(), checking: false })
  const sections = networkSections(rows, [], new Map([['a', { networks, computers: [] }]]))
  assert.equal(sections[0]!.emptyNote, 'No servers yet')
  assert.equal(sections[1]!.emptyNote, 'No servers yet')
})

test('an invite is read from the whole shared message, or from an address and a code', () => {
  const message = inviteMessage(network('s', 'team', 'shared', 'extra'), { address: 'https://a.example', code: 'c0de' })
  assert.deepEqual(parseInvite(message), { address: 'https://a.example', code: 'c0de' })
  assert.deepEqual(parseInvite('ouro networks join http://100.64.0.1:8080 abc'), { address: 'http://100.64.0.1:8080', code: 'abc' })
  assert.equal(parseInvite('hello'), null)
})

test('a new server can go into any network a saved server holds, private ones then shared, or one started and waiting; one already run may stay', async () => {
  const { newServerNetworkChoices } = await import('./model.ts')
  const places = new Map([
    ['r', { networks: [network('p', 'private', 'private', 'home'), network('t', 'team', 'shared', 'extra')], computers: [] }],
    ['s', { networks: [network('t', 'team', 'shared', 'home')], computers: [] }],
  ])
  assert.deepEqual(newServerNetworkChoices(places, 's', false, ['work', 'private']).map((choice) => [choice.group, choice.title, choice.plan]), [
    ['private', 'private', { kind: 'join', networkId: 'p', networkName: 'private', hostServerId: 'r' }],
    ['private', 'work', { kind: 'new_private', name: 'work' }],
    ['shared', 'team', { kind: 'join', networkId: 't', networkName: 'team', hostServerId: 's' }],
  ])
  const already = newServerNetworkChoices(places, 's', true)
  assert.deepEqual([already[0]!.key, already[0]!.group, already[0]!.plan], ['keep', 'keep', null])
})

test('a network is started where it can live: a private one on a server in none, else kept until a server is put in it', async () => {
  const { networkStartOf, networkNameOf, whereChoices } = await import('./model.ts')
  const priv = network('p', 'private', 'private', 'home')
  assert.deepEqual(networkStartOf('private', []), { kind: 'here', role: 'home' })
  assert.deepEqual(networkStartOf('private', [priv]), { kind: 'pending' })
  assert.deepEqual(networkStartOf('shared', [priv]), { kind: 'here', role: 'extra' })
  assert.deepEqual(networkStartOf('shared', []), { kind: 'here', role: 'home' })
  assert.equal(networkStartOf('shared', [network('t', 'team', 'shared', 'home')]).kind, 'refused')
  assert.deepEqual(networkNameOf(' work '), { name: 'work' })
  assert.equal(networkNameOf(''), null)
  assert.ok(networkNameOf('#!') && 'error' in networkNameOf('#!')!)
  assert.deepEqual(whereChoices([], false).map((choice) => choice.kind), ['existing'])
})

test('a private network started with no server yet is shown empty, saying it starts with the first server put in it', () => {
  const networks = [network('p', 'private', 'private', 'home')]
  const rows = serverRows([server('a')], 'a', { counts: new Map(), checking: false })
  const sections = networkSections(rows, [], new Map([['a', { networks, computers: [] }]]), ['work', 'private'])
  assert.deepEqual(sections.map((section) => [section.key, section.title, section.emptyNote]), [
    ['p', 'private', 'No servers yet'],
    ['pending:work', 'work', NETWORKS_COPY.pendingNote],
  ])
})

test('every network offers Invite through a saved server holding its key, the open one first', () => {
  const places = new Map([
    ['a', { networks: [network('p', 'private', 'private', 'home')], computers: [] }],
    ['w', { networks: [network('k', 'work', 'private', 'home')], computers: [] }],
  ])
  const rows = serverRows([server('a'), server('w')], 'a', { counts: new Map(), checking: false })
  assert.deepEqual(networkSections(rows, [], places).map((section) => [section.title, section.inviteVia?.serverId ?? null]), [['private', 'a'], ['work', 'w']])
})

test('a place a server can run that is not connected yet is listed by its name, with why it can not be picked', async () => {
  const { whereChoices } = await import('./model.ts')
  const choices = whereChoices([{ id: 'sprite', name: 'Sprite', available: false, detail: 'Connect Sprites in Integrations first.', setup: 'sprites' }], false)
  assert.deepEqual(choices.map((choice) => [choice.title, choice.kind, choice.detail]), [
    ['Sprite', 'set_up', 'Connect Sprites in Integrations first.'],
    ['A server I already run', 'existing', 'Pair it with the link it prints for ouro pair.'],
  ])
})

test("step 2's hint: the pairing link for a server already run, the provider's own words for one made there", async () => {
  const { detailsHintOf, EXISTING_SERVER, NEW_SERVER_COPY } = await import('./model.ts')
  assert.equal(detailsHintOf(EXISTING_SERVER, 'ignored'), NEW_SERVER_COPY.linkHint)
  assert.equal(detailsHintOf('hosted', 'Run by Ouro.'), NEW_SERVER_COPY.hint)
  assert.equal(detailsHintOf('aws', 'An EC2 t3.medium. Takes 10–15 minutes.'), 'An EC2 t3.medium. Takes 10–15 minutes. You can leave and come back.')
})
