// What Remove and Destroy do on the Servers screen, in order, apart from the screen: what to ask, and what follows what.
// Screen.tsx confirms with the person and shows the outcome.
import type { ServerRow } from './model.ts'

/**
 * What Remove asks. Only the open server's owner can unlink, and only a linked server has a link to undo: anyone else is
 * asked just to forget it on this phone.
 */
export type RemoveChoice = { kind: 'forget_only' } | { kind: 'forget_or_unlink'; computerId: string }

export function removeChoiceOf(row: ServerRow, isOwner: boolean): RemoveChoice {
  return row.link?.kind === 'linked' && isOwner ? { kind: 'forget_or_unlink', computerId: row.link.computerId } : { kind: 'forget_only' }
}

export interface ServerActionPorts {
  /** Destroys a machine the open server made; words for the failure, or null. */
  deleteMachine(machineId: string): Promise<string | null>
  /** Unlinks a computer from the open server; false when that failed (already said). */
  unlinkComputer(computerId: string): Promise<boolean>
  /** Forgets a saved server on this phone. */
  forget(serverId: string): Promise<void>
}

export type ActionOutcome = { kind: 'done' } | { kind: 'failed'; why: string } | { kind: 'kept' }

/** Unlinks first, so a server that can't be unlinked isn't forgotten while still linked. */
export async function removeAndUnlink(ports: ServerActionPorts, row: ServerRow, computerId: string): Promise<ActionOutcome> {
  if (!(await ports.unlinkComputer(computerId))) return { kind: 'kept' }
  await ports.forget(row.id)
  return { kind: 'done' }
}

/**
 * Destroys the machine made for a saved server, then unlinks it and forgets it here. The machine goes first: if that
 * fails the server stays, linked and saved, to try again. Once it is gone, unlinking is best-effort (nothing is left to
 * reach) and the server is forgotten all the same.
 */
export async function destroyServerMachine(ports: ServerActionPorts, row: ServerRow, machineId: string): Promise<ActionOutcome> {
  const why = await ports.deleteMachine(machineId)
  if (why !== null) return { kind: 'failed', why }
  if (row.link?.kind === 'linked') await ports.unlinkComputer(row.link.computerId).catch(() => false)
  await ports.forget(row.id)
  return { kind: 'done' }
}
