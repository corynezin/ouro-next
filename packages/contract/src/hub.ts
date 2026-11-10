// The hub: the hosted service that signs a person up with an invite and makes them computers of their own, each running
// an Ouro server that pairs with their phone. Plain JSON over HTTPS under `/hub/v1`, with the account's token as a bearer
// token. The hub holds no Claude credentials; a server, once ready, is talked to directly.
import { z } from 'zod'

export const HUB_API_PREFIX = '/hub/v1'

export const HubErrorCode = z.enum([
  'unauthenticated',
  'invalid_request',
  /** The invite doesn't exist, or was used already. */
  'invite_invalid',
  'not_found',
  /** Only accounts the hub's operator lets publish may publish or withdraw a base. */
  'not_publisher',
  /** The server can't be deleted: it is the account's primary one, or is still being made. */
  'server_not_deletable',
  /** The hub makes no more computers than its operator allows, and that many exist already. */
  'hub_full',
  'internal',
])
export type HubErrorCode = z.infer<typeof HubErrorCode>

/** `message` is fit to show the person as it is. */
export const HubError = z.object({ error: z.object({ code: HubErrorCode, message: z.string(), retryable: z.boolean() }) })
export type HubError = z.infer<typeof HubError>

export const httpStatusOfHubError: Record<HubErrorCode, number> = {
  unauthenticated: 401,
  invalid_request: 400,
  invite_invalid: 403,
  not_found: 404,
  not_publisher: 403,
  server_not_deletable: 409,
  hub_full: 503,
  internal: 500,
}

export const SignupRequest = z.object({ invite: z.string().trim().min(1), name: z.string().trim().min(1).max(60) })
export type SignupRequest = z.infer<typeof SignupRequest>

/** Keep `token` in secure storage: it is the account. The hub's first server for the account is being made already. */
export const SignupResult = z.object({ accountId: z.string(), token: z.string(), name: z.string() })
export type SignupResult = z.infer<typeof SignupResult>

/** Making a computer, in order. The app shows each with its own words and progress. */
export const ProvisioningStep = z.enum(['create', 'upload', 'install', 'setup', 'service', 'pair'])
export type ProvisioningStep = z.infer<typeof ProvisioningStep>

/** A ready server's one-time pairing code for the phone that asked for it. Null: a phone has paired with it already. */
export const HostedServerPairing = z.object({ code: z.string(), expiresAt: z.number().int() }).nullable()
export type HostedServerPairing = z.infer<typeof HostedServerPairing>

export const HostedServerState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('provisioning'), step: ProvisioningStep }),
  /** `address`: the server's app API, as a pairing takes it. */
  z.object({ state: z.literal('ready'), address: z.string(), pairing: HostedServerPairing }),
  /** `why` is fit to show. Making it again is a new server. */
  z.object({ state: z.literal('failed'), why: z.string() }),
])
export type HostedServerState = z.infer<typeof HostedServerState>

export const HostedServer = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number().int(),
  /** Made at sign-up; listed first. */
  primary: z.boolean(),
  status: HostedServerState,
})
export type HostedServer = z.infer<typeof HostedServer>

/** GET /servers: the account's servers, its primary first. */
export const HostedServerList = z.object({ servers: z.array(HostedServer) })
export type HostedServerList = z.infer<typeof HostedServerList>

/** POST /servers: another server; it starts provisioning at once. */
export const CreateHostedServerRequest = z.object({ label: z.string().trim().min(1).max(60) })
export type CreateHostedServerRequest = z.infer<typeof CreateHostedServerRequest>

/**
 * A base: a numbered release of Ouro with notes. Numbers only rise. `treeHash` is the git tree of its files exactly as
 * they are, ignore rules aside, so it depends only on their content; a taker uses a base only if its files hash to it.
 */
export const HubBase = z.object({
  n: z.number().int().min(1),
  notes: z.string().max(20_000),
  treeHash: z.string().regex(/^[0-9a-f]{40}$/),
})
export type HubBase = z.infer<typeof HubBase>

/**
 * POST /bases: the next base, from its files as a tar, base64 encoded. The hub refuses files that don't hash to
 * `treeHash`. Files that hash to the newest base's tree make nothing new.
 */
export const PublishBaseRequest = z.object({ notes: HubBase.shape.notes, treeHash: HubBase.shape.treeHash, filesTarBase64: z.string().min(1) })
export type PublishBaseRequest = z.infer<typeof PublishBaseRequest>

/** `alreadyPublished`: the newest base still offered had these files already; it is that base, with its own notes. */
export const PublishBaseResult = z.object({ base: HubBase, alreadyPublished: z.boolean() })
export type PublishBaseResult = z.infer<typeof PublishBaseResult>

/** POST /bases/<n>/withdraw: no longer offered as the latest. Its files stay, so an update under way can finish. */
export const WithdrawBaseResult = z.object({ base: HubBase })
export type WithdrawBaseResult = z.infer<typeof WithdrawBaseResult>

/** The routes, relative to `HUB_API_PREFIX`, and what each answers. Sign-up and reading bases need no token; the rest need the account's. */
export const HUB_ROUTES = {
  signup: { method: 'POST', path: '/signup', request: SignupRequest, response: SignupResult },
  listServers: { method: 'GET', path: '/servers', request: null, response: HostedServerList },
  createServer: { method: 'POST', path: '/servers', request: CreateHostedServerRequest, response: HostedServer },
  /** `/servers/<id>`: poll this while it provisions. */
  getServer: { method: 'GET', path: '/servers/:id', request: null, response: HostedServer },
  /** Anyone may read bases: they are what every person's computer is made from. 204 when none is offered. */
  latestBase: { method: 'GET', path: '/bases/latest', request: null, response: HubBase },
  /** `/bases/<n>/files`: the base's files as a tar, withdrawn or not. */
  baseFiles: { method: 'GET', path: '/bases/:n/files', request: null, response: null },
  /** Publisher accounts only. */
  publishBase: { method: 'POST', path: '/bases', request: PublishBaseRequest, response: PublishBaseResult },
  /** Publisher accounts only; safe to repeat. */
  withdrawBase: { method: 'POST', path: '/bases/:n/withdraw', request: null, response: WithdrawBaseResult },
} as const
