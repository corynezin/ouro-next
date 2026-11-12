// The accounts this machine's agents use: Claude, ChatGPT, OpenRouter and GitHub. Each is an entity, `integration`, with
// the provider as its id, synced like any other. Signing in and setting keys are plain routes,
// `POST /v2/integrations/<provider>/<action>`, not commands: they carry secrets, which a command's idempotency record
// would keep.
import { z } from 'zod'

export const IntegrationProvider = z.enum(['claude', 'chatgpt', 'openrouter', 'github'])
export type IntegrationProvider = z.infer<typeof IntegrationProvider>

export const ClaudeAccount = z.discriminatedUnion('method', [
  /** A Claude subscription login, with its email when Claude Code says. `longLived`: a year-long plan token
   * (`claude setup-token`), made here or shared from another of the person's computers; it has no email. Absent from
   * servers before it. */
  z.object({ method: z.literal('plan'), email: z.string().nullable(), longLived: z.boolean().optional() }),
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

/** One of the person's other computers, as a shared Claude sign-in reached it. `why`: why it didn't, fit to show. */
export const ClaudeShareComputer = z.object({ name: z.string(), shared: z.boolean(), why: z.string().nullable() })
export type ClaudeShareComputer = z.infer<typeof ClaudeShareComputer>

/**
 * `POST /v2/integrations/claude/share/start` answers a ClaudeLoginStart: open `url`, approve, then send the code to
 * `share/finish`. That makes a year-long token for the Claude plan, signs this server in with it, and sends it to each of
 * the person's own computers in this server's private network. `POST claude/share/again` sends this server's token again,
 * without approving. `computers`: each one it was sent to, and whether it took it.
 */
export const ClaudeShareResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), integration: IntegrationEntity, computers: z.array(ClaudeShareComputer) }),
  z.object({ accepted: z.literal(false), why: z.string() }),
])
export type ClaudeShareResult = z.infer<typeof ClaudeShareResult>

/** `POST /v2/integrations/chatgpt/login/start`: open `url` and enter `code` there before `expiresAt`; the sign-in then
 * completes by itself and the integration changes. */
export const ChatgptLoginStart = z.object({ url: z.string(), code: z.string(), expiresAt: z.number().int() })
export type ChatgptLoginStart = z.infer<typeof ChatgptLoginStart>

/** The secret a route takes, by route. */
export const ClaudeLoginFinishBody = z.object({ code: z.string().min(1).max(2000) })
export const SecretKeyBody = z.object({ key: z.string().min(1).max(500) })
export const GithubTokenBody = z.object({ token: z.string().min(1).max(500) })

// ---- AWS ----
// AWS is not an `integration` entity: an app from before it would refuse a whole snapshot holding a provider it doesn't
// know. The app asks for it on its own route instead, `GET /v2/integrations/aws`, and sets or clears it with
// `POST aws/credentials` and `POST aws/disconnect`. The keys go to the AWS CLI's own files, as its default profile, so
// agents' `aws` commands and AWS SDKs use them.

export const AwsIntegrationState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_connected') }),
  /**
   * `accessKeyId`: the key's id, shortened to show (`AKIA…WXYZ`). `accountId` and `arn`: who AWS says the key is, null
   * when AWS couldn't be asked; `problem`: AWS refused the key, or couldn't be reached, fit to show.
   */
  z.object({
    status: z.literal('connected'), accessKeyId: z.string(), region: z.string().nullable(),
    accountId: z.string().nullable(), arn: z.string().nullable(), problem: z.string().nullable(),
  }),
])
export type AwsIntegrationState = z.infer<typeof AwsIntegrationState>

export const AwsActionResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), state: AwsIntegrationState }),
  z.object({ accepted: z.literal(false), why: z.string() }),
])
export type AwsActionResult = z.infer<typeof AwsActionResult>

/** An IAM user's long-lived access key (`AKIA…`), and the region agents work in by default. */
export const AwsCredentialsBody = z.object({
  accessKeyId: z.string().min(1).max(200),
  secretAccessKey: z.string().min(1).max(200),
  region: z.string().min(1).max(50),
})
export type AwsCredentialsBody = z.infer<typeof AwsCredentialsBody>
