// The accounts this server's agents use, as the screens show them. Each reads its provider's `integration` entity, which
// is absent until the server has first asked that provider's tool. Pure.
import type {
  AwsActionResult, AwsIntegrationState, SpritesActionResult, SpritesIntegrationState, ChatgptIntegrationState, ClaudeIntegrationState, GithubIntegrationState, IntegrationActionResult, IntegrationEntity,
  OpenrouterIntegrationState, PlanUsage, PlanWindow,
} from '@ouro/contract'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { failureText } from '../../core/session/serverApi.ts'
import { dateTimeOf, money } from '../../design/format.ts'

export const CHECKING_TEXT = 'Checking…'

/** What a sign-in, key or token route came to: the provider took it, or the words for why not. */
export type ActionOutcome = { kind: 'accepted'; integration: IntegrationEntity } | { kind: 'failed'; text: string }

/** `refusedText`: what to say when the provider turned the secret down, in the reference's words. */
export function actionOutcome(result: ApiResult<IntegrationActionResult>, refusedText: string): ActionOutcome {
  if (!result.ok) return { kind: 'failed', text: failureText(result.failure) }
  if (!result.value.accepted) return { kind: 'failed', text: refusedText }
  return { kind: 'accepted', integration: result.value.integration }
}

/** A pasted key, code or token, or nothing to send. */
export const pasted = (text: string) => text.trim() || null

// ---- Claude Code ----

export function claudeStatusText(claude: ClaudeIntegrationState | null) {
  if (!claude) return CHECKING_TEXT
  if (claude.status === 'signed_out') return 'Not signed in'
  if (claude.account.method === 'api_key') return 'Signed in with an API key'
  return `Signed in${claude.account.email ? ` as ${claude.account.email}` : ''}`
}

export const claudeButtonLabel = (claude: ClaudeIntegrationState) =>
  claude.status === 'signed_in' ? 'Sign in again or use an API key' : 'Sign in to Claude Code'

/** Connect Claude: Anthropic's login with a code, an Anthropic API key, or OpenRouter instead. */
export type ConnectMode = 'login' | 'api_key' | 'openrouter'
export const CONNECT_COPY = {
  title: 'Sign in to Claude Code on your computer',
  codeRefused: 'Anthropic did not accept that code. Open the login page again for a new one.',
  keyRefused: 'That API key was not accepted.',
  openRouterRefused: 'OpenRouter did not accept that key.',
} as const

// ---- ChatGPT ----

export type ChatgptSection = 'checking' | 'not_installed' | 'connected' | 'enter_code' | 'sign_in'
export function chatgptSection(chatgpt: ChatgptIntegrationState | null, codeShown: boolean): ChatgptSection {
  if (!chatgpt) return 'checking'
  if (chatgpt.status === 'not_installed') return 'not_installed'
  if (chatgpt.status === 'signed_in') return 'connected'
  return codeShown ? 'enter_code' : 'sign_in'
}

export function usageWindowLabel(window: PlanWindow) {
  const minutes = window.windowMinutes
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

/** A window whose reset has passed is read as unused until a newer reading comes. */
export function usageWindowValue(window: PlanWindow, now: number) {
  if (window.resetsAt !== null && window.resetsAt <= now) return '0% used'
  const reset = window.resetsAt !== null ? ` · resets ${dateTimeOf(window.resetsAt)}` : ''
  return `${Math.round(window.usedFraction * 100)}% used${reset}`
}

/** The usage section's footer: still asking, when the server last read it, or nothing to show. */
export function usageFooter(usage: PlanUsage | null, refreshing: boolean) {
  if (refreshing) return 'Checking usage…'
  if (usage) return `Last updated ${dateTimeOf(usage.observedAt)}. Usage is shared across Codex on your ChatGPT plan.`
  return 'Usage is not available yet.'
}

/** The Connected section's account: Codex may not say which. */
export const chatgptAccountText = (chatgpt: { email: string | null }) => chatgpt.email ?? 'Signed in'

/** The usage rows: "Checking…" while the first reading is on its way, then the two shortest windows. */
export function usageRows(usage: PlanUsage | null, refreshing: boolean, now: number): { key: string; label: string; value: string }[] {
  if (!usage) return refreshing ? [{ key: 'checking', label: 'Usage', value: CHECKING_TEXT }] : []
  return usage.windows.slice(0, 2).map((window) => ({ key: String(window.windowMinutes), label: usageWindowLabel(window), value: usageWindowValue(window, now) }))
}

// ---- OpenRouter ----

export function openRouterSpentText(openrouter: OpenrouterIntegrationState) {
  if (openrouter.status !== 'configured' || openrouter.spentUsd === null) return null
  return `${money(openrouter.spentUsd)}${openrouter.availableUsd !== null ? `, ${money(openrouter.availableUsd)} left` : ''}`
}

/** Settings' "OpenRouter credits": what the key spent, of what it may spend in all. Null until OpenRouter has said (SET-15). */
export function openRouterCreditsText(openrouter: OpenrouterIntegrationState | null): string | null {
  if (openrouter?.status !== 'configured' || openrouter.spentUsd === null) return null
  const total = openrouter.availableUsd === null ? null : openrouter.spentUsd + openrouter.availableUsd
  return `${money(openrouter.spentUsd)}${total === null ? '' : ` of ${money(total)}`}`
}

export const OPENROUTER_CREDITS_FOOTER = 'What this OpenRouter key has spent, and what is left of its limit (the model provider for agents using the deepseek, haiku, qwen-coder, and gemini-flash aliases).'

/** Removing the key: refused in the server's words, as the reference (INT-18). */
export function keyRemovalOutcome(result: ApiResult<IntegrationActionResult>): ActionOutcome {
  if (result.ok && !result.value.accepted) return { kind: 'failed', text: result.value.why.trim() || KEY_REMOVAL_FAILED }
  return actionOutcome(result, KEY_REMOVAL_FAILED)
}
export const KEY_REMOVAL_FAILED = 'Could not remove the key.'

// ---- GitHub ----

/** GitHub's token page with the scopes agents need already ticked. */
export const GITHUB_TOKEN_PAGE = `https://github.com/settings/tokens/new?description=${encodeURIComponent('Ouro agents')}&scopes=repo,gist,read:org,workflow`

const NEEDED_GITHUB_SCOPES = ['repo', 'workflow'] as const

export function gitHubMissingScopesNote(github: GithubIntegrationState) {
  if (github.status !== 'connected') return null
  const missing = NEEDED_GITHUB_SCOPES.filter((scope) => !github.scopes.includes(scope))
  return missing.length ? `Missing scopes: ${missing.join(', ')}. Create a new token with these scopes for full agent access.` : null
}

export const gitHubName = (github: GithubIntegrationState) => (github.status === 'connected' && github.user ? github.user : 'GitHub')
export const gitHubConnectedToast = (github: GithubIntegrationState) =>
  github.status === 'connected' && github.user ? `Connected as ${github.user}` : 'Connected to GitHub'

// ---- AWS ----

/** Where an IAM user and its access key are made. */
export const AWS_IAM_USERS_PAGE = 'https://console.aws.amazon.com/iam/home#/users'
export const AWS_DEFAULT_REGION = 'us-east-1'

export type AwsOutcome = { kind: 'accepted'; state: AwsIntegrationState } | { kind: 'failed'; text: string }

/** AWS refusing the key is said in the server's words: they say which part was wrong. */
export function awsOutcome(result: ApiResult<AwsActionResult>, refusedText: string): AwsOutcome {
  if (!result.ok) return { kind: 'failed', text: failureText(result.failure) }
  if (!result.value.accepted) return { kind: 'failed', text: result.value.why.trim() || refusedText }
  return { kind: 'accepted', state: result.value.state }
}

/** The account's number, or the key's when AWS couldn't say. */
export const awsName = (aws: AwsIntegrationState) =>
  aws.status !== 'connected' ? 'AWS' : aws.accountId !== null ? `AWS account ${aws.accountId}` : `AWS key ${aws.accessKeyId}`

/** The IAM identity's own name, the last part of its ARN (`user/agents` → `agents`). */
export const awsIdentityText = (arn: string | null) => (arn === null ? null : arn.split(':').pop()!.split('/').pop() ?? arn)

/** What the screen needs to send: all three, trimmed, or null while one is missing. */
export function awsCredentialsOf(accessKeyId: string, secretAccessKey: string, region: string) {
  const values = { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), region: region.trim().toLowerCase() }
  return values.accessKeyId && values.secretAccessKey && values.region ? values : null
}

// ---- Sprites ----

/** Fly.io's sign-in: Sprites tokens are made in the Fly.io dashboard, under the person's organization, whose address this
 * app doesn't know. From there: Sprites → Tokens. */
export const SPRITES_TOKENS_PAGE = 'https://fly.io/app/sign-in'

export type SpritesOutcome = { kind: 'accepted'; state: SpritesIntegrationState } | { kind: 'failed'; text: string }

/** The Sprites API refusing the token is said in the server's words. */
export function spritesOutcome(result: ApiResult<SpritesActionResult>, refusedText: string): SpritesOutcome {
  if (!result.ok) return { kind: 'failed', text: failureText(result.failure) }
  if (!result.value.accepted) return { kind: 'failed', text: result.value.why.trim() || refusedText }
  return { kind: 'accepted', state: result.value.state }
}

/** What the screen sends: the token without the spaces or line breaks a paste brings, or null while there is none. */
export function spritesTokenOf(typed: string): string | null {
  const token = typed.replace(/\s+/g, '')
  return token || null
}
