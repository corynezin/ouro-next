// The Sprites account new Sprite servers are made on: its API token (from sprites.dev), kept in a file of mode 600 and
// checked by listing one Sprite with it. Nothing else here uses it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SpritesIntegrationState } from '@ouro/contract'
import { SPRITES_API_BASE } from './sprites-api.ts'

export type SpritesTokenCheck = { kind: 'accepted' } | { kind: 'refused'; why: string } | { kind: 'unreachable'; why: string }

export interface SpritesAccount {
  token(): string | null
  status(): Promise<SpritesIntegrationState>
  /** Kept only if the Sprites API accepts it. */
  setToken(token: string): Promise<{ accepted: true } | { accepted: false; why: string }>
  disconnect(): void
}

export const shortToken = (token: string): string => (token.length <= 12 ? '…' : `${token.slice(0, 6)}…${token.slice(-4)}`)

export async function checkSpritesToken(token: string, base = SPRITES_API_BASE): Promise<SpritesTokenCheck> {
  let response: Response
  try {
    response = await fetch(`${base}/v1/sprites?max_results=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  } catch {
    return { kind: 'unreachable', why: "couldn't reach the Sprites API; try again" }
  }
  const text = await response.text().catch(() => '')
  if (response.ok) return { kind: 'accepted' }
  if (response.status === 401 || response.status === 403) return { kind: 'refused', why: 'the Sprites API rejected that token' }
  return { kind: 'unreachable', why: `the Sprites API answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}` }
}

export function fileSpritesAccount(path: string, check: (token: string) => Promise<SpritesTokenCheck> = checkSpritesToken): SpritesAccount {
  const token = () => (existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null)
  return {
    token,
    async status() {
      const saved = token()
      if (saved === null) return { status: 'not_connected' }
      const checked = await check(saved)
      return { status: 'connected', token: shortToken(saved), problem: checked.kind === 'accepted' ? null : checked.why }
    },
    async setToken(typed) {
      const candidate = typed.trim()
      if (!/^[\x21-\x7e]{10,500}$/.test(candidate)) return { accepted: false, why: "that doesn't look like a Sprites API token" }
      const checked = await check(candidate)
      if (checked.kind !== 'accepted') return { accepted: false, why: checked.why }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(`${path}.partial`, candidate, { mode: 0o600 })
      chmodSync(`${path}.partial`, 0o600)
      renameSync(`${path}.partial`, path)
      return { accepted: true }
    },
    disconnect() {
      rmSync(path, { force: true })
    },
  }
}
