// The accounts port: each provider's own tool asked what is true, and told to sign in or out. The server stores only what
// it last saw; the truth stays in the tools' own files (~/.claude, ~/.codex, gh's config) and the keys the server keeps.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AwsIntegrationState, ChatgptIntegrationState, ChatgptLoginStart, ClaudeIntegrationState, ClaudeLoginStart, GithubIntegrationState, OpenrouterIntegrationState,
} from '@ouro/contract'
import type { PlanWindowReading } from '../domain/usage.ts'
import type { AwsTools } from './aws.ts'
import { shortKeyId } from './aws.ts'

/** A provider's answer to a code, key or token. `why`: its refusal, fit to show the person. */
export type ActionOutcome = { accepted: true } | { accepted: false; why: string }

/** The provider or its tool couldn't be reached: nothing changed, and trying again may work. */
export class ProviderUnreachable extends Error {}

/** What the stand-in's ChatGPT plan may run. */
export const STAND_IN_CHATGPT_MODELS = ['gpt-6-luna', 'gpt-6.1-sol'] as const

export interface IntegrationTools extends AwsTools {
  claudeStatus(): Promise<ClaudeIntegrationState>
  claudeLoginStart(): Promise<ClaudeLoginStart>
  claudeLoginFinish(code: string): Promise<ActionOutcome>
  claudeSetApiKey(key: string): Promise<ActionOutcome>
  claudeClearApiKey(): Promise<void>
  chatgptStatus(): Promise<ChatgptIntegrationState>
  chatgptLoginStart(): Promise<ChatgptLoginStart>
  chatgptSignOut(): Promise<void>
  /** The ChatGPT plan's usage windows, as Codex reads them now. */
  chatgptPlanUsage(): Promise<PlanWindowReading[]>
  openrouterStatus(): Promise<OpenrouterIntegrationState>
  openrouterSetKey(key: string): Promise<ActionOutcome>
  openrouterClearKey(): Promise<void>
  githubStatus(): Promise<GithubIntegrationState>
  githubSetToken(token: string): Promise<ActionOutcome>
  /** The connected account's token, for GitHub's API; null when GitHub isn't connected. Never logged. */
  githubToken(): Promise<string | null>
  githubDisconnect(): Promise<void>
}

interface StandInState {
  claude: ClaudeIntegrationState
  claudeLoginStarted: boolean
  chatgpt: ChatgptIntegrationState
  chatgptPendingCode: string | null
  openrouter: OpenrouterIntegrationState
  github: GithubIntegrationState
  /** Absent in a state file from before AWS. */
  aws?: AwsIntegrationState
}

/**
 * For journeys: accounts as files in `dir`. A code, key or token is accepted when it is a line of `dir/accepted`. A
 * ChatGPT sign-in completes once `dir/chatgpt-entered` holds its code, as if the person had entered it at OpenAI. The
 * ChatGPT plan's windows are what `dir/chatgpt-usage.json` holds, if anything; a configured OpenRouter key's spend and
 * credits, what `dir/openrouter-credits.json` holds, once it does. AWS keys are accepted when the secret is a line of
 * `dir/accepted`, and then belong to account 123456789012.
 */
export function standInIntegrationTools(dir: string, keyFiles: { openrouter: string }): IntegrationTools {
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  const read = (): StandInState => existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8')) as StandInState
    // Signed in, like a machine in use: a stand-in agent runs until a journey signs Claude out.
    : { claude: { status: 'signed_in', account: { method: 'plan', email: 'person@stand-in.invalid' } }, claudeLoginStarted: false, chatgpt: { status: 'signed_out' }, chatgptPendingCode: null, openrouter: { status: 'not_configured' }, github: { status: 'not_connected' } }
  const write = (state: StandInState) => writeFileSync(statePath, JSON.stringify(state))
  const update = (change: (state: StandInState) => void) => {
    const state = read()
    change(state)
    write(state)
  }
  const accepts = (secret: string) => (existsSync(join(dir, 'accepted')) ? readFileSync(join(dir, 'accepted'), 'utf8').split('\n') : []).includes(secret)
  const refused: ActionOutcome = { accepted: false, why: 'the stand-in refused it' }
  const accepted: ActionOutcome = { accepted: true }

  return {
    claudeStatus: async () => read().claude,
    claudeLoginStart: async () => {
      update((state) => { state.claudeLoginStarted = true })
      return { url: 'https://stand-in.invalid/claude/authorize' }
    },
    claudeLoginFinish: async (code) => {
      if (!read().claudeLoginStarted) return { accepted: false, why: 'no sign-in in progress: start it first' }
      if (!accepts(code)) return refused
      update((state) => {
        state.claude = { status: 'signed_in', account: { method: 'plan', email: 'person@stand-in.invalid' } }
        state.claudeLoginStarted = false
      })
      return accepted
    },
    claudeSetApiKey: async (key) => {
      if (!accepts(key)) return refused
      update((state) => { state.claude = { status: 'signed_in', account: { method: 'api_key' } } })
      return accepted
    },
    claudeClearApiKey: async () => update((state) => { state.claude = { status: 'signed_out' } }),
    chatgptStatus: async () => {
      const state = read()
      const enteredPath = join(dir, 'chatgpt-entered')
      if (state.chatgptPendingCode !== null && existsSync(enteredPath) && readFileSync(enteredPath, 'utf8').trim() === state.chatgptPendingCode) {
        update((next) => {
          next.chatgpt = { status: 'signed_in', email: 'person@stand-in.invalid', plan: 'plus', models: [...STAND_IN_CHATGPT_MODELS] }
          next.chatgptPendingCode = null
        })
        return read().chatgpt
      }
      return state.chatgpt
    },
    chatgptLoginStart: async () => {
      const code = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase()
      update((state) => { state.chatgptPendingCode = code })
      return { url: 'https://stand-in.invalid/chatgpt/device', code, expiresAt: Date.now() + 15 * 60_000 }
    },
    chatgptSignOut: async () => update((state) => { state.chatgpt = { status: 'signed_out' } }),
    chatgptPlanUsage: async () => {
      const usagePath = join(dir, 'chatgpt-usage.json')
      return existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, 'utf8')) as PlanWindowReading[] : []
    },
    openrouterStatus: async () => {
      const { openrouter } = read()
      const creditsPath = join(dir, 'openrouter-credits.json')
      if (openrouter.status !== 'configured' || !existsSync(creditsPath)) return openrouter
      return { status: 'configured', ...JSON.parse(readFileSync(creditsPath, 'utf8')) as { spentUsd: number | null; availableUsd: number | null } }
    },
    openrouterSetKey: async (key) => {
      if (!accepts(key)) return refused
      // Where the real tools keep it, so agents launched on OpenRouter models get it the same way.
      mkdirSync(dirname(keyFiles.openrouter), { recursive: true })
      writeFileSync(keyFiles.openrouter, `${key}\n`, { mode: 0o600 })
      update((state) => { state.openrouter = { status: 'configured', spentUsd: 0, availableUsd: 10 } })
      return accepted
    },
    openrouterClearKey: async () => {
      rmSync(keyFiles.openrouter, { force: true })
      update((state) => { state.openrouter = { status: 'not_configured' } })
    },
    githubStatus: async () => read().github,
    githubSetToken: async (token) => {
      if (!accepts(token)) return refused
      update((state) => { state.github = { status: 'connected', user: 'stand-in', scopes: ['repo'] } })
      writeFileSync(join(dir, 'github-token'), token)
      return accepted
    },
    githubToken: async () => (read().github.status === 'connected' && existsSync(join(dir, 'github-token')) ? readFileSync(join(dir, 'github-token'), 'utf8') : null),
    githubDisconnect: async () => {
      rmSync(join(dir, 'github-token'), { force: true })
      update((state) => { state.github = { status: 'not_connected' } })
    },
    awsStatus: async () => read().aws ?? { status: 'not_connected' },
    awsSetCredentials: async (credentials) => {
      if (!accepts(credentials.secretAccessKey)) return refused
      update((state) => {
        state.aws = {
          status: 'connected', accessKeyId: shortKeyId(credentials.accessKeyId), region: credentials.region,
          accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/ouro-agents', problem: null,
        }
      })
      return accepted
    },
    awsDisconnect: async () => update((state) => { state.aws = { status: 'not_connected' } }),
  }
}
