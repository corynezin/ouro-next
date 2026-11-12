// The servers as rows: the ones saved on this phone, each with how it is linked to the open one, then the computers the
// open one is linked to that this phone isn't paired with. Pure: Screen.tsx only draws this.
import { NETWORK_NAME_PATTERN } from '@ouro/contract'
import type { ComputerEntity, HostedServer, MachineProvider, NetworkEntity, NetworkKind, NetworkRole, NewMachine, ProvisioningStep } from '@ouro/contract'
import { pairingTarget } from '../pair/model.ts'
import { sameServerUrl } from '../../core/accounts/savedServers.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import type { ServerPlace } from '../../core/servers/otherServersUnread.ts'
import type { NetworkPlan } from '../../core/servers/networkPlans.ts'
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

/** The open server's computer at a saved server's address: the same machine, linked. */
export const computerAt = (url: string, computers: Iterable<ComputerEntity>): ComputerEntity | undefined =>
  [...computers].find((computer) => computer.address && sameServerUrl(computer.address, url))

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
  return [...computers]
    .filter((computer) => !computer.address || !isSaved(computer.address, servers))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((computer) => ({ computerId: computer.id, name: computer.name, stateText: computerStateText(computer), fullTrust: computer.trust === 'full', incompatibility: computer.incompatibility }))
}

// ---- Networks (contract computers.ts) ----

/** The servers in one network this phone knows of, or, with `key` 'outside', those in none of them. */
export interface NetworkSection {
  /** The network's id, 'outside', or 'all' when no server has networks. */
  key: string
  /** The open server's own copy of the network, when it holds its key: what the empty note is for. */
  network: NetworkEntity | null
  /** A saved server holding the network's key, the open one first: Invite asks it for the invite. Null: none does. */
  inviteVia: { serverId: string; network: NetworkEntity } | null
  /** Null: no server has networks, so the list is one, as before networks. */
  title: string | null
  /** Under the title: what the network is and, for one the open server visits, that it does. */
  detail: string | null
  /** Under a network the open server holds that nothing else lives in yet: how to add one. */
  emptyNote: string | null
  rows: ServerRow[]
  unpaired: UnpairedComputerRow[]
}

/** Two words: what the network is, and, for one the open server only holds a key to, that it visits. */
const networkDetail = (network: NetworkEntity): string =>
  network.role === 'extra' ? 'Shared · visiting' : network.kind === 'private' ? 'Private' : 'Shared'

const EMPTY_PLACE: ServerPlace = { networks: [], computers: [] }

/**
 * Every server under the network it lives in, the same whichever is open: the phone puts the picture together from what
 * each saved server says about itself, so no server learns of another's networks. A server lives in the network it holds
 * as its home; one that runs code from before networks, where a server that has networks says it lives (never one that
 * only visits). A server that only visits a network isn't listed in it. Computers this phone isn't paired with are placed
 * as the open server knows them. The open server's networks come first, its home first; the rest after; then "Not in a
 * network". Without networks anywhere, one untitled section.
 */
export function networkSections(rows: readonly ServerRow[], unpaired: readonly UnpairedComputerRow[], places: ReadonlyMap<string, ServerPlace>, pendingPrivate: readonly string[] = []): NetworkSection[] {
  const activeId = rows.find((row) => row.isActive)?.id ?? null
  const open = (activeId !== null ? places.get(activeId) : undefined) ?? EMPTY_PLACE
  // The open server's view first, so its own copy of each network wins.
  const others = [...places].filter(([id]) => id !== activeId)
  const views = [open, ...others.map(([, place]) => place)]
  /** Which saved server each view is: the open one, then the others. */
  const viewIds = [activeId, ...others.map(([id]) => id)]
  const known = new Map<string, NetworkEntity>()
  for (const view of views) for (const network of view.networks) if (!known.has(network.id)) known.set(network.id, network)
  const knownNames = new Set([...known.values()].map((network) => network.name))
  // A private network started but with no server yet (see core/servers/networkPlans.ts): shown, empty, until one is.
  const pending: NetworkSection[] = pendingPrivate.filter((name) => !knownNames.has(name))
    .map((name) => ({ key: `pending:${name}`, network: null, inviteVia: null, title: name, detail: 'Private', emptyNote: NETWORKS_COPY.pendingNote, rows: [], unpaired: [] }))
  if (known.size === 0) return [{ key: 'all', network: null, inviteVia: null, title: pending.length ? NETWORKS_COPY.outside : null, detail: null, emptyNote: null, rows: [...rows], unpaired: [...unpaired] }, ...pending]

  const livesIn = (computer: ComputerEntity | undefined, view: ServerPlace): string | null =>
    computer && !computer.visiting && computer.networkId && view.networks.some((network) => network.id === computer.networkId) ? computer.networkId : null
  const networkOfRow = (row: ServerRow): string | null => {
    const own = places.get(row.id)?.networks.find((network) => network.role === 'home')
    if (own) return own.id
    for (const view of views) {
      const networkId = livesIn(computerAt(row.url, view.computers), view)
      if (networkId !== null) return networkId
    }
    return null
  }
  const networkOfUnpaired = (row: UnpairedComputerRow): string | null => livesIn(open.computers.find((computer) => computer.id === row.computerId), open)

  const held = new Map(open.networks.map((network) => [network.id, network]))
  const order = [
    ...open.networks.filter((network) => network.role === 'home'),
    ...open.networks.filter((network) => network.role !== 'home'),
    ...[...known.values()].filter((network) => !held.has(network.id)).sort((a, b) => a.name.localeCompare(b.name)),
  ]
  const sections: NetworkSection[] = order.flatMap((network) => {
    const inIt = rows.filter((row) => networkOfRow(row) === network.id)
    const unpairedInIt = unpaired.filter((row) => networkOfUnpaired(row) === network.id)
    const others = inIt.filter((row) => !row.isActive).length + unpairedInIt.length
    const own = held.get(network.id) ?? null
    if (own === null && others === 0) return []
    const holderId = viewIds[views.findIndex((view) => view.networks.some((held) => held.id === network.id))] ?? null
    return [{
      key: network.id, network: own, inviteVia: holderId === null ? null : { serverId: holderId, network }, title: network.name,
      detail: own ? networkDetail(own) : network.kind === 'private' ? 'Private' : 'Shared',
      emptyNote: own && others === 0 ? NETWORKS_COPY.empty : null, rows: inIt, unpaired: unpairedInIt,
    }]
  })
  const outside = { key: 'outside', network: null, inviteVia: null, title: NETWORKS_COPY.outside, detail: null, emptyNote: null, rows: rows.filter((row) => networkOfRow(row) === null), unpaired: unpaired.filter((row) => networkOfUnpaired(row) === null) }
  return [...sections, ...pending, ...(outside.rows.length + outside.unpaired.length > 0 ? [outside] : [])]
}

/** Where a new server can go: a network a saved server holds a key for (invited from the open server when it holds it,
 * else the first saved server that does), or a private network the person started that no server is in yet, which this
 * server then makes. A server the person already runs may also stay as it is; a new one may go in no network (and is then
 * linked with the others while no saved server uses networks). Networks are started on their own page, and someone else's
 * is joined with Network… first; either is then one of these. `group`: the section it's listed in. */
export interface NewServerNetworkChoice {
  key: string; title: string; detail: string | null; group: 'keep' | 'private' | 'shared'
  /** Null: it stays as it is. */
  plan: NetworkPlan | null
}

export function newServerNetworkChoices(places: ReadonlyMap<string, ServerPlace>, activeId: string | null, existing = false, pendingPrivate: readonly string[] = []): NewServerNetworkChoice[] {
  const holders = [...places.keys()].sort((a, b) => (a === activeId ? -1 : b === activeId ? 1 : 0))
  const seen = new Map<string, { network: NetworkEntity; hostServerId: string }>()
  for (const id of holders) for (const network of places.get(id)!.networks) if (!seen.has(network.id)) seen.set(network.id, { network, hostServerId: id })
  const known = (kind: 'private' | 'shared') => [...seen.values()]
    .filter(({ network }) => network.kind === kind)
    .sort((a, b) => a.network.name.localeCompare(b.network.name))
    .map(({ network, hostServerId }): NewServerNetworkChoice => ({
      key: network.id, title: network.name, detail: null, group: kind,
      plan: { kind: 'join', networkId: network.id, networkName: network.name, networkKind: network.kind, hostServerId },
    }))
  const takenNames = new Set([...seen.values()].map(({ network }) => network.name))
  const pending = pendingPrivate.filter((name) => !takenNames.has(name)).map((name): NewServerNetworkChoice => ({
    key: `pending:${name}`, title: name, detail: NETWORKS_COPY.pendingDetail, group: 'private', plan: { kind: 'new_private', name },
  }))
  const stay: NewServerNetworkChoice = existing
    ? { key: KEEP_CHOICE, title: NETWORKS_COPY.keepChoice, detail: NETWORKS_COPY.keepFooter, group: 'keep', plan: null }
    : { key: NO_NETWORK_CHOICE, title: NETWORKS_COPY.noneChoice, detail: NETWORKS_COPY.noneFooter, group: 'keep', plan: null }
  return [stay, ...known('private'), ...pending, ...known('shared')]
}

const KEEP_CHOICE = 'keep'
const NO_NETWORK_CHOICE = 'none'

/** What step 3 has picked before the person taps one: the open server's own network for a new server, as most new servers
 * join the person's other ones; otherwise staying as it is (or in no network). */
export function defaultNetworkChoiceKey(choices: readonly NewServerNetworkChoice[], openNetworks: readonly NetworkEntity[]): string | null {
  const home = openNetworks.find((network) => network.role === 'home')
  if (home && choices.some((choice) => choice.key === home.id && choice.plan !== null)) return home.id
  return choices.find((choice) => choice.plan === null)?.key ?? null
}
/** Where a new server can run, as the first step lists it: a cloud account or hosted, one to connect first, or one the
 * person already runs. */
export interface WhereChoice { key: string; title: string; detail: string; kind: 'make' | 'set_up' | 'existing'; route: IntegrationRoute | null }

export const EXISTING_SERVER = 'existing'

/** The hint under step 2: how to get the pairing link for a server already run; for one made on a provider, that
 * provider's own words on what it makes and how long it takes; for a hosted one, the plain wait. */
export function detailsHintOf(where: string, detail: string): string {
  if (where === EXISTING_SERVER) return NEW_SERVER_COPY.linkHint
  return where === 'hosted' ? NEW_SERVER_COPY.hint : NEW_SERVER_COPY.hintFor(detail)
}

/** What tapping a where-row does: on to step 2, or, for a provider not set up yet, to its integration's screen first (or
 * nothing, for one this app doesn't know how to set up). */
export type WhereAction = { kind: 'details' } | { kind: 'set_up'; route: IntegrationRoute } | { kind: 'none' }

export function whereActionOf(choice: WhereChoice): WhereAction {
  if (choice.kind !== 'set_up') return { kind: 'details' }
  return choice.route === null ? { kind: 'none' } : { kind: 'set_up', route: choice.route }
}

/** A server already run, as typed in step 2: the pairing link `ouro pair` prints, or its address and code, as the old
 * Pair form took them. Null: neither. */
export function existingServerTargetOf(typed: string): { url: string; code: string } | null {
  const fromLink = pairingTarget({ link: typed, address: '', code: '' })
  if (fromLink) return fromLink
  const [address, code, ...rest] = typed.trim().split(/\s+/)
  return address && code && rest.length === 0 ? pairingTarget({ link: '', address, code }) : null
}

export function whereChoices(providers: readonly MachineProvider[], hostedAvailable: boolean): WhereChoice[] {
  return [
    ...newServerChoices(providers, hostedAvailable).map((choice): WhereChoice => {
      switch (choice.kind) {
        case 'machine': return { key: choice.provider, title: choice.title, detail: choice.detail, kind: 'make', route: null }
        case 'set_up': return { key: choice.provider, title: providerName(choice.provider, providers), detail: choice.detail, kind: 'set_up', route: choice.route }
        case 'hosted': return { key: 'hosted', title: choice.title, detail: NEW_SERVER_COPY.hostedDetail, kind: 'make', route: null }
      }
    }),
    { key: EXISTING_SERVER, title: NEW_SERVER_COPY.existingChoice, detail: NEW_SERVER_COPY.existingDetail, kind: 'existing', route: null },
  ]
}

/** What starting a network from the open server does: make it there, or, for a private one when the open server is
 * already in a network, keep it on this phone until a new server is put in it. Null: a shared network can't be started
 * from a shared server, which can't hold another network's key as a visitor. */
export type NetworkStart =
  | { kind: 'here'; role: 'home' | 'extra' }
  | { kind: 'pending' }
  | { kind: 'refused'; why: string }

export function networkStartOf(kind: 'private' | 'shared', openNetworks: readonly NetworkEntity[]): NetworkStart {
  const home = openNetworks.find((network) => network.role === 'home') ?? null
  if (kind === 'private') return home === null ? { kind: 'here', role: 'home' } : { kind: 'pending' }
  if (home === null) return { kind: 'here', role: 'home' }
  return home.kind === 'private' ? { kind: 'here', role: 'extra' } : { kind: 'refused', why: NETWORKS_COPY.sharedFromShared }
}

/** A network's name as typed: trimmed, or why it won't do. Null while nothing is typed. */
export function networkNameOf(typed: string): { name: string } | { error: string } | null {
  const name = typed.trim()
  if (!name) return null
  return NETWORK_NAME_PATTERN.test(name) ? { name } : { error: NETWORKS_COPY.badName }
}

/**
 * How the open server joins a network from an invite, by the kind the person says it is: as its home when it has none;
 * into a shared network, from a private home, as a visitor holding an extra key. A private network is only ever a home,
 * and a shared server visits nowhere, so those are refused with what to do instead.
 */
export type JoinRole = { kind: 'join'; role: NetworkRole } | { kind: 'refused'; why: string }

export function joinRoleOf(kind: NetworkKind, openNetworks: readonly NetworkEntity[]): JoinRole {
  const home = openNetworks.find((network) => network.role === 'home') ?? null
  if (home === null) return { kind: 'join', role: 'home' }
  if (kind === 'private') return { kind: 'refused', why: NETWORKS_COPY.privateNeedsNewServer }
  return home.kind === 'private' ? { kind: 'join', role: 'extra' } : { kind: 'refused', why: NETWORKS_COPY.sharedFromShared }
}

/** The kinds the person picks from before joining, shared first: an invite from someone else is the usual case, and
 * taking a private network's key makes its owner and this server's one person, with each other's memory. */
export const JOIN_KINDS: readonly { kind: NetworkKind; title: string }[] = [
  { kind: 'shared', title: 'A shared network (with others)' },
  { kind: 'private', title: 'My own private network' },
]

/** How another saved server can join one of the open server's networks: as its home, or, into a shared network, holding the
 * key as an extra key so a private server can look, pull and push there. */
export interface JoinChoice { networkId: string; kind: NetworkKind; role: NetworkRole; title: string }

export function joinChoices(networks: readonly NetworkEntity[]): JoinChoice[] {
  return networks.flatMap((network): JoinChoice[] => network.kind === 'shared'
    ? [{ networkId: network.id, kind: 'shared', role: 'home', title: NETWORKS_COPY.joinShared(network.name) }, { networkId: network.id, kind: 'shared', role: 'extra', title: NETWORKS_COPY.visit(network.name) }]
    : [{ networkId: network.id, kind: 'private', role: 'home', title: NETWORKS_COPY.joinPrivate(network.name) }])
}

/** Whether a section is one network's (not "Not in a network", the one list before networks, or one only started): a
 * server removed from it still holds its key. */
export const isNetworkSection = (section: NetworkSection): boolean => section.key !== 'outside' && section.key !== 'all' && !section.key.startsWith('pending:')

/** A removal's or unlink's words, with the note that a server in a network still holds its key. */
export const withNetworkKeyNote = (message: string, inNetwork: boolean): string => inNetwork ? `${message} ${SERVERS_COPY.networkKeyNote}` : message

/** A network invite to send someone: the code and the server that takes it, how long it lasts (from its `expiresAt`), what
 * kind of network it is, and how to use it, in the app or on the server itself. */
export function inviteMessage(network: NetworkEntity, invite: { address: string; code: string; expiresAt: number; command: string }, now: number): string {
  const minutes = Math.max(1, Math.round((invite.expiresAt - now) / 60_000))
  const kind = network.kind === 'shared' ? 'shared' : 'private'
  return [
    `Join the ${kind} Ouro network "${network.name}" within ${minutes} minute${minutes === 1 ? '' : 's'} (the code works once).`,
    `Server: ${invite.address}`,
    `Code: ${invite.code}`,
    `In the Ouro app, open your server, tap Servers → ${NETWORKS_COPY.button} → ${NETWORKS_COPY.join}, paste this whole message, and choose ${kind === 'shared' ? 'a shared network' : 'my own private network'}.`,
    `Or on the server itself: ${invite.command} --kind ${kind}`,
  ].join('\n')
}

/** How a saved server still to be put in its network shows under its name. */
export function placementText(placement: { kind: 'placing'; plan: NetworkPlan } | { kind: 'failed'; plan: NetworkPlan; why: string }): string {
  const network = placement.plan.kind === 'join' ? placement.plan.networkName : placement.plan.name
  switch (placement.kind) {
    case 'placing': return NETWORKS_COPY.placing(network)
    case 'failed': return NETWORKS_COPY.notPlaced(network, placement.why)
  }
}

export const NETWORKS_COPY = {
  outside: 'Not in a network',
  button: 'Network…',
  start: 'Start a network…',
  startTitle: 'Start a network',
  namePlaceholder: 'e.g. work',
  privateKind: 'Private',
  privateKindDetail: 'Just your servers. They reach each other and share memory.',
  sharedKind: 'Shared',
  sharedKindDetail: 'For working with others. Your private servers can look in; nothing in it can reach them.',
  pendingDetail: 'New: starts with this server',
  pendingNote: 'Starts with the first server you put in it',
  sharedFromShared: 'Start a shared network from one of your private servers.',
  privateSection: 'Private',
  sharedSection: 'Shared',
  keepChoice: 'Leave it as it is',
  keepFooter: 'It stays in whatever network it is in now, if any.',
  noneChoice: 'No network',
  noneFooter: 'You can add it to one later from Servers.',
  privateNeedsNewServer: 'This server is in a network already, and a private network is only ever a server\'s home. Join it from a new server: New server, then pick it.',
  placing: (network: string) => `Joining ${network}…`,
  notPlaced: (network: string, why: string) => `Not in ${network} yet: ${why}`,
  retry: 'Retry',
  joinKindTitle: 'What kind of network is it?',
  badName: 'A network name is letters, digits, spaces, dots, dashes or underscores, up to 64, starting with a letter or digit.',
  empty: 'No servers yet',
  leftOut: (names: readonly string[]) => `Left out (they had limited trust): ${names.join(', ')}. Add or remove them by hand.`,
  invite: 'Invite',
  addTo: 'Add to a network',
  joinPrivate: (name: string) => `Join ${name}`,
  joinShared: (name: string) => `Make it a shared server in ${name}`,
  visit: (name: string) => `Hold ${name}'s key (a private server visiting)`,
  joinFailed: (label: string, why: string) => `Could not add ${label}: ${why}`,
  failed: (why: string) => `Could not do it: ${why}`,
  visiting: 'visiting',
  join: 'Join a network with an invite',
  joinTitle: 'Join a network',
  joinMessage: 'Paste the invite you were sent.',
  joinUnreadable: 'That invite has no server address and code in it. Paste the whole message you were sent.',
} as const

/** An invite as pasted: the whole shared message, `<address> <code>`, or `ouro networks join <address> <code>`. Null:
 * neither a server address nor a code is in it. */
export function parseInvite(text: string): { address: string; code: string } | null {
  const server = /Server:\s*(\S+)/i.exec(text)?.[1]
  const code = /Code:\s*(\S+)/i.exec(text)?.[1]
  if (server && code) return { address: server, code }
  const words = text.trim().split(/\s+/)
  const at = words.findIndex((word) => /^https?:\/\//.test(word))
  if (at >= 0 && words[at + 1]) return { address: words[at]!, code: words[at + 1]! }
  return null
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

const isSaved = (url: string, saved: readonly SavedServer[]) => saved.some((server) => sameServerUrl(server.url, url))

/** One of the account's servers that this phone isn't paired with: still being set up, failed, or ready to connect. */
export interface HostedRow { id: string; label: string; detail: string }

const STEP_TEXT: Record<ProvisioningStep, string> = {
  create: 'Creating…', upload: 'Copying Ouro…', install: 'Installing tools…',
  setup: 'Setting up agents…', service: 'Opening connection…', pair: 'Connecting…',
}

export function hostedRows(hosted: readonly HostedServer[], saved: readonly SavedServer[]): HostedRow[] {
  const savedIds = new Set(saved.map((server) => server.hostedServerId))
  // Paired before the phone kept hosted ids: known by its address instead.
  const unpaired = hosted.filter((server) => {
    if (savedIds.has(server.id)) return false
    return !(server.status.state === 'ready' && isSaved(server.status.address, saved))
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
  placeholder: 'e.g. Work',
  hint: 'A server takes a few minutes to set up. You can leave and come back.',
  /** The open server says what it makes and how long that takes (its provider's `detail`). */
  hintFor: (detail: string) => `${detail} You can leave and come back.`,
  failed: 'Could not create the server.',
  existingChoice: 'A server I already run',
  existingDetail: 'Pair it with the link it prints for ouro pair.',
  hostedDetail: 'Run by Ouro. Takes a few minutes.',
  whereTitle: 'Where will it run?',
  nameTitle: 'Name it',
  linkTitle: 'Pairing link',
  linkHint: 'On that server, run ouro pair and paste the link it prints, or its address and code.',
  networkTitle: 'Which network?',
  addExisting: 'Add',
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
  destroyElsewhereMessage: 'Its machine is deleted, with its agents and everything on it, for every phone paired with it. This can\'t be undone.',
  pairedElsewhere: 'Paired with another phone',
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

/**
 * A machine the open server made that isn't a server saved on this phone (one that is shows Destroy on its own row):
 * - `setting_up`: being made, failed, or ready for a phone to pair; tapping it carries on setting it up. Removable once
 *   settled, which destroys the machine.
 * - `paired_elsewhere`: a phone has paired with it, not this one (or this one forgot it). It offers only Destroy, so a
 *   machine no phone here can reach can still be stopped from billing.
 */
export type MachineRow =
  | { kind: 'setting_up'; id: string; label: string; detail: string; canRemove: boolean }
  | { kind: 'paired_elsewhere'; id: string; label: string; detail: string }

const providerName = (provider: string, providers: readonly MachineProvider[]) =>
  providers.find((candidate) => candidate.id === provider)?.name ?? provider

export function machineRows(machines: readonly NewMachine[], providers: readonly MachineProvider[], saved: readonly SavedServer[]): MachineRow[] {
  return machines
    .filter((machine) => !(machine.status.state === 'ready' && isSaved(machine.status.address, saved)))
    .map((machine): MachineRow => {
      const where = providerName(machine.provider, providers)
      return machine.paired
        ? { kind: 'paired_elsewhere', id: machine.id, label: machine.label, detail: `${where} · ${NEW_SERVER_COPY.pairedElsewhere}` }
        : { kind: 'setting_up', id: machine.id, label: machine.label, detail: `${where} · ${hostedDetail(machine.status)}`, canRemove: machine.status.state !== 'provisioning' }
    })
}

/** The machine the open server made for this saved server, paired or not, when it made one and it's ready: the one Destroy
 * removes. */
export function machineOfServer(url: string, machines: readonly NewMachine[]): NewMachine | null {
  return machines.find((machine) => machine.status.state === 'ready' && sameServerUrl(machine.status.address, url)) ?? null
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
  linkFailed: (label: string, why: string) => `Could not link ${label}: ${why}`,
  notOnPhone: 'Not on this phone',
  unlinkFailed: 'Could not unlink it.',
  trustFailed: 'Could not change its trust.',
  /** A server in a network still holds its key once removed or unlinked, and can come back with it. */
  networkKeyNote: 'It still holds the network\'s key, so it can come back: to keep it out for good, start a new network and move your other servers to it.',
  linkByCommand: 'Link a computer with a command',
} as const
