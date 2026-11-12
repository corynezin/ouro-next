// Settings as data. Pure: Screen.tsx only draws this.
import { ago } from '../../design/format.ts'
import type {
  AwsIntegrationState, ChatgptIntegrationState, ClaudeIntegrationState, DeviceEntity, GithubIntegrationState, NotificationSettings, NotificationSettingsEntity, OpenrouterIntegrationState, PersonEntity,
  ServerEntity, SpritesIntegrationState, TailscaleState,
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

/** A mode that notifies: what the switch turns on to. */
export type NotifyingMode = Exclude<NotificationSettings['mode'], 'nothing'>

/**
 * What Settings changes: on or off, and urgent asks through Focus. Turning on restores `lastOnMode`, the mode in use before
 * it was turned off: Settings offers no mode picker, so one lost here couldn't be chosen again.
 */
export type NotificationChange =
  | { kind: 'on'; on: boolean; lastOnMode: NotifyingMode }
  | { kind: 'urgent_breaks_through'; on: boolean }

/** The mode to remember as notifications are turned off: the one in use, or the one remembered already. */
export const notifyingModeOf = (settings: NotificationSettings, remembered: NotifyingMode): NotifyingMode =>
  settings.mode === 'nothing' ? remembered : settings.mode

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
    case 'on': return { ...settings, mode: change.on ? notifyingModeOf(settings, change.lastOnMode) : 'nothing' }
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

export const BASE_UPDATE_STARTED = 'Updating. Your agents restart when it finishes.'

/**
 * The "Ouro" section: which version this server runs and how taking the next base is going. A base is named by its
 * version (`0.6.0`) when it has one, else by its number, from before versions. Null where the server takes no bases (it publishes them, or has no copy of the source). Only the owner may take one.
 */
export interface BaseSection {
  versionText: string
  updatingText: string | null
  note: { text: string; color: 'orange' | 'red' } | null
  /** The newest base's release notes while it's newer. */
  footer: string | null
  /** The base the button takes, offered when newer and nothing is under way. */
  take: { n: number; label: string } | null
  /** After a conflict no agent is resolving yet, the owner's choice: have an agent merge it, or drop the update. */
  conflict: { resolveLabel: string; dropLabel: string; dropTitle: string; dropMessage: string; dropConfirmLabel: string } | null
}

export function baseSection(release: Pick<ServerEntity['release'], 'base' | 'version'>, isOwner: boolean): BaseSection | null {
  const { base } = release
  if (base.kind === 'not_taking') return null
  const { offered, update } = base
  const newer = offered !== null && offered.n > base.integrated ? offered : null
  const takeable = newer !== null && isOwner && (update.state === 'idle' || update.state === 'failed')
  // Only the offered base's version is known; any other is named by its number.
  const version = (n: number) => (offered?.n === n ? offered.version ?? null : null)
  const named = (n: number) => { const v = version(n); return v ? `Ouro ${v}` : `Base ${n}` }
  const target = (n: number) => version(n) ?? `base ${n}`
  return {
    versionText: release.version ?? `Base ${base.integrated}`,
    updatingText: update.state === 'updating' ? `Updating to ${target(update.n)}…` : null,
    note: update.state === 'conflict'
      ? { text: conflictText(named(update.n), update.files, update.resolver), color: 'orange' }
      : update.state === 'failed'
        ? { text: `${named(update.n)} didn't go in: ${update.why}. Nothing live changed unless it says so.`, color: 'red' }
        : null,
    footer: newer?.notes ?? null,
    take: takeable ? { n: newer.n, label: `Update to ${target(newer.n)}` } : null,
    conflict: update.state === 'conflict' && update.resolver === null && isOwner ? {
      resolveLabel: 'Have an agent merge it',
      dropLabel: 'Not now',
      dropTitle: `Skip ${target(update.n)} for now?`,
      dropMessage: 'The merge is thrown away and nothing changes. You can update again later.',
      dropConfirmLabel: 'Skip',
    } : null,
  }
}

/** A conflict waits for the owner's choice (`resolver` null) or for the agent started to work it out. An older server sends
 * no `resolver`: it handed the conflict to an agent at once. `named` is the base as the person knows it. */
function conflictText(named: string, files: string[], resolver: string | null | undefined): string {
  const touches = `${named} touches files you changed (${files.join(', ')}).`
  if (resolver === null) return `${touches} Nothing has changed yet. An agent can merge it, keeping what your changes were for.`
  const who = resolver === undefined ? 'An agent' : `An agent, ${resolver},`
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

// ---- one-line summaries ----

/** A status read from its own route rather than sync: being asked, the route failed, or its answer. */
export type RouteStatus<T> = { kind: 'checking' } | { kind: 'failed' } | { kind: 'loaded'; value: T }

const CHECKING_TEXT = 'Checking…'

export interface IntegrationRow { key: 'claude' | 'chatgpt' | 'openrouter' | 'github'; title: string; status: string; route: 'Claude' | 'ChatGPT' | 'OpenRouter' | 'GitHub' }

/** Integrations as one row each: Connected, or Not set up (signed out, not installed, no key). Detail is on each one's screen. */
export function integrationRows(states: {
  claude: ClaudeIntegrationState | null; chatgpt: ChatgptIntegrationState | null; openrouter: OpenrouterIntegrationState | null; github: GithubIntegrationState | null
}): IntegrationRow[] {
  // Typed per provider, so a misspelt or renamed status doesn't compile.
  const status = <S extends { status: string }>(state: S | null, connected: S['status']) => (!state ? CHECKING_TEXT : state.status === connected ? 'Connected' : 'Not set up')
  return [
    { key: 'claude', title: 'Claude Code', status: status(states.claude, 'signed_in'), route: 'Claude' },
    { key: 'chatgpt', title: 'ChatGPT', status: status(states.chatgpt, 'signed_in'), route: 'ChatGPT' },
    { key: 'openrouter', title: 'OpenRouter', status: status(states.openrouter, 'configured'), route: 'OpenRouter' },
    { key: 'github', title: 'GitHub', status: status(states.github, 'connected'), route: 'GitHub' },
  ]
}

/** AWS's row: its state comes from its own route, not sync. Null when that route failed: the row then shows no status. */
export function awsStatusText(aws: RouteStatus<AwsIntegrationState>): string | null {
  switch (aws.kind) {
    case 'checking': return CHECKING_TEXT
    case 'failed': return null
    case 'loaded': return aws.value.status === 'connected' ? 'Connected' : 'Not set up'
  }
}

/** Sprites' row, like AWS's: Connected (or what the Sprites API said about the token), or Not set up. */
export function spritesStatusText(sprites: RouteStatus<SpritesIntegrationState>): string | null {
  switch (sprites.kind) {
    case 'checking': return CHECKING_TEXT
    case 'failed': return null
    case 'loaded': return sprites.value.status === 'connected' ? (sprites.value.problem ? 'Not working' : 'Connected') : 'Not set up'
  }
}

/** Tailscale's row, like AWS's from its own route: Connected or Not set up, or what it's in the middle of. */
export function tailscaleStatusText(status: RouteStatus<TailscaleState>): string | null {
  if (status.kind === 'checking') return CHECKING_TEXT
  if (status.kind === 'failed') return null
  const tailscale = status.value
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
