// The accounts this machine's agents use: Claude, ChatGPT, OpenRouter and GitHub. Each is an entity, `integration`, with
// the provider as its id, synced like any other. Signing in and setting keys are plain routes,
// `POST /v2/integrations/<provider>/<action>`, not commands: they carry secrets, which a command's idempotency record
// would keep.
import { z } from 'zod'

export const IntegrationProvider = z.enum(['claude', 'chatgpt', 'openrouter', 'github'])
export type IntegrationProvider = z.infer<typeof IntegrationProvider>

export const ClaudeAccount = z.discriminatedUnion('method', [
  /** A Claude subscription login, with its email when Claude Code says. */
  z.object({ method: z.literal('plan'), email: z.string().nullable() }),
  /** An Anthropic API key. */
  z.object({ method: z.literal('api_key') }),
])
export type ClaudeAccount = z.infer<typeof ClaudeAccount>

export const ClaudeIntegrationState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_out') }),
  z.object({ status: z.literal('signed_in'), account: ClaudeAccount }),
])
export type ClaudeIntegrationState = z.infer<typeof ClaudeIntegrationState>

export const ChatgptIntegrationState = z.discriminatedUnion('status', [
  /** The Codex command line isn't on this machine. */
  z.object({ status: z.literal('not_installed') }),
  z.object({ status: z.literal('signed_out') }),
  /** `models`: what this plan may run, as Codex lists them; agents can be given any of them. */
  z.object({ status: z.literal('signed_in'), email: z.string().nullable(), plan: z.string().nullable(), models: z.array(z.string()) }),
])
export type ChatgptIntegrationState = z.infer<typeof ChatgptIntegrationState>

export const OpenrouterIntegrationState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured') }),
  /**
   * As OpenRouter last said: what the key has spent, and what it may still spend: the lesser of what's left of its own
   * limit and the account's credits. Null: OpenRouter didn't answer.
   */
  z.object({ status: z.literal('configured'), spentUsd: z.number().nullable(), availableUsd: z.number().nullable() }),
])
export type OpenrouterIntegrationState = z.infer<typeof OpenrouterIntegrationState>

export const GithubIntegrationState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_connected') }),
  z.object({ status: z.literal('connected'), user: z.string().nullable(), scopes: z.array(z.string()) }),
])
export type GithubIntegrationState = z.infer<typeof GithubIntegrationState>

/** `checkedAt`: when the server last asked the provider's own tool. */
export const IntegrationEntity = z.discriminatedUnion('provider', [
  z.object({ id: z.literal('claude'), provider: z.literal('claude'), state: ClaudeIntegrationState, checkedAt: z.number().int() }),
  z.object({ id: z.literal('chatgpt'), provider: z.literal('chatgpt'), state: ChatgptIntegrationState, checkedAt: z.number().int() }),
  z.object({ id: z.literal('openrouter'), provider: z.literal('openrouter'), state: OpenrouterIntegrationState, checkedAt: z.number().int() }),
  z.object({ id: z.literal('github'), provider: z.literal('github'), state: GithubIntegrationState, checkedAt: z.number().int() }),
])
export type IntegrationEntity = z.infer<typeof IntegrationEntity>

/** What a sign-in, key or token route answers. `why`: the provider's refusal, fit to show. */
export const IntegrationActionResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), integration: IntegrationEntity }),
  z.object({ accepted: z.literal(false), why: z.string() }),
])
export type IntegrationActionResult = z.infer<typeof IntegrationActionResult>

/** `POST /v2/integrations/claude/login/start`: open `url`, approve, then send the code it shows to `login/finish`. */
export const ClaudeLoginStart = z.object({ url: z.string() })
export type ClaudeLoginStart = z.infer<typeof ClaudeLoginStart>

/** `POST /v2/integrations/chatgpt/login/start`: open `url` and enter `code` there before `expiresAt`; the sign-in then
 * completes by itself and the integration changes. */
export const ChatgptLoginStart = z.object({ url: z.string(), code: z.string(), expiresAt: z.number().int() })
export type ChatgptLoginStart = z.infer<typeof ChatgptLoginStart>

/** The secret a route takes, by route. */
export const ClaudeLoginFinishBody = z.object({ code: z.string().min(1).max(2000) })
export const SecretKeyBody = z.object({ key: z.string().min(1).max(500) })
export const GithubTokenBody = z.object({ token: z.string().min(1).max(500) })
