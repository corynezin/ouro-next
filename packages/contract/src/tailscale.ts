// Tailscale on this server: how a hosted server reaches the person's own computers. Set up only when the person asks,
// from the Computers screen, which follows it by asking again every 2 seconds while it is changing.
import { z } from 'zod'

/**
 * Where this server's Tailscale stands.
 * - `not_needed`: this server isn't one Ouro sets Tailscale up on (a person's own computer has its own network).
 * - `not_connected`: not installed, or installed but not signed in.
 * - `installing`: connecting has begun: installing if needed, then asking Tailscale for a login link.
 * - `logging_in`: waiting for the person to approve the login at `loginUrl`.
 * - `removing`: logging out and taking Tailscale off this server.
 * - `connected`: on the person's Tailscale network; `ip` is this server's IPv4 address there, null if Tailscale didn't say.
 */
export const TailscaleState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_needed') }),
  z.object({ state: z.literal('not_connected') }),
  z.object({ state: z.literal('installing') }),
  z.object({ state: z.literal('logging_in'), loginUrl: z.string() }),
  z.object({ state: z.literal('removing') }),
  z.object({ state: z.literal('connected'), ip: z.string().nullable() }),
])
export type TailscaleState = z.infer<typeof TailscaleState>

/** Why the last connect or remove failed, fit to show the person. Cleared when the next one starts. */
export const TailscaleFailure = z.object({ action: z.enum(['connect', 'remove']), message: z.string() })
export type TailscaleFailure = z.infer<typeof TailscaleFailure>

/** The answer to every `/v2/tailscale` request: GET reads it, POST starts connecting, DELETE starts removing. */
export const TailscaleStatus = z.object({ tailscale: TailscaleState, lastFailure: TailscaleFailure.nullable() })
export type TailscaleStatus = z.infer<typeof TailscaleStatus>
