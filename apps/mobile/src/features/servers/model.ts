// The saved servers as rows. Pure: Screen.tsx only draws this.
import type { HostedServer, ProvisioningStep } from '@ouro/contract'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import { hubFailureText } from '../../core/hub/hubApi.ts'
import type { HubFailure } from '../../core/hub/hubApi.ts'

/** What the last check of the servers that aren't open found, and whether one is running. */
export interface OtherServersUnreadView { counts: ReadonlyMap<string, number>; checking: boolean }

export interface ServerRow {
  id: string; label: string; url: string; personText: string | null; isActive: boolean; canRemove: boolean
  /** The badge: unread there, when it isn't open and has some. */
  unreadBadge: number | null
  /** The spinner: a check is running and has nothing to show for it yet. */
  checking: boolean
}

export function serverRows(servers: readonly SavedServer[], activeId: string | null, unread: OtherServersUnreadView): ServerRow[] {
  return servers.map((server) => {
    const isActive = server.id === activeId
    const count = isActive ? 0 : unread.counts.get(server.id) ?? 0
    return {
      id: server.id,
      label: server.label,
      url: server.url,
      personText: server.personName ? `You: ${server.personName}` : null,
      isActive,
      // The active server is left by switching, not removed from under the screens showing it.
      canRemove: !isActive,
      unreadBadge: count > 0 ? count : null,
      checking: !isActive && count === 0 && unread.checking,
    }
  })
}

/** Under the list while a check runs. */
export function checkingNote(rows: readonly ServerRow[], checking: boolean): string | null {
  if (!checking) return null
  const total = rows.reduce((sum, row) => sum + (row.unreadBadge ?? 0), 0)
  return `Checking other servers${total > 0 ? ` (${total} unread)` : ''}…`
}

/** A rename's new label. Null when there's nothing to change: blank is ignored, as is the same label. */
export function renamedLabel(typed: string, current: string): string | null {
  const label = typed.trim()
  return label && label !== current ? label : null
}

/** One of the account's servers that this phone isn't paired with: still being set up, failed, or ready to connect. */
export interface HostedRow { id: string; label: string; detail: string }

const STEP_TEXT: Record<ProvisioningStep, string> = {
  create: 'Creating…', upload: 'Copying Ouro…', install: 'Installing tools…',
  setup: 'Setting up agents…', service: 'Opening connection…', pair: 'Connecting…',
}

const withoutTrailingSlashes = (url: string) => url.replace(/\/+$/, '')

export function hostedRows(hosted: readonly HostedServer[], saved: readonly SavedServer[]): HostedRow[] {
  const savedIds = new Set(saved.map((server) => server.hostedServerId))
  // Paired before the phone kept hosted ids: known by its address instead.
  const savedUrls = new Set(saved.map((server) => withoutTrailingSlashes(server.url)))
  const unpaired = hosted.filter((server) => {
    if (savedIds.has(server.id)) return false
    return !(server.status.state === 'ready' && savedUrls.has(withoutTrailingSlashes(server.status.address)))
  })
  return unpaired.map((server) => ({ id: server.id, label: server.label, detail: hostedDetail(server.status) }))
}

function hostedDetail(status: HostedServer['status']): string {
  switch (status.state) {
    case 'ready': return 'Ready — tap to connect'
    case 'failed': return `Error: ${status.why || 'unknown'}`
    case 'provisioning': return STEP_TEXT[status.step]
  }
}

export const NEW_SERVER_LABEL_MAX = 40

/** The label New server sends, or why it can't. Null when nothing is typed yet: Create is just disabled. */
export function newServerLabelOf(typed: string): { label: string } | { error: string } | null {
  const label = typed.trim()
  if (!label) return null
  if (label.length > NEW_SERVER_LABEL_MAX) return { error: `Name too long (max ${NEW_SERVER_LABEL_MAX} characters).` }
  if (/[\x00-\x1f\x7f]/.test(label)) return { error: 'Name contains invalid characters.' }
  return { label }
}

export const createFailureText = (failure: HubFailure) => hubFailureText(failure, NEW_SERVER_COPY.failed)

export const NEW_SERVER_COPY = {
  button: 'New server',
  title: 'Name your new server',
  placeholder: 'e.g. Work',
  hint: 'A server takes a few minutes to set up. You can leave and come back.',
  failed: 'Could not create the server.',
} as const

export const SERVERS_COPY = {
  storageError: 'Could not read or update saved servers. Retry, or use the storage recovery warning.',
  noCredentials: 'This server has no usable saved credentials. Pair again to reconnect.',
  removeTitle: (label: string) => `Remove ${label}?`,
  removeMessage: 'The machine and agents keep running. Pair again later with a new code.',
} as const
