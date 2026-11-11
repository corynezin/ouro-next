// Every refusal the API can answer with. The code is the contract; the message is for people.
import { z } from 'zod'

export const ErrorCode = z.enum([
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_request',
  'idempotency_conflict',
  'pairing_code_invalid',
  'agent_name_taken',
  'chat_name_taken',
  'agent_name_reserved',
  'agent_limit_reached',
  'budget_spent',
  'agent_archived',
  'agent_state_conflict',
  'empty_message',
  'not_a_member',
  'ask_closed',
  'goal_refused',
  'attachment_too_large',
  'host_hold_refused',
  'server_starting',
  'peer_unreachable',
  /** That computer's protocol and this server's don't overlap: one of them needs an update first. */
  'peer_incompatible',
  /** An account's provider or its tool didn't answer: nothing changed, and trying again may work. */
  'provider_unreachable',
  /** The base asked for isn't the one offered now. */
  'base_not_offered',
  /** A base update is already under way, or waiting on its conflicts. */
  'base_update_in_progress',
  /** There is no base update waiting on conflicts, or they aren't resolved and committed yet. */
  'base_conflict_unresolved',
  /** Backing up the source needs the connected GitHub account. */
  'github_not_connected',
  /** This machine has no copy of the source that takes bases, so there is nothing to back up. */
  'source_backup_not_applicable',
  /** The source has no backup to push to yet. */
  'no_source_backup',
  /** GitHub or git refused the push to the backup; the message says why. */
  'push_failed',
  /** This server isn't one Ouro sets Tailscale up on. */
  'tailscale_not_needed',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** The same command, with the same idempotency key, may succeed later. */
  retryable: z.boolean(),
})
export type ApiError = z.infer<typeof ApiError>

export const ErrorResponse = z.object({ error: ApiError })
export type ErrorResponse = z.infer<typeof ErrorResponse>

export const httpStatusOfError: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  idempotency_conflict: 409,
  pairing_code_invalid: 403,
  agent_name_taken: 409,
  chat_name_taken: 409,
  agent_name_reserved: 400,
  agent_limit_reached: 409,
  budget_spent: 409,
  agent_archived: 409,
  agent_state_conflict: 409,
  empty_message: 400,
  not_a_member: 403,
  ask_closed: 409,
  goal_refused: 409,
  attachment_too_large: 413,
  host_hold_refused: 503,
  server_starting: 503,
  peer_unreachable: 502,
  peer_incompatible: 409,
  provider_unreachable: 502,
  base_not_offered: 409,
  base_update_in_progress: 409,
  base_conflict_unresolved: 409,
  github_not_connected: 409,
  source_backup_not_applicable: 409,
  no_source_backup: 409,
  push_failed: 502,
  tailscale_not_needed: 409,
  internal: 500,
}
