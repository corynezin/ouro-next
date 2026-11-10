// This machine's Ed25519 key, and signed requests to peers' APIs. The transport between machines (a private network such
// as Tailscale) gives confidentiality; signatures give authenticity and integrity.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PEER_API_PREFIX, PEER_SIGNATURE_HEADERS, PeerError } from '@ouro/contract'
import type { KeyObject } from 'node:crypto'
import { signedPayload } from '../domain/peers.ts'

export interface MachineKey {
  privateKey: KeyObject
  /** SPKI PEM, as peers keep it. */
  publicKeyPem: string
}

/** Made once, on first start; mode 600. */
export function loadOrCreateMachineKey(path: string): MachineKey {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const privateKey = createPrivateKey(readFileSync(path))
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() }
}

export const sha256Hex = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex')

export function signatureHeaders(key: MachineKey, machineId: string, method: string, path: string, body: string, now: number): Record<string, string> {
  const time = String(now)
  const nonce = randomBytes(16).toString('hex')
  const payload = signedPayload({ method, path, bodySha256: sha256Hex(body), machineId, time, nonce })
  return {
    [PEER_SIGNATURE_HEADERS.machine]: machineId,
    [PEER_SIGNATURE_HEADERS.time]: time,
    [PEER_SIGNATURE_HEADERS.nonce]: nonce,
    [PEER_SIGNATURE_HEADERS.signature]: sign(null, Buffer.from(payload), key.privateKey).toString('base64'),
  }
}

export function signatureValid(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(payload), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** The peer didn't answer, or answered with something other than its API: worth trying again later. `mayHaveArrived`:
 * the request may have reached it and been acted on, as when a connection was made and its answer was lost. */
export class PeerUnreachable extends Error {
  readonly mayHaveArrived: boolean
  constructor(message: string, mayHaveArrived: boolean) {
    super(message)
    this.mayHaveArrived = mayHaveArrived
  }
}

/** Errors that mean no connection was ever made, so nothing was sent. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])

function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause
  return typeof cause?.code === 'string' && NEVER_CONNECTED.has(cause.code)
}

/** The peer answered and refused, with its reason. */
export class PeerRefused extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const PEER_REQUEST_TIMEOUT_MS = 5_000

/** A request to a peer's API at `address`; signed unless `signer` is null (only /join). Answers its parsed JSON. */
export async function peerRequest(address: string, method: string, route: string, body: unknown, signer: { key: MachineKey; machineId: string } | null, now: number, timeoutMs = PEER_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const path = `${PEER_API_PREFIX}${route}`
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers: Record<string, string> = {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(signer ? signatureHeaders(signer.key, signer.machineId, method, path, text, now) : {}),
  }
  let response: Response
  try {
    response = await fetch(new URL(path, address), { method, headers, body: body === undefined ? undefined : text, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new PeerUnreachable(`couldn't reach ${address}: ${(error as Error).message}`, !neverConnected(error))
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new PeerUnreachable(`${address} answered ${response.status} without JSON`, true)
  }
  if (response.ok) return json
  const refusal = PeerError.safeParse(json)
  if (!refusal.success) throw new PeerUnreachable(`${address} answered ${response.status}`, true)
  throw new PeerRefused(refusal.data.error.code, refusal.data.error.message)
}
