import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import type { NotificationSettings } from '@ouro/contract'
import {
  awsStatusText, backupSection, BACKUP_WARNING, baseSection, changedNotificationSettings, integrationRows, leaveAction, notificationSettingsOf, notifyingModeOf, peopleRows,
  serverShortName, spritesStatusText, tailscaleStatusText, updateHomeIndex, updateHomeOptions,
} from './model.ts'
import type { NotificationChange } from './model.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'

test('Updates from lists each saved server and then None, and finds the home by id', () => {
  const server = (id: string, label: string): SavedServer => ({ id, label, url: `https://${id}.test`, deviceName: 'phone', deviceId: 'd', personName: null, hostedServerId: null })
  const options = updateHomeOptions([server('s1', 'Home'), server('s2', 'Work')])
  assert.deepEqual(options, [{ label: 'Home', serverId: 's1' }, { label: 'Work', serverId: 's2' }, { label: 'None', serverId: null }])
  assert.equal(updateHomeIndex(options, 's2'), 1)
  assert.equal(updateHomeIndex(options, null), 2)
  assert.equal(updateHomeIndex(updateHomeOptions([]), null), 0, 'with no servers, None is the only choice')
})

const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, mutedAgentIds: ['a1'], quietHours: { start: '23:00', end: '06:30', timeZone: 'Europe/London' } }
const change = (c: NotificationChange) => changedNotificationSettings(settings, c, 'America/New_York')

test('a notification change saves every other setting as it was', () => {
  assert.deepEqual(change({ kind: 'on', on: false, lastOnMode: 'needs_me' }), { ...settings, mode: 'nothing', quietHours: { start: '23:00', end: '06:30', timeZone: 'America/New_York' } })
  assert.equal(change({ kind: 'urgent_breaks_through', on: false }).urgentBreaksThrough, false)
  assert.deepEqual(change({ kind: 'on', on: false, lastOnMode: 'needs_me' }).mutedAgentIds, ['a1'], 'what Settings no longer offers is kept')
  assert.equal(changedNotificationSettings({ ...settings, quietHours: null }, { kind: 'on', on: false, lastOnMode: 'needs_me' }, 'UTC').quietHours, null)
})

test('turning notifications off and on again brings back the mode they had, every message included', () => {
  const everyMessage: NotificationSettings = { ...settings, mode: 'every_message' }
  const remembered = notifyingModeOf(everyMessage, 'needs_me')
  assert.equal(remembered, 'every_message', 'the mode in use is what is remembered as it turns off')
  const off = changedNotificationSettings(everyMessage, { kind: 'on', on: false, lastOnMode: remembered }, 'UTC')
  assert.equal(off.mode, 'nothing')
  assert.equal(notifyingModeOf(off, remembered), 'every_message', 'turning off again keeps what was remembered')
  assert.equal(changedNotificationSettings(off, { kind: 'on', on: true, lastOnMode: remembered }, 'UTC').mode, 'every_message')
  assert.equal(changedNotificationSettings(off, { kind: 'on', on: true, lastOnMode: 'needs_me' }, 'UTC').mode, 'needs_me')
  assert.equal(changedNotificationSettings({ ...settings, mode: 'needs_me' }, { kind: 'on', on: true, lastOnMode: 'every_message' }, 'UTC').mode, 'needs_me', 'on while on keeps the mode')
})

test('the command gets the settings without the entity id', () => {
  assert.deepEqual(notificationSettingsOf({ ...settings, id: 'p1' }), settings)
})

test('People lists the invited, oldest first, with their phones counted and the owner left out', () => {
  const person = (id: string, name: string, joinedAt: number, isOwner = false) => ({ id, name, address: `human@${name}`, isOwner, joinedAt })
  const device = (id: string, personId: string) => ({ id, name: 'phone', personId, pairedAt: 0, lastSeenAt: null })
  const rows = peopleRows(
    [person('p3', 'cat', 30), person('p1', 'owner', 10, true), person('p2', 'ann', 20)],
    [device('d1', 'p1'), device('d2', 'p2'), device('d3', 'p2')],
  )
  assert.deepEqual(rows.map((row) => [row.name, row.devicesText]), [['ann', '2 devices'], ['cat', '0 devices']])
  assert.equal(rows[0]!.removeTitle, 'Remove ann?')
  assert.equal(rows[0]!.removeMessage, "ann's 2 devices will stop connecting. Their chats stay.")
  assert.equal(peopleRows([person('p2', 'ann', 20)], [device('d2', 'p2')])[0]!.devicesText, '1 device')
})

test('the last button signs out with a hosted account, and removes this server without one', () => {
  const signedIn = leaveAction(true)
  assert.equal(signedIn.label, 'Sign out')
  assert.equal(signedIn.confirmTitle, 'Sign out of this phone?')
  assert.equal(signedIn.failedText, 'Could not sign out. Saved setup could not be updated.')
  const selfHosted = leaveAction(false)
  assert.equal(selfHosted.label, 'Unpair')
  assert.equal(selfHosted.confirmTitle, 'Remove this server?')
  assert.equal(selfHosted.confirmLabel, 'Remove')
})

/** A release with the given base and version (null: from before versions). */
const rel = (base: Parameters<typeof baseSection>[0]['base'], version: string | null = null) => ({ base, version })

test('with versions, the server shows its own and names the base it offers by version', () => {
  const offered = { n: 6, notes: 'Versions.', version: '0.6.0' }
  const idle = baseSection(rel({ kind: 'taker', integrated: 5, offered, update: { state: 'idle' } }, '0.5.0'), true)!
  assert.equal(idle.versionText, '0.5.0')
  assert.deepEqual(idle.take, { n: 6, label: 'Update to 0.6.0' })
  assert.equal(baseSection(rel({ kind: 'taker', integrated: 5, offered, update: { state: 'updating', n: 6 } }, '0.5.0'), true)!.updatingText, 'Updating to 0.6.0…')
  assert.match(baseSection(rel({ kind: 'taker', integrated: 5, offered, update: { state: 'failed', n: 6, why: 'x' } }), true)!.note!.text, /^Ouro 0\.6\.0 didn't go in/)
})

test('the Ouro section shows the merged base, the update under way, a conflict or failure, and offers a newer base to the owner', () => {
  assert.equal(baseSection(rel({ kind: 'not_taking' }), true), null, 'none on the publishing server')
  const offered = { n: 4, notes: 'Faster lists.' }
  const idle = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'idle' } }), true)!
  assert.equal(idle.versionText, 'Base 3')
  assert.equal(idle.footer, 'Faster lists.', 'release notes as the footer while newer')
  assert.deepEqual(idle.take, { n: 4, label: 'Update to base 4' })
  assert.equal(baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'idle' } }), false)!.take, null, 'only the owner takes one')

  const current = baseSection(rel({ kind: 'taker', integrated: 4, offered, update: { state: 'idle' } }), true)!
  assert.equal(current.footer, null, 'no footer once nothing newer is offered')
  assert.equal(current.take, null)

  const updating = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'updating', n: 4 } }), true)!
  assert.equal(updating.updatingText, 'Updating to base 4…')
  assert.equal(updating.take, null)

  const conflict = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts', 'b.ts'], resolver: 'base-4-2' } }), true)!
  assert.deepEqual(conflict.note, { text: 'Base 4 touches files you changed (a.ts, b.ts). An agent, base-4-2, is working it out; nothing has changed yet.', color: 'orange' }, 'the name the server gave it')
  assert.equal(conflict.take, null)
  assert.equal(conflict.conflict, null, 'an agent is on it already')
  const older = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts'] } }), true)!
  assert.deepEqual(older.note, { text: 'Base 4 touches files you changed (a.ts). An agent is working it out; nothing has changed yet.', color: 'orange' }, 'an older server handed it to an agent at once')
  assert.equal(older.conflict, null)

  const waiting = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts'], resolver: null } }), true)!
  assert.deepEqual(waiting.note, { text: 'Base 4 touches files you changed (a.ts). Nothing has changed yet. An agent can merge it, keeping what your changes were for.', color: 'orange' })
  assert.equal(waiting.conflict?.resolveLabel, 'Have an agent merge it')
  assert.equal(waiting.conflict?.dropLabel, 'Not now')
  assert.equal(waiting.conflict?.dropTitle, 'Skip base 4 for now?')
  assert.equal(waiting.conflict?.dropConfirmLabel, 'Skip')
  assert.equal(baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts'], resolver: null } }), false)!.conflict, null, 'only the owner chooses')

  const failed = baseSection(rel({ kind: 'taker', integrated: 3, offered, update: { state: 'failed', n: 4, why: 'the build broke' } }), true)!
  assert.deepEqual(failed.note, { text: "Base 4 didn't go in: the build broke. Nothing live changed unless it says so.", color: 'red' })
  assert.deepEqual(failed.take, { n: 4, label: 'Update to base 4' }, 'a failed base can be tried again')
})

test('the Backup section warns while changes on no base have no private copy, and starts the setup the viewer can', () => {
  const now = 1_000_000
  assert.equal(backupSection({ state: 'not_applicable' }, true, now), null)
  assert.equal(backupSection({ state: 'nothing_to_back_up' }, true, now), null)

  const noGithub = backupSection({ state: 'not_backed_up', github: 'not_connected' }, true, now)!
  assert.equal(noGithub.warning, BACKUP_WARNING)
  assert.deepEqual(noGithub.action, { kind: 'connect_github', label: 'Connect GitHub to back up' })
  assert.deepEqual(backupSection({ state: 'not_backed_up', github: 'connected' }, true, now)!.action, { kind: 'make_private_copy', label: 'Make a private copy' })
  assert.equal(backupSection({ state: 'not_backed_up', github: 'connected' }, false, now)!.action, null, 'only the owner makes it')
})

test('while the private copy is made the section says so and offers nothing to tap', () => {
  const making = backupSection({ state: 'making_private_copy' }, true, 0)!
  assert.equal(making.working, 'Making a private copy…')
  assert.equal(making.action, null)
  assert.equal(making.warning, null)
})

test('a private copy shows where it is, opening on GitHub, when it was last pushed, and a push waiting', () => {
  const now = 10 * 60_000
  const done = backupSection({ state: 'backed_up', repository: 'me/ouro-next-private', lastPushedAt: 5 * 60_000, behind: false, lastPushError: null }, true, now)!
  assert.deepEqual(done.copy, { headline: 'Backed up to me/ouro-next-private', url: 'https://github.com/me/ouro-next-private', lastPushedText: '5m ago', pendingText: null })
  assert.equal(done.warning, null)
  assert.equal(done.action, null)

  const pending = backupSection({ state: 'backed_up', repository: 'me/ouro-next-private', lastPushedAt: now, behind: true, lastPushError: null }, true, now)!
  assert.equal(pending.copy!.lastPushedText, 'just now')
  assert.equal(pending.copy!.pendingText, "Push pending: the live version isn't in the backup yet")

  assert.equal(backupSection({ state: 'backed_up', repository: 'me/x', lastPushedAt: null, behind: false, lastPushError: null }, true, now)!.copy!.lastPushedText, null)
  assert.equal(backupSection({ state: 'backed_up', repository: '/tmp/stand-in/x.git', lastPushedAt: null, behind: false, lastPushError: null }, true, now)!.copy!.url, null, 'a repository GitHub has no page for has no link')

  const failed = backupSection({ state: 'backed_up', repository: 'me/ouro-next-private', lastPushedAt: null, behind: true, lastPushError: 'GitHub didn\'t accept the push.' }, true, now)!
  assert.equal(failed.failure, 'GitHub didn\'t accept the push.')
  assert.equal(failed.copy!.pendingText, null, 'a failure is shown instead of a pending push')
  assert.equal(failed.action, null)
})

test('integrations read Connected or Not set up, whatever kind of not', () => {
  const rows = integrationRows({
    claude: { status: 'signed_in', account: { method: 'plan', email: null } } as never,
    chatgpt: { status: 'not_installed' },
    openrouter: { status: 'not_configured' },
    github: { status: 'connected', user: 'octocat', scopes: [] },
  })
  assert.deepEqual(rows.map((row) => row.status), ['Connected', 'Not set up', 'Not set up', 'Connected'])
  assert.equal(integrationRows({ claude: null, chatgpt: { status: 'signed_out' }, openrouter: null, github: null })[1]!.status, 'Not set up')
  assert.ok(integrationRows({ claude: null, chatgpt: null, openrouter: null, github: null }).every((row) => row.status === 'Checking…'))
})

test('a server goes by its label on this phone, else its machine name', () => {
  const saved = [{ id: 's1', label: 'Home', url: 'https://a.test', deviceName: 'phone', deviceId: 'd', personName: null, hostedServerId: null }]
  assert.equal(serverShortName(saved, 's1', 'ip-10-0-0-1'), 'Home')
  assert.equal(serverShortName(saved, 's2', 'ip-10-0-0-1'), 'ip-10-0-0-1')
  assert.equal(serverShortName([], 's2', null), 'This server')
})

test('AWS reads like the others, and shows nothing when its route failed', () => {
  const connected = { status: 'connected', accessKeyId: 'AKIA…MPLE', region: null, accountId: null, arn: null, problem: null } as const
  assert.equal(awsStatusText({ kind: 'loaded', value: connected }), 'Connected')
  assert.equal(awsStatusText({ kind: 'loaded', value: { status: 'not_connected' } }), 'Not set up')
  assert.equal(awsStatusText({ kind: 'checking' }), 'Checking…')
  assert.equal(awsStatusText({ kind: 'failed' }), null)
})

test('Sprites has its own words, not AWS\'s, and says when the token stopped working', () => {
  assert.equal(spritesStatusText({ kind: 'loaded', value: { status: 'connected', token: 'abc…xyz', problem: null } }), 'Connected')
  assert.equal(spritesStatusText({ kind: 'loaded', value: { status: 'connected', token: 'abc…xyz', problem: 'refused' } }), 'Not working')
  assert.equal(spritesStatusText({ kind: 'loaded', value: { status: 'not_connected' } }), 'Not set up')
  assert.equal(spritesStatusText({ kind: 'checking' }), 'Checking…')
  assert.equal(spritesStatusText({ kind: 'failed' }), null)
})

test('Tailscale reads Connected or Not set up, or what it is doing', () => {
  assert.equal(tailscaleStatusText({ kind: 'loaded', value: { state: 'connected', ip: '100.1.2.3' } }), 'Connected')
  assert.equal(tailscaleStatusText({ kind: 'loaded', value: { state: 'not_connected' } }), 'Not set up')
  assert.equal(tailscaleStatusText({ kind: 'loaded', value: { state: 'logging_in', loginUrl: 'https://x' } }), 'Waiting for approval')
  assert.equal(tailscaleStatusText({ kind: 'checking' }), 'Checking…')
  assert.equal(tailscaleStatusText({ kind: 'failed' }), null)
})
