import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import type { NotificationSettings } from '@ouro/contract'
import {
  backupSection, BACKUP_WARNING, baseSection, BASE_FOOTER, binaryVersionText, changedNotificationSettings, channelText, connectedText, faceIdNote, foldKey, foldOptions, leaveAction, notificationSettingsOf, peopleRows, unpairFooter, NOTIFY_MODE_OPTIONS, QUIET_HOURS_TIMES, updateHomeIndex, updateHomeOptions,
} from './model.ts'
import type { NotificationChange } from './model.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'

test('fold choices say what Default means on this server', () => {
  assert.equal(foldOptions(30)[0]!.label, 'Default (30 min)')
  assert.equal(foldOptions(null)[0]!.label, 'Default (off)')
  assert.equal(foldOptions(undefined)[0]!.label, 'Default')
  assert.deepEqual(foldOptions(30).map((o) => o.label).slice(1), ['Off', 'After 15 min', 'After 30 min', 'After 1 h', 'After 2 h', 'After 4 h', 'After 8 h'])
})

test('each fold has one key, and the key finds its option back', () => {
  for (const option of foldOptions(30)) assert.equal(foldKey(option.fold), option.key)
})

test('Face ID turned on without hardware says why', () => {
  assert.equal(faceIdNote({ kind: 'unavailable' }), 'Face ID is not set up on this phone.')
  assert.equal(faceIdNote({ kind: 'refused' }), null)
})

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
  assert.deepEqual(change({ kind: 'mode', mode: 'needs_me' }), { ...settings, mode: 'needs_me', quietHours: { start: '23:00', end: '06:30', timeZone: 'America/New_York' } })
  assert.equal(change({ kind: 'urgent_breaks_through', on: false }).urgentBreaksThrough, false)
  assert.deepEqual(NOTIFY_MODE_OPTIONS.map((o) => o.label), ['What needs me', 'Every message', 'Nothing'])
})

test('one banner per burst is 60 seconds or off', () => {
  assert.equal(change({ kind: 'one_banner_per_burst', on: false }).burstSeconds, 0)
  assert.equal(changedNotificationSettings({ ...settings, burstSeconds: 0 }, { kind: 'one_banner_per_burst', on: true }, 'UTC').burstSeconds, 60)
})

test('muting adds an agent once, and unmuting removes it', () => {
  assert.deepEqual(change({ kind: 'agent_muted', agentId: 'a2', muted: true }).mutedAgentIds, ['a1', 'a2'])
  assert.deepEqual(change({ kind: 'agent_muted', agentId: 'a1', muted: true }).mutedAgentIds, ['a1'])
  assert.deepEqual(change({ kind: 'agent_muted', agentId: 'a1', muted: false }).mutedAgentIds, [])
})

test('quiet hours start at 22:00 to 07:00 in the phone’s zone, keep their times when edited, and turn off', () => {
  const none = { ...settings, quietHours: null }
  assert.deepEqual(changedNotificationSettings(none, { kind: 'quiet_hours', on: true }, 'Asia/Tokyo').quietHours, { start: '22:00', end: '07:00', timeZone: 'Asia/Tokyo' })
  assert.deepEqual(change({ kind: 'quiet_hours_start', at: '21:30' }).quietHours, { start: '21:30', end: '06:30', timeZone: 'America/New_York' })
  assert.equal(change({ kind: 'quiet_hours', on: false }).quietHours, null)
  assert.equal(changedNotificationSettings(none, { kind: 'quiet_hours_end', at: '08:00' }, 'UTC').quietHours, null)
  assert.equal(QUIET_HOURS_TIMES.length, 48)
  assert.deepEqual([QUIET_HOURS_TIMES[0], QUIET_HOURS_TIMES[15], QUIET_HOURS_TIMES[47]], ['00:00', '07:30', '23:30'])
})

test('the command gets the settings without the entity id', () => {
  assert.deepEqual(notificationSettingsOf({ ...settings, id: 'p1' }), settings)
})

test('Settings names the server software, the binary version and the update channel', () => {
  assert.equal(connectedText({ id: 'r42', base: { kind: 'not_taking' } }), 'Connected: ouro r42, API v2')
  assert.equal(binaryVersionText('1.4.0', '57'), '1.4.0 (57)')
  assert.equal(binaryVersionText('1.4.0', null), '1.4.0')
  assert.equal(binaryVersionText(null, '57'), null)
  assert.equal(channelText(null), 'production')
  assert.equal(channelText(''), 'production')
  assert.equal(channelText('preview'), 'preview')
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

test('the Unpair footer names this phone in the command that revokes its token on the computer', () => {
  assert.equal(unpairFooter('Alex’s iPhone'), 'On the computer, `ouro devices revoke Alex’s iPhone` also revokes the token.')
  assert.equal(unpairFooter(undefined), 'On the computer, `ouro devices revoke <device>` also revokes the token.')
})

test('the Ouro section shows the merged base, the update under way, a conflict or failure, and offers a newer base to the owner', () => {
  assert.equal(baseSection({ kind: 'not_taking' }, true), null, 'none on the publishing server')
  const offered = { n: 4, notes: 'Faster lists.' }
  const idle = baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'idle' } }, true)!
  assert.equal(idle.versionText, 'Base 3')
  assert.equal(idle.footer, 'Faster lists.', 'release notes as the footer while newer')
  assert.deepEqual(idle.take, { n: 4, label: 'Update to base 4' })
  assert.equal(baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'idle' } }, false)!.take, null, 'only the owner takes one')

  const current = baseSection({ kind: 'taker', integrated: 4, offered, update: { state: 'idle' } }, true)!
  assert.equal(current.footer, BASE_FOOTER)
  assert.equal(current.take, null)

  const updating = baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'updating', n: 4 } }, true)!
  assert.equal(updating.updatingText, 'Updating to base 4…')
  assert.equal(updating.take, null)

  const conflict = baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts', 'b.ts'], resolver: 'base-4-2' } }, true)!
  assert.deepEqual(conflict.note, { text: 'Base 4 touches files you changed (a.ts, b.ts). An agent, base-4-2, is working it out; nothing has changed yet.', color: 'orange' }, 'the name the server gave it')
  const unresolved = baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'conflict', n: 4, files: ['a.ts'], resolver: null } }, true)!
  assert.deepEqual(unresolved.note, { text: 'Base 4 touches files you changed (a.ts). No agent could start to work it out, so you were sent what to do; nothing has changed yet.', color: 'orange' })
  assert.equal(conflict.take, null)

  const failed = baseSection({ kind: 'taker', integrated: 3, offered, update: { state: 'failed', n: 4, why: 'the build broke' } }, true)!
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
