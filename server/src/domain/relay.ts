// `ouro relay`: an agent passing its person's own words to another agent, as theirs. Pure.
import { parseAddress } from '@ouro/contract'
import type { Address } from '@ouro/contract'

export type RelayDecision = { kind: 'allowed'; person: Address } | { kind: 'refused'; why: string }

/**
 * Only an agent whose parent is a person relays: it was started by them and answers to them, so the words it carries
 * reached it straight from them. A helper an agent started reads what its parent hands it, which may come from anywhere
 * (a web page, an issue), so its words can't stand as the person's. The words are the parent's.
 */
export function relayDecision(relayer: { parent: Address }): RelayDecision {
  const parent = parseAddress(relayer.parent)
  switch (parent.kind) {
    case 'owner':
    case 'person': return { kind: 'allowed', person: relayer.parent }
    case 'agent': return { kind: 'refused', why: `only an agent a person started relays their words; you report to ${relayer.parent}` }
  }
}
