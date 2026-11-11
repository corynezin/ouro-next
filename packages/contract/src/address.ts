// Who a message is from or to, as text: `alice`, `alice@mac`, `human` (this machine's owner), `human@sam`.
// The rest of the contract treats an address as opaque; this is the one place that gives it structure.
import { z } from 'zod'

export const Address = z.string().min(1).max(200)
export type Address = z.infer<typeof Address>

export const OWNER_ADDRESS = 'human'

export type ParsedAddress =
  | { kind: 'owner' }
  | { kind: 'person'; person: string }
  | { kind: 'agent'; agentName: string; machine: string | null }

export function parseAddress(address: Address): ParsedAddress {
  if (address === OWNER_ADDRESS) return { kind: 'owner' }
  const separatorIndex = address.indexOf('@')
  if (separatorIndex < 0) return { kind: 'agent', agentName: address, machine: null }
  const local = address.slice(0, separatorIndex)
  const domain = address.slice(separatorIndex + 1)
  if (local === OWNER_ADDRESS) return { kind: 'person', person: domain }
  return { kind: 'agent', agentName: local, machine: domain }
}

export const personAddress = (person: string): Address => `${OWNER_ADDRESS}@${person}`

export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const RESERVED_AGENT_NAMES: readonly string[] = [OWNER_ADDRESS, 'system', 'all', 'everyone']
