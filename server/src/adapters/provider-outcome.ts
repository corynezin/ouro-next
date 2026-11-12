// What the accounts' tools answer, shared by every provider's adapter. A leaf: it imports nothing, so the adapters that
// use it never import each other for it.

/** A provider's answer to a code, key or token. `why`: its refusal, fit to show the person. */
export type ActionOutcome = { accepted: true } | { accepted: false; why: string }

/** The provider or its tool couldn't be reached: nothing changed, and trying again may work. */
export class ProviderUnreachable extends Error {}
