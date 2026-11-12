// Keeps each account's entity in step with its provider's own tool, and runs sign-ins, keys and tokens through them.
import type { ChatgptLoginStart, ClaudeLoginStart, IntegrationActionResult, IntegrationEntity, IntegrationProvider } from '@ouro/contract'
import { ProviderUnreachable } from '../adapters/integrations.ts'
import type { ActionOutcome, IntegrationTools } from '../adapters/integrations.ts'
import { CommandRefused } from './failure.ts'
import type { PlanAccount, PlanWindowReading } from '../domain/usage.ts'
import type { Store } from '../store/store.ts'

/** The accounts agents run on by signing in: Claude's for Claude Code, ChatGPT's for Codex. */
export type AgentAccount = 'claude' | 'chatgpt'

/** How often every account is checked: sign-ins and keys can change outside Ouro too. */
const CHECK_INTERVAL_MS = 10 * 60_000
/** While a ChatGPT sign-in waits for its code to be entered, how often to look. */
const PENDING_LOGIN_CHECK_MS = 3_000
/** How often a provider's usage is read again after turns on it: spend there isn't in a turn's own report. */
const USAGE_AFTER_TURN_INTERVAL_MS = 2 * 60_000

/** The providers whose usage is read after turns: the ChatGPT plan's windows, and the OpenRouter key's spend. */
export type UsageReadAfterTurn = 'chatgpt' | 'openrouter'

export interface IntegrationsConfig {
  store: Store
  tools: IntegrationTools
  now: () => number
  commit: (body: () => void) => void
  /** An account agents run on went from signed out to signed in: agents held for that can carry on. */
  accountSignedIn: (account: AgentAccount) => void
  /** A provider's state was stored; called after the transaction. */
  integrationStored: (provider: IntegrationProvider) => void
  /** A plan's windows were read; called inside a transaction. */
  planUsageRead: (account: PlanAccount, windows: PlanWindowReading[]) => void
  log: (event: string, fields: Record<string, unknown>) => void
}

/** A provider that can't be reached is the caller's retryable error; anything else is a bug and stays one. */
async function reaching<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ProviderUnreachable) throw new CommandRefused('provider_unreachable', error.message)
    throw error
  }
}

export class Integrations {
  private readonly config: IntegrationsConfig
  private lastFullCheckAt = 0
  private chatgptLoginPendingUntil = 0
  private lastPendingCheckAt = 0
  private checking: Promise<void> | null = null
  private readonly usageReadAt = new Map<UsageReadAfterTurn, number>()

  constructor(config: IntegrationsConfig) {
    this.config = config
  }

  /** From the server's tick. Checks run one at a time; a slow tool delays the next check, never piles them up. */
  tick(): void {
    if (this.checking) return
    const now = this.config.now()
    const due: IntegrationProvider[] = now - this.lastFullCheckAt >= CHECK_INTERVAL_MS
      ? ['claude', 'chatgpt', 'openrouter', 'github']
      : now < this.chatgptLoginPendingUntil && now - this.lastPendingCheckAt >= PENDING_LOGIN_CHECK_MS ? ['chatgpt'] : []
    if (due.length === 0) return
    if (due.length === 4) this.lastFullCheckAt = now
    if (due.includes('chatgpt')) this.lastPendingCheckAt = now
    this.checking = Promise.all(due.map((provider) => this.check(provider))).then(() => {}).finally(() => { this.checking = null })
  }

  /** Asks the provider's tool, and stores what it says. A tool that can't answer leaves the last state in place. */
  async check(provider: IntegrationProvider): Promise<IntegrationEntity | null> {
    let entity: IntegrationEntity
    try {
      entity = await this.observe(provider)
    } catch (error) {
      this.config.log('integration_check_failed', { provider, error: (error as Error).message })
      return this.config.store.integrationOf(provider)
    }
    const before = this.config.store.integrationOf(provider)
    this.config.commit(() => this.config.store.saveIntegration(entity))
    this.config.integrationStored(provider)
    if (entity.provider === 'chatgpt' && entity.state.status === 'signed_in') this.chatgptLoginPendingUntil = 0
    const signedIn = (entity.provider === 'claude' || entity.provider === 'chatgpt') && entity.state.status === 'signed_in' && before?.state.status !== 'signed_in'
    if (signedIn) this.config.accountSignedIn(entity.provider as AgentAccount)
    return entity
  }

  private async observe(provider: IntegrationProvider): Promise<IntegrationEntity> {
    const { tools } = this.config
    const checkedAt = this.config.now()
    switch (provider) {
      case 'claude': return { id: 'claude', provider, state: await tools.claudeStatus(), checkedAt }
      case 'chatgpt': return { id: 'chatgpt', provider, state: await tools.chatgptStatus(), checkedAt }
      case 'openrouter': return { id: 'openrouter', provider, state: await tools.openrouterStatus(), checkedAt }
      case 'github': return { id: 'github', provider, state: await tools.githubStatus(), checkedAt }
    }
  }

  /** After an action, the provider is asked again: the answer is what is now true, not what was hoped. */
  private async settle(provider: IntegrationProvider, outcome: ActionOutcome): Promise<IntegrationActionResult> {
    if (!outcome.accepted) return outcome
    const integration = await this.check(provider)
    if (!integration) return { accepted: false, why: `the ${provider} tool didn't answer after the change; check again shortly` }
    return { accepted: true, integration }
  }

  claudeLoginStart(): Promise<ClaudeLoginStart> {
    return reaching(() => this.config.tools.claudeLoginStart())
  }

  async claudeLoginFinish(code: string): Promise<IntegrationActionResult> {
    return this.settle('claude', await reaching(() => this.config.tools.claudeLoginFinish(code.trim())))
  }

  async claudeSetApiKey(key: string): Promise<IntegrationActionResult> {
    return this.settle('claude', await reaching(() => this.config.tools.claudeSetApiKey(key.trim())))
  }

  async claudeClearApiKey(): Promise<IntegrationActionResult> {
    await reaching(() => this.config.tools.claudeClearApiKey())
    return this.settle('claude', { accepted: true })
  }

  async chatgptLoginStart(): Promise<ChatgptLoginStart> {
    const started = await reaching(() => this.config.tools.chatgptLoginStart())
    this.chatgptLoginPendingUntil = started.expiresAt
    return started
  }

  async chatgptSignOut(): Promise<IntegrationActionResult> {
    this.chatgptLoginPendingUntil = 0
    await reaching(() => this.config.tools.chatgptSignOut())
    return this.settle('chatgpt', { accepted: true })
  }

  /** The OpenRouter key's spend and credits, asked for now; unlike a routine check, a provider that doesn't answer refuses. */
  async refreshOpenrouter(): Promise<void> {
    const entity = await reaching(() => this.observe('openrouter'))
    this.config.commit(() => this.config.store.saveIntegration(entity))
  }

  readChatgptPlanUsage(): Promise<PlanWindowReading[]> {
    return reaching(() => this.config.tools.chatgptPlanUsage())
  }

  /** After a turn on the provider: its usage is read again, unless it was read lately or is being read. */
  usedByTurn(provider: UsageReadAfterTurn): void {
    const now = this.config.now()
    if (now - (this.usageReadAt.get(provider) ?? -Infinity) < USAGE_AFTER_TURN_INTERVAL_MS) return
    this.usageReadAt.set(provider, now)
    const reading = provider === 'chatgpt'
      ? this.readChatgptPlanUsage().then((windows) => this.config.commit(() => this.config.planUsageRead('chatgpt', windows)))
      : this.check('openrouter')
    reading.catch((error: Error) => this.config.log('usage_read_failed', { provider, error: error.message }))
  }

  async openrouterSetKey(key: string): Promise<IntegrationActionResult> {
    return this.settle('openrouter', await reaching(() => this.config.tools.openrouterSetKey(key.trim())))
  }

  async openrouterClearKey(): Promise<IntegrationActionResult> {
    await reaching(() => this.config.tools.openrouterClearKey())
    return this.settle('openrouter', { accepted: true })
  }

  async githubSetToken(token: string): Promise<IntegrationActionResult> {
    return this.settle('github', await reaching(() => this.config.tools.githubSetToken(token.trim())))
  }

  async githubDisconnect(): Promise<IntegrationActionResult> {
    await reaching(() => this.config.tools.githubDisconnect())
    return this.settle('github', { accepted: true })
  }
}
