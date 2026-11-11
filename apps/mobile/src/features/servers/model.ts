// The servers as rows: the ones saved on this phone, each with how it is linked to the open one, then the computers the
// open one is linked to that this phone isn't paired with. Pure: Screen.tsx only draws this.
import type { ComputerEntity, HostedServer, MachineProvider, NewMachine, ProvisioningStep } from '@ouro/contract'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import { computerStateText } from '../computers/model.ts'
import { hubFailureText } from '../../core/hub/hubApi.ts'
import type { HubFailure, HubResult } from '../../core/hub/hubApi.ts'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'

/** What the last check of the servers that aren't open found, and whether one is running. */
export interface OtherServersUnreadView { counts: ReadonlyMap<string, number>; checking: boolean }

/** How a server is linked to the open one, as one of its computers. Null on the open server's own row. */
export type ServerLink =
  | { kind: 'linked'; computerId: string; stateText: string; fullTrust: boolean; incompatibility: string | null }
  | { kind: 'not_linked' }

export interface ServerRow {
  id: string; label: string; url: string; personText: string | null; isActive: boolean; canRemove: boolean
  link: ServerLink | null
  /** The badge: unread there, when it isn't open and has some. */
  unreadBadge: number | null
  /** The spinner: a check is running and has nothing to show for it yet. */
  checking: boolean
}

const withoutTrailingSlashes = (url: string) => url.replace(/\/+$/, '')

/** The open server's computer at a saved server's address: the same machine, linked. */
export const computerAt = (url: string, computers: Iterable<ComputerEntity>): ComputerEntity | undefined =>
  [...computers].find((computer) => computer.address && withoutTrailingSlashes(computer.address) === withoutTrailingSlashes(url))

function linkOf(computer: ComputerEntity | undefined): ServerLink {
  if (!computer) return { kind: 'not_linked' }
  return { kind: 'linked', computerId: computer.id, stateText: computerStateText(computer), fullTrust: computer.trust === 'full', incompatibility: computer.incompatibility }
}

export function serverRows(servers: readonly SavedServer[], activeId: string | null, unread: OtherServersUnreadView, computers: Iterable<ComputerEntity> = []): ServerRow[] {
  const linked = [...computers]
  return servers.map((server) => {
    const isActive = server.id === activeId
    const count = isActive ? 0 : unread.counts.get(server.id) ?? 0
    return {
      link: isActive ? null : linkOf(computerAt(server.url, linked)),
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

/** A computer the open server is linked to that this phone isn't paired with, such as one linked from Terminal. */
export interface UnpairedComputerRow { computerId: string; name: string; stateText: string; fullTrust: boolean; incompatibility: string | null }

export function unpairedComputerRows(computers: Iterable<ComputerEntity>, servers: readonly SavedServer[]): UnpairedComputerRow[] {
  const savedUrls = new Set(servers.map((server) => withoutTrailingSlashes(server.url)))
  return [...computers]
    .filter((computer) => !computer.address || !savedUrls.has(withoutTrailingSlashes(computer.address)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((computer) => ({ computerId: computer.id, name: computer.name, stateText: computerStateText(computer), fullTrust: computer.trust === 'full', incompatibility: computer.incompatibility }))
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
  titleOn: (where: string) => `Name your new server on ${where}`,
  placeholder: 'e.g. Work',
  hint: 'A server takes a few minutes to set up. You can leave and come back.',
  /** EC2 installs everything from a bare Ubuntu machine. */
  hintFor: (provider: string) => provider === 'aws'
    ? 'An EC2 server takes about 10–15 minutes to set up. You can leave and come back.'
    : 'A server takes several minutes to set up. You can leave and come back.',
  failed: 'Could not create the server.',
  chooseTitle: 'Where should the new server run?',
  hosted: 'Ouro hosted',
  setUpFirst: (name: string) => `Set up ${name}…`,
  removeTitle: (label: string) => `Remove ${label}?`,
  removeMessage: 'Its machine is destroyed, with everything on it.',
  removeFailed: (why: string) => `Could not remove it: ${why}`,
  destroy: 'Destroy machine…',
  destroyTitle: (label: string) => `Destroy ${label}?`,
  destroyMessage: 'Its machine is deleted, with its agents and everything on it, and the server leaves this phone. This can\'t be undone.',
  destroyConfirm: 'Destroy',
  destroyFailed: (why: string) => `Could not destroy it: ${why}`,
} as const

// ---- Servers this server makes on a cloud account (contract machines.ts) ----

/** One place a new server can be made, as the New server menu offers it. */
export type NewServerChoice =
  | { kind: 'machine'; provider: string; title: string; detail: string }
  /** Not set up yet: choosing it opens the integration's screen, when this app knows it. */
  | { kind: 'set_up'; provider: string; title: string; detail: string; route: IntegrationRoute | null }
  | { kind: 'hosted'; title: string }

export type IntegrationRoute = 'AWS' | 'Sprites'

/** The screen for a provider's `setup`; null for one this app doesn't know yet. */
export function integrationRouteOf(setup: string | null): IntegrationRoute | null {
  switch (setup) {
    case 'aws': return 'AWS'
    case 'sprites': return 'Sprites'
    default: return null
  }
}

/** The open server's providers, then the hosted hub's when the phone has an account with room. */
export function newServerChoices(providers: readonly MachineProvider[], hostedAvailable: boolean): NewServerChoice[] {
  const choices: NewServerChoice[] = providers.map((provider) => provider.available
    ? { kind: 'machine', provider: provider.id, title: provider.name, detail: provider.detail }
    : { kind: 'set_up', provider: provider.id, title: NEW_SERVER_COPY.setUpFirst(provider.name), detail: provider.detail, route: integrationRouteOf(provider.setup) })
  if (hostedAvailable) choices.push({ kind: 'hosted', title: NEW_SERVER_COPY.hosted })
  return choices
}

/** A machine this server is making, or made and no phone has paired with yet, or failed to make. */
export interface MachineRow { id: string; label: string; detail: string; canRemove: boolean }

const providerName = (provider: string, providers: readonly MachineProvider[]) =>
  providers.find((candidate) => candidate.id === provider)?.name ?? provider

export function machineRows(machines: readonly NewMachine[], providers: readonly MachineProvider[], saved: readonly SavedServer[]): MachineRow[] {
  const savedUrls = new Set(saved.map((server) => withoutTrailingSlashes(server.url)))
  return machines
    .filter((machine) => !machine.paired && !(machine.status.state === 'ready' && savedUrls.has(withoutTrailingSlashes(machine.status.address))))
    .map((machine) => ({
      id: machine.id,
      label: machine.label,
      detail: `${providerName(machine.provider, providers)} · ${hostedDetail(machine.status)}`,
      canRemove: machine.status.state !== 'provisioning',
    }))
}

/** The machine the open server made for this saved server, paired or not, when it made one and it's ready: the one Destroy
 * removes. */
export function machineOfServer(url: string, machines: readonly NewMachine[]): NewMachine | null {
  const address = withoutTrailingSlashes(url)
  return machines.find((machine) => machine.status.state === 'ready' && withoutTrailingSlashes(machine.status.address) === address) ?? null
}

/** A machine's state as the setup flow reads a hosted server's: the same shape, and failures in the hub's terms. */
export function machineAsHosted(result: ApiResult<NewMachine>): HubResult<HostedServer> {
  if (result.ok) {
    const { id, label, createdAt, status } = result.value
    return { ok: true, value: { id, label, createdAt, primary: false, status } }
  }
  const { failure } = result
  switch (failure.kind) {
    case 'unauthenticated': return { ok: false, failure: { kind: 'unauthenticated' } }
    case 'refused': return { ok: false, failure: { kind: 'refused', code: failure.error.code, message: failure.error.message, retryable: failure.error.retryable } }
    case 'invalid_answer': return { ok: false, failure: { kind: 'invalid_answer', status: failure.status } }
    case 'machine_unreachable':
    case 'no_answer':
    case 'timed_out':
    case 'cancelled': return { ok: false, failure: { kind: 'unreachable', reason: failureText(failure) } }
  }
}

export const SERVERS_COPY = {
  storageError: 'Could not read or update saved servers. Retry, or use the storage recovery warning.',
  noCredentials: 'This server has no usable saved credentials. Pair again to reconnect.',
  removeTitle: (label: string) => `Remove ${label}?`,
  removeMessage: 'The machine and agents keep running. Pair again later with a new code.',
  removeFromPhone: 'Remove from this phone',
  removeAndUnlink: 'Remove and unlink',
  unlink: 'Unlink',
  unlinkTitle: (label: string) => `Unlink ${label}?`,
  unlinkMessage: (running: number | null) => running
    ? `${running} ${running === 1 ? 'agent is' : 'agents are'} running there. They keep running, but this server won't see them any more.`
    : 'This server stops reaching it. Nothing on it is deleted.',
  notLinked: 'Not linked',
  link: 'Link',
  linking: 'Linking…',
  linkFailed: (label: string, why: string) => `Could not link ${label}: ${why}`,
  notOnPhone: 'Not on this phone',
  fullTrust: 'Full trust',
  limitedTrust: 'Limited trust',
  unlinkFailed: 'Could not unlink it.',
  trustFailed: 'Could not change its trust.',
  footer: 'Linked servers can start agents on each other: pick one under Machine when starting an agent. Full trust lets a server do anything you or an agent can do on this one; limited trust only lets it send messages.',
  offlineNote: 'An offline server comes back by itself when it wakes.',
  linkByCommand: 'Link a computer with a command',
} as const
