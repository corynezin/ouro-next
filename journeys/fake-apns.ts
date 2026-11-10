// A fake APNs gateway for journeys: HTTP/2 like APNs, checking the provider token's signature as Apple would, and keeping
// every push it takes.
import { generateKeyPairSync, verify } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http2'
import type { Http2Server } from 'node:http2'
import { join } from 'node:path'
import { PushPayload } from '@ouro/contract'
import type { JourneyRun } from './harness.ts'

export const BUNDLE_ID = 'dev.ouro.journey'
export const TEAM_ID = 'TEAMJOURNY'
export const KEY_ID = 'KEYJOURNEY'

export interface Pushed {
  token: string
  headers: Record<string, string>
  aps: Record<string, unknown>
  ouro: PushPayload
}

export class FakeApns {
  readonly pushed: Pushed[] = []
  /** Tokens answered as unregistered. */
  readonly goneTokens = new Set<string>()
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  private readonly gateway: Http2Server = createServer()
  private port = 0

  async start(): Promise<void> {
    this.gateway.on('stream', (stream, headers) => {
      let body = ''
      stream.on('data', (chunk: Buffer) => { body += chunk.toString() })
      stream.on('end', () => {
        const token = String(headers[':path']).replace('/3/device/', '')
        if (!this.providerTokenValid(headers.authorization)) {
          stream.respond({ ':status': 403 })
          return stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }))
        }
        if (this.goneTokens.has(token)) {
          stream.respond({ ':status': 410 })
          return stream.end(JSON.stringify({ reason: 'Unregistered' }))
        }
        const { aps, ouro } = JSON.parse(body) as { aps: Record<string, unknown>; ouro: unknown }
        // Contract tier: what the app will parse.
        this.pushed.push({ token, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)])), aps, ouro: PushPayload.parse(ouro) })
        stream.respond({ ':status': 200 })
        stream.end()
      })
    })
    await new Promise<void>((listening) => this.gateway.listen(0, '127.0.0.1', listening))
    this.port = (this.gateway.address() as { port: number }).port
  }

  /** The environment a JourneyRun is made with, so its server pushes here. */
  runEnv(): Record<string, string> {
    return { OURO_APNS_KEY_ID: KEY_ID, OURO_APNS_TEAM_ID: TEAM_ID, OURO_APNS_GATEWAY: `http://127.0.0.1:${this.port}` }
  }

  /** Gives the run's server the signing key, in a file of the run's own. */
  addKeyTo(run: JourneyRun): void {
    const keyFile = join(run.dir, 'apns-key.p8')
    writeFileSync(keyFile, this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    run.addServerEnv({ OURO_APNS_KEY_FILE: keyFile })
  }

  close(): void {
    this.gateway.close()
  }

  private providerTokenValid(authorization: string | undefined): boolean {
    const [header, claims, signature] = (authorization ?? '').replace(/^bearer /, '').split('.')
    if (!header || !claims || !signature) return false
    const { kid, alg } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid: string; alg: string }
    const { iss } = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { iss: string }
    return alg === 'ES256' && kid === KEY_ID && iss === TEAM_ID
      && verify('sha256', Buffer.from(`${header}.${claims}`), { key: this.keys.publicKey.export({ type: 'spki', format: 'pem' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  }
}
