// The real accounts: Claude Code (`claude auth`), Codex (`codex app-server`), OpenRouter's API, GitHub's `gh` and AWS. Each
// keeps its own login in its own files; the server keeps only the keys it was given, in `secretsDir` (mode 600), and
// never logs a code, key or token.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatgptIntegrationState, ClaudeIntegrationState, GithubIntegrationState, OpenrouterIntegrationState } from '@ouro/contract'
import type { PlanWindowReading } from '../domain/usage.ts'
import { CodexAppServer } from './codex-app-server.ts'
import { ProviderUnreachable } from './integrations.ts'
import { realAwsTools } from './aws.ts'
import type { AwsFiles } from './aws.ts'
import type { ActionOutcome, IntegrationTools } from './integrations.ts'

const TOOL_TIMEOUT_MS = 20_000

type CodexWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
type CodexRateLimits = { primary?: CodexWindow | null; secondary?: CodexWindow | null }

/**
 * The windows in Codex's `account/rateLimits/read` answer: the Codex limit's own when it lists limits by id, else the
 * account's. Percent used, minutes long, and reset time in seconds. A window without a length can't be told apart.
 */
export function planWindowsOfCodexRateLimits(result: { rateLimits?: CodexRateLimits; rateLimitsByLimitId?: Record<string, CodexRateLimits> }): PlanWindowReading[] {
  const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits
  return [limits?.primary, limits?.secondary].flatMap((window) => {
    if (!window || typeof window.usedPercent !== 'number' || typeof window.windowDurationMins !== 'number' || window.windowDurationMins <= 0) return []
    const resetsAt = typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : null
    return [{ windowMinutes: window.windowDurationMins, usedFraction: window.usedPercent / 100, resetsAt, status: null }]
  })
}

/**
 * What an OpenRouter key may still spend: the lesser of what's left of its own limit (`limit_remaining`, null for a key
 * without one) and of the account's credits. Null when OpenRouter said neither.
 */
export function openrouterAvailableUsd(key: { limit_remaining?: number | null } | undefined, credits: { total_credits?: number; total_usage?: number } | undefined): number | null {
  const left: number[] = []
  if (typeof key?.limit_remaining === 'number') left.push(key.limit_remaining)
  if (typeof credits?.total_credits === 'number' && typeof credits.total_usage === 'number') left.push(credits.total_credits - credits.total_usage)
  return left.length === 0 ? null : Math.max(0, Math.min(...left))
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function writeSecret(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.partial`, `${value}\n`, { mode: 0o600 })
  chmodSync(`${path}.partial`, 0o600)
  renameSync(`${path}.partial`, path)
}

const readSecret = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null)

/** Runs a tool and gives its output whether or not it succeeded; null if it isn't installed or timed out. */
function runTool(command: string, args: string[], stdin?: string): Promise<{ ok: boolean; output: string } | null> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || error.killed)) return resolve(null)
      resolve({ ok: !error, output: `${stdout}\n${stderr}` })
    })
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

export function realIntegrationTools(options: { dataDir: string; anthropicKeyFile: string; openrouterKeyFile: string; claudeConfigDir: string | null; awsFiles: AwsFiles }): IntegrationTools {
  const claudeKeyFile = options.anthropicKeyFile
  const openrouterKeyFile = options.openrouterKeyFile
  const claudeSettingsFile = join(options.claudeConfigDir ?? join(homedir(), '.claude'), 'settings.json')
  const apiKeyHelper = `cat '${claudeKeyFile}'`
  // Its own tmux server, named for this data directory, so it can't meet any other login on the machine.
  const tmuxServer = `ouro-login-${createHash('sha256').update(options.dataDir).digest('hex').slice(0, 12)}`
  const tmux = (args: string[], input?: string) => execFileSync('tmux', ['-L', tmuxServer, ...args], { encoding: 'utf8', timeout: 10_000, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  const loginAlive = () => { try { tmux(['has-session', '-t', 'login']); return true } catch { return false } }
  const loginScreen = () => { try { return tmux(['capture-pane', '-p', '-J', '-t', 'login', '-S', '-200']) } catch { return '' } }
  const endLogin = () => { try { tmux(['kill-server']) } catch { /* none running */ } }

  const readSettings = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(claudeSettingsFile, 'utf8')) as Record<string, unknown> } catch { return {} } }
  const setHelper = (helper: string | null) => {
    const settings = readSettings()
    if (helper === null) delete settings.apiKeyHelper
    else settings.apiKeyHelper = helper
    mkdirSync(dirname(claudeSettingsFile), { recursive: true })
    writeFileSync(`${claudeSettingsFile}.partial`, `${JSON.stringify(settings, null, 2)}\n`)
    renameSync(`${claudeSettingsFile}.partial`, claudeSettingsFile)
  }
  const apiKeyInUse = () => existsSync(claudeKeyFile) && readSettings().apiKeyHelper === apiKeyHelper

  const claudeStatus = async (): Promise<ClaudeIntegrationState> => {
    if (apiKeyInUse()) return { status: 'signed_in', account: { method: 'api_key' } }
    const result = await runTool('claude', ['auth', 'status', '--json'])
    if (!result) throw new ProviderUnreachable("Claude Code didn't answer")
    // An answer it can't read says nothing: signed out holds every agent, so it needs a clear "not logged in".
    let status: { loggedIn?: unknown; email?: unknown }
    try {
      status = JSON.parse(result.output.slice(result.output.indexOf('{'))) as typeof status
    } catch {
      throw new ProviderUnreachable("Claude Code's sign-in status couldn't be read")
    }
    if (typeof status.loggedIn !== 'boolean') throw new ProviderUnreachable("Claude Code's sign-in status couldn't be read")
    return status.loggedIn ? { status: 'signed_in', account: { method: 'plan', email: typeof status.email === 'string' ? status.email : null } } : { status: 'signed_out' }
  }

  const checkKey = async (url: string, headers: Record<string, string>, provider: string): Promise<ActionOutcome> => {
    let response: Response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new ProviderUnreachable(`couldn't reach ${provider} to check the key; try again`)
    }
    if (response.status === 401 || response.status === 403) return { accepted: false, why: `${provider} rejected that key` }
    if (!response.ok) throw new ProviderUnreachable(`${provider} answered ${response.status} when checking the key; try again`)
    return { accepted: true }
  }

  const githubStatus = async (): Promise<GithubIntegrationState> => {
    const result = await runTool('gh', ['auth', 'status', '--hostname', 'github.com'])
    if (!result) return { status: 'not_connected' }
    if (!result.ok) return { status: 'not_connected' }
    const user = /Logged in to github\.com (?:account|as) (\S+)/i.exec(result.output)?.[1] ?? null
    const scopes = /Token scopes:\s*([^\n]+)/i.exec(result.output)?.[1]?.split(',').map((scope) => scope.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) ?? []
    return { status: 'connected', user, scopes }
  }

  let chatgptLogin: { codex: CodexAppServer; timer: NodeJS.Timeout } | null = null
  const endChatgptLogin = () => {
    if (!chatgptLogin) return
    clearTimeout(chatgptLogin.timer)
    chatgptLogin.codex.close()
    chatgptLogin = null
  }

  return {
    ...realAwsTools(options.awsFiles),
    claudeStatus,
    async claudeLoginStart() {
      endLogin()
      try {
        tmux(['new-session', '-d', '-s', 'login', '-x', '1000', '-y', '50', 'claude auth login --claudeai'])
      } catch (error) {
        throw new ProviderUnreachable(`couldn't start claude auth login: ${(error as Error).message.split('\n')[0]}`)
      }
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
        const url = /https:\/\/\S*oauth\/authorize\S*/.exec(loginScreen())?.[0]
        if (url) return { url }
        if (!loginAlive()) break
      }
      endLogin()
      throw new ProviderUnreachable('claude auth login showed no sign-in address')
    },
    async claudeLoginFinish(code) {
      if (/[\r\n\x00-\x1f]/.test(code)) return { accepted: false, why: "that isn't a sign-in code" }
      if (!loginAlive()) return { accepted: false, why: 'no sign-in in progress: start it again' }
      tmux(['load-buffer', '-b', 'code', '-'], code)
      tmux(['paste-buffer', '-d', '-b', 'code', '-t', 'login'])
      tmux(['send-keys', '-t', 'login', 'Enter'])
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(500)) {
        const afterCode = loginScreen().split(code).pop() ?? ''
        if (!loginAlive() || /success|logged in/i.test(afterCode)) break
        const failure = /(error|invalid|failed)[^\n]*/i.exec(afterCode)
        if (failure) {
          endLogin()
          return { accepted: false, why: `Claude refused it: ${failure[0].slice(0, 200)}` }
        }
      }
      endLogin()
      // A key in use answers for itself, so look at the login without it; keep the key if the login didn't take.
      const helperBefore = apiKeyInUse() ? apiKeyHelper : null
      if (helperBefore) setHelper(null)
      const status = await claudeStatus()
      if (status.status !== 'signed_in') {
        if (helperBefore) setHelper(helperBefore)
        return { accepted: false, why: 'Claude is still signed out: start again and use the newest code' }
      }
      rmSync(claudeKeyFile, { force: true })
      return { accepted: true }
    },
    async claudeSetApiKey(key) {
      if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) return { accepted: false, why: "that isn't an Anthropic API key (it starts with sk-ant-)" }
      const checked = await checkKey('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 'Anthropic')
      if (!checked.accepted) return checked
      writeSecret(claudeKeyFile, key)
      setHelper(apiKeyHelper)
      return { accepted: true }
    },
    async claudeClearApiKey() {
      if (readSettings().apiKeyHelper === apiKeyHelper) setHelper(null)
      rmSync(claudeKeyFile, { force: true })
    },
    async chatgptStatus(): Promise<ChatgptIntegrationState> {
      type Account = { type?: string; email?: string; planType?: string }
      let observed: { account: Account; models: string[] } | null
      try {
        observed = await withCodex(async (codex) => {
          const { account } = await codex.request('account/read', {}) as { account: Account | null }
          if (!account) return null
          // Which models an account may use depends on its plan, so Codex is asked.
          const listed = await codex.request('model/list', { limit: 50 }) as { data: { model: string; hidden?: boolean }[] }
          return { account, models: listed.data.filter((model) => !model.hidden).map((model) => model.model) }
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not_installed' }
        throw new ProviderUnreachable(`Codex didn't answer: ${(error as Error).message.slice(0, 200)}`)
      }
      if (!observed) return { status: 'signed_out' }
      return { status: 'signed_in', email: observed.account.email ?? null, plan: observed.account.planType ?? null, models: observed.models }
    },
    async chatgptLoginStart() {
      endChatgptLogin()
      const codex = new CodexAppServer({ command: 'codex', cwd: null, env: null })
      // The device code lasts 15 minutes; the app-server must stay up until it is entered.
      chatgptLogin = { codex, timer: setTimeout(endChatgptLogin, 16 * 60_000) }
      chatgptLogin.timer.unref()
      codex.onNotify = (method) => { if (method === 'account/login/completed' && chatgptLogin?.codex === codex) endChatgptLogin() }
      try {
        await codex.initialize()
        const started = await codex.request('account/login/start', { type: 'chatgptDeviceCode' }) as { verificationUrl: string; userCode: string }
        return { url: String(started.verificationUrl), code: String(started.userCode), expiresAt: Date.now() + 15 * 60_000 }
      } catch (error) {
        if (chatgptLogin?.codex === codex) endChatgptLogin()
        throw new ProviderUnreachable(`couldn't start the ChatGPT sign-in: ${(error as Error).message.split('\n')[0]!.slice(0, 200)}`)
      }
    },
    async chatgptSignOut() {
      endChatgptLogin()
      try {
        await withCodex((codex) => codex.request('account/logout', undefined))
      } catch (error) {
        throw new ProviderUnreachable(`couldn't sign out of ChatGPT: ${(error as Error).message.slice(0, 200)}`)
      }
    },
    async chatgptPlanUsage() {
      const result = await withCodex((codex) => codex.request('account/rateLimits/read', {}))
      return planWindowsOfCodexRateLimits(result as Parameters<typeof planWindowsOfCodexRateLimits>[0])
    },
    async openrouterStatus(): Promise<OpenrouterIntegrationState> {
      const key = readSecret(openrouterKeyFile)
      if (!key) return { status: 'not_configured' }
      const ask = async <T>(path: string): Promise<T | undefined> => {
        try {
          const response = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
          return (await response.json() as { data?: T }).data
        } catch {
          return undefined
        }
      }
      const [keyData, credits] = await Promise.all([
        ask<{ usage?: number; limit_remaining?: number | null }>('key'),
        ask<{ total_credits?: number; total_usage?: number }>('credits'),
      ])
      return { status: 'configured', spentUsd: keyData?.usage ?? null, availableUsd: openrouterAvailableUsd(keyData, credits) }
    },
    async openrouterSetKey(key) {
      if (!/^sk-or-[A-Za-z0-9_-]{20,300}$/.test(key)) return { accepted: false, why: "that isn't an OpenRouter API key (it starts with sk-or-)" }
      const checked = await checkKey('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key}` }, 'OpenRouter')
      if (!checked.accepted) return checked
      writeSecret(openrouterKeyFile, key)
      return { accepted: true }
    },
    async openrouterClearKey() {
      rmSync(openrouterKeyFile, { force: true })
    },
    githubStatus,
    async githubSetToken(token) {
      if (!/^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+$|^[0-9a-fA-F]{40}$/.test(token)) return { accepted: false, why: "that doesn't look like a GitHub token" }
      const result = await runTool('gh', ['auth', 'login', '--with-token', '--hostname', 'github.com'], token)
      if (!result) throw new ProviderUnreachable("GitHub's gh tool isn't installed or didn't answer")
      if (!result.ok) return { accepted: false, why: `GitHub refused it: ${result.output.trim().split('\n')[0]!.slice(0, 200)}` }
      return { accepted: true }
    },
    async githubToken() {
      const result = await runTool('gh', ['auth', 'token', '--hostname', 'github.com'])
      const token = result?.ok ? result.output.trim().split('\n')[0]!.trim() : ''
      return token === '' ? null : token
    },
    async githubDisconnect() {
      const result = await runTool('gh', ['auth', 'logout', '--hostname', 'github.com'])
      if (!result) throw new ProviderUnreachable("GitHub's gh tool isn't installed or didn't answer")
    },
  }
}

/** An app-server for one short question. */
async function withCodex<T>(job: (codex: CodexAppServer) => Promise<T>): Promise<T> {
  const codex = new CodexAppServer({ command: 'codex', cwd: null, env: null })
  const limit = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('codex did not answer')), TOOL_TIMEOUT_MS).unref())
  try {
    return await Promise.race([codex.initialize().then(() => job(codex)), limit])
  } finally {
    codex.close()
  }
}
