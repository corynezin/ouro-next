// Settings as data. Pure: Screen.tsx only draws this.
import { ago } from '../../design/format.ts'
import { MASTER_AGENT_NAME } from '@ouro/contract'
import type {
  ChatgptIntegrationState, ClaudeIntegrationState, DeviceEntity, GithubIntegrationState, NotificationSettings, NotificationSettingsEntity, OpenrouterIntegrationState, PersonEntity,
  ServerEntity, TailscaleState,
} from '@ouro/contract'
import type { SavedServer } from '../../core/accounts/savedServers.ts'

export const SETTINGS_COPY = {
  inviteFooter: 'A one-time code they paste in the Ouro app (or a link they tap). The code lasts 10 minutes and gives them full access to this server.',
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

/** "Updates from": each saved server, then none. The picker tags options by position, so no id doubles as "none". */
export interface UpdateHomeOption { label: string; serverId: string | null }
export function updateHomeOptions(servers: readonly SavedServer[]): UpdateHomeOption[] {
  return [...servers.map((server) => ({ label: server.label, serverId: server.id })), { label: 'None', serverId: null }]
}
export const updateHomeIndex = (options: readonly UpdateHomeOption[], homeServerId: string | null) =>
  Math.max(0, options.findIndex((option) => option.serverId === homeServerId))

// ---- notifications ----

export const NOTIFICATIONS_COPY = {
  savingFailed: 'saving failed',
} as const

/** What Settings changes: on or off (as a mode), and urgent asks through Focus. */
export type NotificationChange =
  | { kind: 'mode'; mode: NotificationSettings['mode'] }
  | { kind: 'urgent_breaks_through'; on: boolean }

/**
 * The full settings to save: the command replaces them all, so everything not changed is carried over. Quiet hours take
 * the phone's zone on every save, so travelling and then changing anything moves them to where the phone is.
 */
export function changedNotificationSettings(current: NotificationSettings, change: NotificationChange, phoneTimeZone: string): NotificationSettings {
  const next = changedField(current, change)
  return { ...next, quietHours: next.quietHours && { ...next.quietHours, timeZone: phoneTimeZone } }
}

function changedField(settings: NotificationSettings, change: NotificationChange): NotificationSettings {
  switch (change.kind) {
    case 'mode': return { ...settings, mode: change.mode }
    case 'urgent_breaks_through': return { ...settings, urgentBreaksThrough: change.on }
  }
}

/** The entity less its id: what the command takes. */
export function notificationSettingsOf({ id: _id, ...settings }: NotificationSettingsEntity): NotificationSettings {
  return settings
}

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
  /** After a conflict no agent is resolving yet, the owner's choice: have the master agent merge it, or drop the update. */
  conflict: { resolveLabel: string; dropLabel: string; dropTitle: string; dropMessage: string } | null
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
      ? { text: conflictText(update.n, update.files, update.resolver === undefined ? MASTER_AGENT_NAME : update.resolver), color: 'orange' }
      : update.state === 'failed'
        ? { text: `Base ${update.n} didn't go in: ${update.why}. Nothing live changed unless it says so.`, color: 'red' }
        : null,
    footer: newer?.notes ?? BASE_FOOTER,
    take: takeable ? { n: newer.n, label: `Update to base ${newer.n}` } : null,
    conflict: update.state === 'conflict' && update.resolver === null && isOwner ? {
      resolveLabel: 'Have your master agent merge it',
      dropLabel: 'Not now',
      dropTitle: `Skip base ${update.n} for now?`,
      dropMessage: 'The merge is thrown away and nothing changes. You can update again later.',
    } : null,
  }
}

/** A conflict waits for the owner's choice (`resolver` null) or for the agent working it out. An older server sends no
 * `resolver`: it went to the master agent at once. */
function conflictText(n: number, files: string[], resolver: string | null): string {
  const touches = `Base ${n} touches files you changed (${files.join(', ')}).`
  if (resolver === null) return `${touches} Nothing has changed yet. Your master agent can merge it, keeping what your changes were for.`
  const who = resolver === MASTER_AGENT_NAME ? 'Your master agent' : `An agent, ${resolver},`
  return `${touches} ${who} is working it out; nothing has changed yet.`
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

// ---- the reworked page: one-line summaries ----

export interface IntegrationRow { key: 'claude' | 'chatgpt' | 'openrouter' | 'github'; title: string; status: string; route: 'Claude' | 'ChatGPT' | 'OpenRouter' | 'GitHub' }

/** Integrations as one row each: Connected, or Not set up (signed out, not installed, no key). Detail is on each one's screen. */
export function integrationRows(states: {
  claude: ClaudeIntegrationState | null; chatgpt: ChatgptIntegrationState | null; openrouter: OpenrouterIntegrationState | null; github: GithubIntegrationState | null
}): IntegrationRow[] {
  const status = (state: { status: string } | null, connected: string) => (!state ? 'Checking…' : state.status === connected ? 'Connected' : 'Not set up')
  return [
    { key: 'claude', title: 'Claude Code', status: status(states.claude, 'signed_in'), route: 'Claude' },
    { key: 'chatgpt', title: 'ChatGPT', status: status(states.chatgpt, 'signed_in'), route: 'ChatGPT' },
    { key: 'openrouter', title: 'OpenRouter', status: status(states.openrouter, 'configured'), route: 'OpenRouter' },
    { key: 'github', title: 'GitHub', status: status(states.github, 'connected'), route: 'GitHub' },
  ]
}

/** AWS's row: its state comes from its own route, not sync. Null when that route failed: the row then shows no status. */
export function awsStatusText(aws: { status: 'not_connected' | 'connected' } | null, failed: boolean): string | null {
  if (failed) return null
  return !aws ? 'Checking…' : aws.status === 'connected' ? 'Connected' : 'Not set up'
}

/** Tailscale's row, like AWS's from its own route: Connected or Not set up, or what it's in the middle of. */
export function tailscaleStatusText(tailscale: TailscaleState | null, failed: boolean): string | null {
  if (failed) return null
  if (!tailscale) return 'Checking…'
  switch (tailscale.state) {
    case 'connected': return 'Connected'
    case 'not_connected': return 'Not set up'
    case 'not_needed': return 'Not needed'
    case 'installing': return 'Setting up…'
    case 'logging_in': return 'Waiting for approval'
    case 'removing': return 'Removing…'
  }
}

/** The server's short name: its label on this phone (which can be renamed in Servers), else the machine's name. */
export function serverShortName(servers: readonly SavedServer[], serverId: string, machineName: string | null): string {
  return servers.find((server) => server.id === serverId)?.label ?? machineName ?? 'This server'
}
