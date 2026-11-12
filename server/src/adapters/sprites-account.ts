// The Sprites account new Sprite servers are made on, as one of the accounts in Integrations: its API token (from
// sprites.dev), kept in a file of mode 600 and checked by listing one Sprite with it. Only making servers uses it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SpritesIntegrationState } from '@ouro/contract'
import { SPRITES_API_BASE } from '@ouro/contract/sprites'
import type { ActionOutcome } from './provider-outcome.ts'

export type SpritesTokenCheck = { kind: 'accepted' } | { kind: 'refused'; why: string } | { kind: 'unreachable'; why: string }

export interface SpritesTools {
  /** The saved token, for the Sprites API; null when Sprites isn't connected. Never logged. */
  spritesToken(): string | null
  spritesStatus(): Promise<SpritesIntegrationState>
  /** Kept only if the Sprites API accepts it. */
  spritesSetToken(token: string): Promise<ActionOutcome>
  spritesDisconnect(): Promise<void>
}

export const shortToken = (token: string): string => (token.length <= 12 ? '…' : `${token.slice(0, 6)}…${token.slice(-4)}`)

/** Printable ASCII without spaces, of a token's length: anything else is a paste gone wrong, refused before the API sees it. */
const TOKEN_SHAPE = /^[\x21-\x7e]{10,500}$/

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

/** The token in a file at `path`; `check` asks the Sprites API, or a stand-in, whether a token works. */
export function fileSpritesTools(path: string, check: (token: string) => Promise<SpritesTokenCheck> = checkSpritesToken): SpritesTools {
  const spritesToken = () => (existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null)
  return {
    spritesToken,
    async spritesStatus() {
      const saved = spritesToken()
      if (saved === null) return { status: 'not_connected' }
      const checked = await check(saved)
      return { status: 'connected', token: shortToken(saved), problem: checked.kind === 'accepted' ? null : checked.why }
    },
    async spritesSetToken(typed) {
      const candidate = typed.trim()
      if (!TOKEN_SHAPE.test(candidate)) return { accepted: false, why: "that doesn't look like a Sprites API token" }
      const checked = await check(candidate)
      if (checked.kind !== 'accepted') return { accepted: false, why: checked.why }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(`${path}.partial`, candidate, { mode: 0o600 })
      chmodSync(`${path}.partial`, 0o600)
      renameSync(`${path}.partial`, path)
      return { accepted: true }
    },
    async spritesDisconnect() {
      rmSync(path, { force: true })
    },
  }
}
