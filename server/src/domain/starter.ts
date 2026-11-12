// The starter agent: the one Ouro makes, pins and greets the owner with when they first pair. Which agent that is. Pure.

/**
 * What first pairing does about the starter agent. `adopt_legacy`: a machine from before pins has a `master`, the old
 * front door (a reserved name, so only Ouro made it): it becomes the starter, keeping its name and conversation.
 * `keep_archived`: the person archived their master, so they get no new front door. `make`: a new starter agent.
 * `none`: it was settled before, once; after that an archived or renamed starter is the person's choice.
 */
export type StarterDecision =
  | { kind: 'none' }
  | { kind: 'adopt_legacy'; agentId: string }
  | { kind: 'keep_archived' }
  | { kind: 'make' }

export function starterDecision(facts: { settledBefore: boolean; activeLegacyId: string | null; archivedLegacy: boolean }): StarterDecision {
  if (facts.settledBefore) return { kind: 'none' }
  if (facts.activeLegacyId !== null) return { kind: 'adopt_legacy', agentId: facts.activeLegacyId }
  if (facts.archivedLegacy) return { kind: 'keep_archived' }
  return { kind: 'make' }
}
