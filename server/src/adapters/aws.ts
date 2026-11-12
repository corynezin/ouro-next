// AWS, for agents: an IAM user's access key kept where the AWS CLI and every AWS SDK look first, the default profile of
// `~/.aws/credentials`, with its region in `~/.aws/config`. The server checks a key by asking AWS STS who it is, signed
// here with Signature Version 4, so it needs neither the CLI nor an SDK. Other profiles in those files are left alone.
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AwsIntegrationState } from '@ouro/contract'
import { ProviderUnreachable } from './provider-outcome.ts'
import type { ActionOutcome } from './provider-outcome.ts'

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; region: string }

/** A key as it is signed with: `sessionToken` only for temporary credentials, which someone set outside Ouro. */
export interface SigningCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

// The checks only keep out what can't be a key, so nothing odd (a newline, a bracket) reaches the INI files. Their bounds
// are IAM's own: a key id is 16 to 128 characters, AKIA (an IAM user's) or ASIA (temporary) and then capitals and digits;
// a secret is 40 base64 characters today, allowed 30 to 128 in case that changes; a region is like us-east-1 or
// ap-southeast-2, or us-gov-west-1.
const ACCESS_KEY_ID = /^AKIA[A-Z0-9]{12,124}$/
const TEMPORARY_KEY_ID = /^ASIA[A-Z0-9]{12,124}$/
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{30,128}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/

/** How long STS has to answer a check before it counts as unreachable. */
const STS_TIMEOUT_MS = 15_000

/** Why these can't be an access key, or null when they look like one. */
export function awsCredentialsProblem(credentials: AwsCredentials): string | null {
  if (TEMPORARY_KEY_ID.test(credentials.accessKeyId)) return 'that is a temporary key (ASIA…), which expires; make an access key for an IAM user (AKIA…)'
  if (!ACCESS_KEY_ID.test(credentials.accessKeyId)) return "that isn't an AWS access key id (it starts with AKIA)"
  if (!SECRET_ACCESS_KEY.test(credentials.secretAccessKey)) return "that isn't an AWS secret access key"
  if (!REGION.test(credentials.region)) return "that isn't an AWS region (like us-east-1)"
  return null
}

/** A key id fit to show: its first four and last four characters. */
export const shortKeyId = (accessKeyId: string) => `${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}`

// ---- INI files ----

/** The keys of one `[section]`, or an empty record when there is none. */
export function iniSection(text: string, section: string): Record<string, string> {
  const values: Record<string, string> = {}
  let inside = false
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) { inside = header[1]!.trim() === section; continue }
    if (!inside) continue
    const pair = /^\s*([^=#;\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (pair) values[pair[1]!] = pair[2]!
  }
  return values
}

/**
 * The text with `[section]`'s keys changed: a string sets one, null removes it. Every other line stays as it was. A section
 * left empty is removed; a missing one is added at the end.
 */
export function withIniSection(text: string, section: string, changes: Record<string, string | null>): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const start = lines.findIndex((line) => /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]?.trim() === section)
  const pending = new Map(Object.entries(changes))
  const setLines = () => [...pending].flatMap(([key, value]) => (value === null ? [] : [`${key} = ${value}`]))
  if (start === -1) {
    const added = setLines()
    if (added.length === 0) return text
    return [...lines, ...(lines.length > 0 && lines.at(-1)!.trim() !== '' ? [''] : []), `[${section}]`, ...added].join('\n') + '\n'
  }
  let end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*$/.test(line))
  if (end === -1) end = lines.length
  const body: string[] = []
  for (const line of lines.slice(start + 1, end)) {
    const key = /^\s*([^=#;\s][^=]*?)\s*=/.exec(line)?.[1]
    if (key === undefined || !pending.has(key)) { body.push(line); continue }
    const value = pending.get(key)!
    pending.delete(key)
    if (value !== null) body.push(`${key} = ${value}`)
  }
  while (body.length > 0 && body.at(-1)!.trim() === '') body.pop()
  body.push(...setLines())
  const trailing = end < lines.length ? [''] : []
  const kept = body.some((line) => line.trim() !== '' && !/^\s*[#;]/.test(line))
  const section_ = kept ? [lines[start]!, ...body, ...trailing] : []
  const result = [...lines.slice(0, start), ...section_, ...lines.slice(end)]
  while (result.length > 0 && result.at(-1)!.trim() === '') result.pop()
  return result.length === 0 ? '' : result.join('\n') + '\n'
}

// ---- Signature Version 4 ----

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

export interface SigningRequest {
  method: string
  host: string
  path: string
  query: string
  /** Lowercase names; `host` and `x-amz-date` are added. */
  headers: Record<string, string>
  body: string
  region: string
  service: string
  /** As `YYYYMMDDTHHMMSSZ`. */
  amzDate: string
}

/** The `Authorization` header for a request, per AWS Signature Version 4. */
export function sigV4Authorization(request: SigningRequest, credentials: { accessKeyId: string; secretAccessKey: string }): string {
  const headers: Record<string, string> = { ...request.headers, host: request.host, 'x-amz-date': request.amzDate }
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]!.trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [request.method, request.path, request.query, canonicalHeaders, signedHeaders, sha256(request.body)].join('\n')
  const dateStamp = request.amzDate.slice(0, 8)
  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', request.amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), request.region), request.service), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

const amzDateOf = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** The headers a check sends besides `host` and `x-amz-date`: temporary credentials carry their token, signed with the rest. */
export function stsHeaders(credentials: SigningCredentials): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
  return headers
}

export type CallerIdentity = { kind: 'known'; accountId: string; arn: string } | { kind: 'refused'; why: string }

/** Who AWS says the key is, through STS's GetCallerIdentity, which any key may ask. Throws ProviderUnreachable. */
export async function getCallerIdentity(credentials: SigningCredentials, now = new Date()): Promise<CallerIdentity> {
  const host = 'sts.amazonaws.com'
  const body = 'Action=GetCallerIdentity&Version=2011-06-15'
  const headers = stsHeaders(credentials)
  const amzDate = amzDateOf(now)
  const authorization = sigV4Authorization({ method: 'POST', host, path: '/', query: '', headers, body, region: 'us-east-1', service: 'sts', amzDate }, credentials)
  let response: Response
  try {
    response = await fetch(`https://${host}/`, { method: 'POST', headers: { ...headers, 'x-amz-date': amzDate, authorization }, body, signal: AbortSignal.timeout(STS_TIMEOUT_MS) })
  } catch {
    throw new ProviderUnreachable("couldn't reach AWS to check the key; try again")
  }
  const text = await response.text().catch(() => '')
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1] ?? null
  if (response.status === 403 || response.status === 401) {
    const message = tag('Message')
    return { kind: 'refused', why: `AWS rejected that key${message ? `: ${message.slice(0, 200)}` : ''}` }
  }
  if (!response.ok) throw new ProviderUnreachable(`AWS answered ${response.status} when checking the key; try again`)
  const accountId = tag('Account')
  const arn = tag('Arn')
  if (!accountId || !arn) throw new ProviderUnreachable("AWS's answer couldn't be read")
  return { kind: 'known', accountId, arn }
}

// ---- The tools ----

export interface AwsTools {
  awsStatus(): Promise<AwsIntegrationState>
  awsSetCredentials(credentials: AwsCredentials): Promise<ActionOutcome>
  awsDisconnect(): Promise<void>
}

export interface AwsFiles { credentials: string; config: string }

/** Where the AWS CLI looks, as it decides: its environment variables, else `~/.aws`. */
export function awsFilesOf(environment: Record<string, string | undefined>): AwsFiles {
  return {
    credentials: environment.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
    config: environment.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
  }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

function writeText(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.partial`, text, { mode })
  chmodSync(`${path}.partial`, mode)
  renameSync(`${path}.partial`, path)
}

export function realAwsTools(files: AwsFiles, identify: typeof getCallerIdentity = getCallerIdentity): AwsTools {
  return {
    async awsStatus() {
      const keys = iniSection(readText(files.credentials), 'default')
      const accessKeyId = keys.aws_access_key_id
      const secretAccessKey = keys.aws_secret_access_key
      // Set by hand or by another tool, the default profile may hold temporary credentials: they work for agents, so
      // they are checked as they are, token and all.
      const sessionToken = keys.aws_session_token || undefined
      if (!accessKeyId || !secretAccessKey) return { status: 'not_connected' }
      const region = iniSection(readText(files.config), 'default').region ?? null
      const shown = { status: 'connected' as const, accessKeyId: shortKeyId(accessKeyId), region }
      try {
        const identity = await identify({ accessKeyId, secretAccessKey, sessionToken })
        if (identity.kind === 'refused') return { ...shown, accountId: null, arn: null, problem: identity.why }
        return { ...shown, accountId: identity.accountId, arn: identity.arn, problem: null }
      } catch (error) {
        if (!(error instanceof ProviderUnreachable)) throw error
        return { ...shown, accountId: null, arn: null, problem: error.message }
      }
    },
    async awsSetCredentials(credentials) {
      const problem = awsCredentialsProblem(credentials)
      if (problem) return { accepted: false, why: problem }
      const identity = await identify(credentials)
      if (identity.kind === 'refused') return { accepted: false, why: identity.why }
      writeText(files.credentials, withIniSection(readText(files.credentials), 'default', {
        aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey, aws_session_token: null,
      }), 0o600)
      writeText(files.config, withIniSection(readText(files.config), 'default', { region: credentials.region }), 0o600)
      return { accepted: true }
    },
    async awsDisconnect() {
      if (existsSync(files.credentials)) {
        writeText(files.credentials, withIniSection(readText(files.credentials), 'default', {
          aws_access_key_id: null, aws_secret_access_key: null, aws_session_token: null,
        }), 0o600)
      }
    },
  }
}
