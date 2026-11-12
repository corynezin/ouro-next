// The person's other computers (each one's state, as Servers shows it), the words around linking one with a command, and
// Tailscale (where it comes before linking, and when it can be taken off). Pure: the screens only draw this.
import type { ComputerEntity, ComputerTrust, TailscaleState, TailscaleStatus } from '@ouro/contract'

export interface ComputerRow {
  id: string
  name: string
  stateText: string
  trust: ComputerTrust
  /** Why the two can't work together; null when they can. */
  incompatibility: string | null
}

/** "Online · 1 of 3 agents running". A computer reconnecting is still online: its agents keep showing. */
export function computerStateText(computer: ComputerEntity): string {
  const reachability = computer.status === 'offline' ? 'Offline' : 'Online'
  const agents = computer.agentCount ? ` · ${computer.agentsRunning ?? 0} of ${computer.agentCount} agents running` : ''
  return `${reachability}${agents}`
}

export function computerRows(computers: Iterable<ComputerEntity>): ComputerRow[] {
  return [...computers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((computer) => ({
      id: computer.id,
      name: computer.name,
      stateText: computerStateText(computer),
      trust: computer.trust,
      incompatibility: computer.incompatibility,
    }))
}

export const someOffline = (computers: Iterable<ComputerEntity>) => [...computers].some((computer) => computer.status === 'offline')

export function removeConfirm(computer: Pick<ComputerEntity, 'name' | 'agentsRunning'>): { title: string; message: string } {
  const running = computer.agentsRunning ?? 0
  return {
    title: `Remove ${computer.name}?`,
    message: running
      ? `${running} agents are running there. They keep running on it, but you won't see them here any more.`
      : 'Ouro stops reaching it. Nothing on the computer is deleted.',
  }
}

/** Whole minutes left, never under one: an invite shown is one that still works. */
export function inviteFooter(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  return `In Terminal on that computer, with Ouro installed. It works once, for the next ${minutes} minutes.`
}

// ---- Tailscale ----

/** What the "First, connect Tailscale" section offers while this server isn't on the person's Tailscale network. */
export type TailscaleGate =
  | { kind: 'connect' }
  | { kind: 'working'; text: string }
  | { kind: 'approve'; loginUrl: string }

/** Null once computers can be added: connected, or a server that doesn't need Tailscale. Until then the screen asks to
 * connect it first and offers no invite, as the reference: a hosted server reaches the computers over Tailscale. */
export function tailscaleGateOf(tailscale: TailscaleState): TailscaleGate | null {
  switch (tailscale.state) {
    case 'not_needed':
    case 'connected': return null
    case 'not_connected': return { kind: 'connect' }
    case 'installing': return { kind: 'working', text: 'Setting up Tailscale…' }
    case 'removing': return { kind: 'working', text: 'Removing Tailscale…' }
    case 'logging_in': return { kind: 'approve', loginUrl: tailscale.loginUrl }
  }
}

/** Whether adding a computer must wait for Tailscale: only on a server that reaches computers through it alone. */
export const tailscaleBlocksComputers = (status: TailscaleStatus) => status.neededForComputers && tailscaleGateOf(status.tailscale) !== null

/**
 * Where the Tailscale section goes. Where computers wait for it (a Sprite), it comes first; where it is optional (a server
 * with its own public address), after "Add a computer", so the screen leads with what the person came for.
 */
export type TailscalePlacement = 'before_add' | 'after_add'
export const tailscalePlacementOf = (status: TailscaleStatus): TailscalePlacement => (status.neededForComputers ? 'before_add' : 'after_add')

/**
 * Whether the screen offers to take a connected Tailscale off this server. Not while computers are linked over it: that
 * would cut them off. Where computers don't need it, it can always go.
 */
export const offersTailscaleRemove = (status: TailscaleStatus, linkedComputers: number) =>
  status.tailscale.state === 'connected' && (!status.neededForComputers || linkedComputers === 0)

/** The server moves through these by itself, so the screen asks again every 2 seconds while one lasts. */
export const isTailscaleChanging = (tailscale: TailscaleState) =>
  tailscale.state === 'installing' || tailscale.state === 'logging_in' || tailscale.state === 'removing'

export const TAILSCALE_POLL_MS = 2000

export const tailscaleConnectedFooter = (ip: string | null) => `Connected as ${ip ?? 'this server'}.`

export const TAILSCALE_COPY = {
  gateTitle: 'First, connect Tailscale',
  gateFooter: 'Install Tailscale on your computer and sign in first: https://tailscale.com/download. Then connect this server to the same account. It joins your Tailscale network, so its agents can reach your other devices on it. A separate Tailscale account just for Ouro keeps them apart. Keep this screen open until it says connected.',
  connect: 'Connect Tailscale',
  approve: 'Approve the login',
  connectedTitle: 'Tailscale',
  remove: 'Remove Tailscale from this server',
  removeTitle: 'Remove Tailscale?',
  removeMessage: 'This server leaves your Tailscale network.',
  requestFailed: 'Tailscale request failed.',
  open: 'Open Tailscale',
  notNeeded: "This server reaches your computers without Tailscale. Connect it only if its agents need your other devices on your Tailscale network.",
  optionalTitle: 'Tailscale',
  optionalFooter: 'This server reaches your computers without Tailscale. Connect it only if its agents need your other devices on your Tailscale network. Install Tailscale on one of your devices and sign in first: https://tailscale.com/download. Then connect this server to the same account. Keep this screen open until it says connected.',
} as const

export const COMPUTERS_COPY = {
  listTitle: 'Your computers',
  listFooter: 'When starting an agent, pick one under Machine.',
  addTitle: 'Link a computer',
  makeCommand: 'Make a command',
  tailscaleFirst: 'This server reaches computers over Tailscale: connect it first.',
  addFooter: 'Use your own Mac or Linux machine for agents. Anything an agent can do on it, your Ouro server can ask for: it has your files and your logins, as you have. Add only computers you trust that with. It must stay on and awake for agents to run there.',
  making: 'Making an invite…',
  inviteTitle: 'Paste this on the computer',
  trustTitle: 'Full trust',
  trustFooter: 'With full trust, it can do anything you or an agent can do here, and sees your agents in full. Without it, it can only send messages, and sees only names and whether each agent is running.',
  offlineNote: 'An offline computer comes back by itself when it wakes.',
  inviteFailed: 'Could not make an invite.',
  removeFailed: 'Could not remove it.',
} as const
