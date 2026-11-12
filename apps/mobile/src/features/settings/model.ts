// Settings as data. Pure: Screen.tsx only draws this.
import { ago } from '../../design/format.ts'
import { ServerIdentity } from '@ouro/contract'
import type { DeviceEntity, NotificationSettings, NotificationSettingsEntity, PersonEntity, ServerEntity } from '@ouro/contract'
import type { IdleFold } from '../../core/accounts/preferences.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'

const FOLD_MINUTES = [15, 30, 60, 120, 240, 480] as const

export interface FoldOption { key: string; label: string; fold: IdleFold }

/** The picker's choices. `serverDefaultMinutes` is what "Default" means on this server: null is off, undefined unknown. */
export function foldOptions(serverDefaultMinutes: number | null | undefined): FoldOption[] {
  const defaultLabel = serverDefaultMinutes === undefined ? 'Default' : serverDefaultMinutes === null ? 'Default (off)' : `Default (${serverDefaultMinutes} min)`
  return [
    { key: 'default', label: defaultLabel, fold: { kind: 'server_default' } },
    { key: 'never', label: 'Off', fold: { kind: 'never' } },
    ...FOLD_MINUTES.map((minutes): FoldOption => ({
      key: String(minutes), label: minutes < 60 ? `After ${minutes} min` : `After ${minutes / 60} h`, fold: { kind: 'after_minutes', minutes },
    })),
  ]
}

export function foldKey(fold: IdleFold) {
  switch (fold.kind) {
    case 'server_default': return 'default'
    case 'never': return 'never'
    case 'after_minutes': return String(fold.minutes)
  }
}

/** The choices offered; a value set elsewhere (by `ouro`, say) is shown as one more. */
const AUTO_ARCHIVE_HOURS = [1, 6, 24, 72, 168] as const

export interface AutoArchiveOption { key: string; label: string; afterHours: number | null }

const hoursLabel = (hours: number) => {
  if (hours % 168 === 0) return hours === 168 ? 'After 1 week' : `After ${hours / 168} weeks`
  if (hours % 24 === 0) return hours === 24 ? 'After 1 day' : `After ${hours / 24} days`
  return hours === 1 ? 'After 1 hour' : `After ${hours} hours`
}

export const autoArchiveKey = (afterHours: number | null) => (afterHours === null ? 'off' : String(afterHours))

export function autoArchiveOptions(current: number | null): AutoArchiveOption[] {
  const hours: number[] = [...AUTO_ARCHIVE_HOURS]
  if (current !== null && !hours.includes(current)) hours.push(current)
  return [
    { key: 'off', label: 'Off', afterHours: null },
    ...hours.sort((a, b) => a - b).map((afterHours) => ({ key: autoArchiveKey(afterHours), label: hoursLabel(afterHours), afterHours })),
  ]
}

export const SETTINGS_COPY = {
  serversFooter: 'Switch between servers, add a new one, or remove one from this phone only (the machine and agents keep running).',
  replyRemindersFooter: 'An agent whose turn ends with a message still owed a reply is reminded once. While off, owed replies are let go, so turning it on again reminds of nothing from before.',
  autoArchiveFooter: 'Finished agents quiet that long, with nothing still depending on them, are archived. Their history stays, and Archived brings them back.',
  foldFooter: 'Agents quiet that long (not busy, nothing unread or waiting) go into an Idle section at the bottom.',
  avatarsFooter: 'Agents use Notionists faces. The circle’s ring identifies the company: Anthropic terracotta, OpenAI green, Google red, DeepSeek blue, Qwen purple. Backgrounds go from light (fast) to medium (balanced) to dark (flagship); gray means unclassified. Turn this off to restore the original avatars.',
  appFooter: 'Screens and logic update over the air, without an app build.',
  updatesFromFooter: 'Updates come from this server, whichever server is open. With none, the built-in version runs.',
  faceIdMissing: 'Face ID is not set up on this phone.',
  inviteFooter: 'A one-time code they paste in the Ouro app (or a link they tap). The code lasts 10 minutes and gives them full access to this server.',
  peopleFooter: 'Each has their own chats; their messages show as them.',
} as const

/** The last button: with a hosted account it signs this phone out of everything; without one it removes this server. */
export interface LeaveAction { label: string; confirmTitle: string; confirmMessage: string; confirmLabel: string; failedText: string }
export function leaveAction(hasHostedAccount: boolean): LeaveAction {
  return hasHostedAccount
    ? {
      label: 'Sign out',
      confirmTitle: 'Sign out of this phone?',
      confirmMessage: 'Ouro forgets your account here. Your computers and agents keep running; signing in again needs a new invite code.',
      confirmLabel: 'Sign out',
      failedText: 'Could not sign out. Saved setup could not be updated.',
    }
    : {
      label: 'Unpair',
      confirmTitle: 'Remove this server?',
      confirmMessage: 'Ouro forgets this server on this phone; your other servers stay. Pair again with a new code (ouro pair).',
      confirmLabel: 'Remove',
      failedText: 'Could not remove saved server.',
    }
}

/** Under Unpair: removing the server here leaves this phone's token valid on the computer until it is revoked there. */
export const unpairFooter = (deviceName: string | undefined) =>
  `On the computer, \`ouro devices revoke ${deviceName ?? '<device>'}\` also revokes the token.`

/** Turning the lock on proves it works first: on a phone without Face ID it would lock the person out. */
export type FaceIdCheck = { kind: 'unavailable' } | { kind: 'refused' } | { kind: 'confirmed' }
export function faceIdNote(check: FaceIdCheck): string | null {
  return check.kind === 'unavailable' ? SETTINGS_COPY.faceIdMissing : null
}

/** "Updates from": each saved server, then none. The picker tags options by position, so no id doubles as "none". */
export interface UpdateHomeOption { label: string; serverId: string | null }
export function updateHomeOptions(servers: readonly SavedServer[]): UpdateHomeOption[] {
  return [...servers.map((server) => ({ label: server.label, serverId: server.id })), { label: 'None', serverId: null }]
}
export const updateHomeIndex = (options: readonly UpdateHomeOption[], homeServerId: string | null) =>
  Math.max(0, options.findIndex((option) => option.serverId === homeServerId))

// ---- notifications ----

export const NOTIFICATIONS_COPY = {
  footer: 'This server sends them once it has an APNs key. What needs me: questions to you, and group messages that mention you. Ask notifications have Reply and Snooze buttons.',
  savingFailed: 'saving failed',
  quietHoursFooter: 'Notifications arrive silently in this window, in this phone’s time zone. Urgent asks still break through when allowed.',
  mutedFooter: 'A muted agent sends you no notifications, not even its questions.',
} as const

export const NOTIFY_MODE_OPTIONS: readonly { mode: NotificationSettings['mode']; label: string }[] = [
  { mode: 'needs_me', label: 'What needs me' },
  { mode: 'every_message', label: 'Every message' },
  { mode: 'nothing', label: 'Nothing' },
]

/** "One banner per agent burst" is a switch; the server's window can be any length, and on means this one. */
export const BURST_SECONDS_WHEN_ON = 60
const QUIET_HOURS_WHEN_TURNED_ON = { start: '22:00', end: '07:00' } as const

/** Quiet hours start and end on the half hour. */
export const QUIET_HOURS_TIMES: readonly string[] = Array.from({ length: 48 }, (_, index) =>
  `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`)

export type NotificationChange =
  | { kind: 'mode'; mode: NotificationSettings['mode'] }
  | { kind: 'urgent_breaks_through'; on: boolean }
  | { kind: 'one_banner_per_burst'; on: boolean }
  | { kind: 'agent_muted'; agentId: string; muted: boolean }
  | { kind: 'quiet_hours'; on: boolean }
  | { kind: 'quiet_hours_start'; at: string }
  | { kind: 'quiet_hours_end'; at: string }

/**
 * The full settings to save: the command replaces them all, so everything not changed is carried over. Quiet hours take
 * the phone's zone on every save, so travelling and then changing anything moves them to where the phone is.
 */
export function changedNotificationSettings(current: NotificationSettings, change: NotificationChange, phoneTimeZone: string): NotificationSettings {
  const next = changedField(current, change, phoneTimeZone)
  return { ...next, quietHours: next.quietHours && { ...next.quietHours, timeZone: phoneTimeZone } }
}

function changedField(settings: NotificationSettings, change: NotificationChange, phoneTimeZone: string): NotificationSettings {
  switch (change.kind) {
    case 'mode': return { ...settings, mode: change.mode }
    case 'urgent_breaks_through': return { ...settings, urgentBreaksThrough: change.on }
    case 'one_banner_per_burst': return { ...settings, burstSeconds: change.on ? BURST_SECONDS_WHEN_ON : 0 }
    case 'agent_muted': {
      const others = settings.mutedAgentIds.filter((agentId) => agentId !== change.agentId)
      return { ...settings, mutedAgentIds: change.muted ? [...others, change.agentId] : others }
    }
    case 'quiet_hours': {
      if (!change.on) return { ...settings, quietHours: null }
      return settings.quietHours ? settings : { ...settings, quietHours: { ...QUIET_HOURS_WHEN_TURNED_ON, timeZone: phoneTimeZone } }
    }
    case 'quiet_hours_start': return settings.quietHours ? { ...settings, quietHours: { ...settings.quietHours, start: change.at } } : settings
    case 'quiet_hours_end': return settings.quietHours ? { ...settings, quietHours: { ...settings.quietHours, end: change.at } } : settings
  }
}

/** The entity less its id: what the command takes. */
export function notificationSettingsOf({ id: _id, ...settings }: NotificationSettingsEntity): NotificationSettings {
  return settings
}

/** Which server software answers, as the reference footnote says it. The API version is the one this app speaks: an
 * answer in any other would not have passed the contract. */
export const connectedText = (release: ServerEntity['release']) =>
  `Connected: ${ServerIdentity.shape.app.value} ${release.id}, API v${ServerIdentity.shape.apiVersion.value}`

/** The binary's own version and build, which an update over the air doesn't change. */
export function binaryVersionText(version: string | null, build: string | null): string | null {
  if (!version) return null
  return build ? `${version} (${build})` : version
}

/** A build without a channel takes production's updates, as the reference says. */
export const channelText = (channel: string | null) => channel || 'production'

/** The people the owner invited, oldest first, with their phones still connecting. The owner is not listed. */
export interface PersonRow { personId: string; name: string; address: string; devicesText: string; removeTitle: string; removeMessage: string }
export function peopleRows(people: Iterable<PersonEntity>, devices: Iterable<DeviceEntity>): PersonRow[] {
  const deviceCounts = new Map<string, number>()
  for (const device of devices) deviceCounts.set(device.personId, (deviceCounts.get(device.personId) ?? 0) + 1)
  return [...people]
    .filter((person) => !person.isOwner)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((person) => {
      const count = deviceCounts.get(person.id) ?? 0
      const devicesText = `${count} device${count === 1 ? '' : 's'}`
      return {
        personId: person.id, name: person.name, address: person.address, devicesText,
        removeTitle: `Remove ${person.name}?`,
        removeMessage: `${person.name}'s ${devicesText} will stop connecting. Their chats stay.`,
      }
    })
}

export const BASE_FOOTER = 'Updates keep your own changes. They merge beside the live code and switch only once everything builds.'
export const BASE_UPDATE_STARTED = 'Updating. Your agents restart when it finishes.'

/**
 * The "Ouro" section: which base this server's source has merged and how taking the next one is going. Null where the
 * server takes no bases (it publishes them, or has no copy of the source). Only the owner may take one.
 */
export interface BaseSection {
  versionText: string
  updatingText: string | null
  note: { text: string; color: 'orange' | 'red' } | null
  /** The newest base's release notes while it's newer, else what updates do. */
  footer: string
  /** The base the button takes, offered when newer and nothing is under way. */
  take: { n: number; label: string } | null
}

export function baseSection(base: ServerEntity['release']['base'], isOwner: boolean): BaseSection | null {
  if (base.kind === 'not_taking') return null
  const { offered, update } = base
  const newer = offered !== null && offered.n > base.integrated ? offered : null
  const takeable = newer !== null && isOwner && (update.state === 'idle' || update.state === 'failed')
  return {
    versionText: `Base ${base.integrated}`,
    updatingText: update.state === 'updating' ? `Updating to base ${update.n}…` : null,
    note: update.state === 'conflict'
      ? { text: `Base ${update.n} touches files you changed (${update.files.join(', ')}). Your master agent is working it out; nothing has changed yet.`, color: 'orange' }
      : update.state === 'failed'
        ? { text: `Base ${update.n} didn't go in: ${update.why}. Nothing live changed unless it says so.`, color: 'red' }
        : null,
    footer: newer?.notes ?? BASE_FOOTER,
    take: takeable ? { n: newer.n, label: `Update to base ${newer.n}` } : null,
  }
}

export const BACKUP_WARNING = "Your changes aren't backed up"
export const BACKUP_MADE_TOAST = 'Private copy made on your GitHub account.'

export const BACKUP_MAKING_TEXT = 'Making a private copy…'
const BACKUP_DETAIL = "Changes you or your agents made to Ouro exist only on this server. A private copy on your GitHub account keeps them safe, and only you can see it."

/**
 * The "Backup" section: the warning while the source has changes on no base and no private copy, the copy being made, and
 * once it exists, where it is, when it was last pushed and whether a push is waiting. Only the owner sets one up. Tapping
 * the warning connects GitHub first when it isn't, and the copy is then made without another tap.
 */
export interface BackupSection {
  warning: string | null
  detail: string
  /** What tapping the row does; null when it isn't the viewer's to do. */
  action: { kind: 'connect_github'; label: string } | { kind: 'make_private_copy'; label: string } | null
  /** Shown instead of the action while the copy is being made. */
  working: string | null
  /** Why the last push to the copy failed, shown beneath. */
  failure: string | null
  /** The copy that exists. `url` is where tapping it goes, when the repository is one GitHub has. */
  copy: { headline: string; url: string | null; lastPushedText: string | null; pendingText: string | null } | null
}

/** `owner/name` on GitHub; a local path (a stand-in's) has no page. */
const gitHubUrlOf = (repository: string): string | null => (/^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}` : null)

export function backupSection(backup: ServerEntity['sourceBackup'], isOwner: boolean, now: number): BackupSection | null {
  const none = { warning: null, working: null, failure: null, copy: null, action: null }
  switch (backup.state) {
    case 'not_applicable':
    case 'nothing_to_back_up':
      return null
    case 'not_backed_up':
      return {
        ...none,
        warning: BACKUP_WARNING,
        detail: BACKUP_DETAIL,
        action: !isOwner ? null : backup.github === 'connected'
          ? { kind: 'make_private_copy', label: 'Make a private copy' }
          : { kind: 'connect_github', label: 'Connect GitHub to back up' },
      }
    case 'making_private_copy':
      return { ...none, detail: BACKUP_DETAIL, working: BACKUP_MAKING_TEXT }
    case 'backed_up': {
      const failed = backup.lastPushError !== null
      return {
        ...none,
        warning: failed ? "Your last changes didn't reach the backup" : null,
        detail: failed ? `Your private copy, ${backup.repository}, is behind. Ouro tries again after the next update.` : 'Your changes to Ouro are kept in a private repository on your GitHub account.',
        failure: backup.lastPushError,
        copy: {
          headline: `Backed up to ${backup.repository}`,
          url: gitHubUrlOf(backup.repository),
          lastPushedText: backup.lastPushedAt === null ? null : ago(backup.lastPushedAt, now) === 'now' ? 'just now' : `${ago(backup.lastPushedAt, now)} ago`,
          pendingText: backup.behind && !failed ? "Push pending: the live version isn't in the backup yet" : null,
        },
      }
    }
  }
}
