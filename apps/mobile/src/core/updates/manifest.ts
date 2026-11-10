// Before expo-updates sees a manifest, the app reads it and checks it with the contract: a malformed manifest crashes
// expo-updates natively, where nothing in JavaScript can catch it, so an invalid one is never handed over.
import { UPDATE_MANIFEST_PATH, UPDATE_PROTOCOL_VERSION, UpdateManifest } from '@ouro/contract'
import type { Network } from '../platform/ports.ts'
import { reasonOf } from '../session/serverApi.ts'

/** Where updates come from: the home server's manifest route. */
export interface UpdateEndpoint { manifestUrl: string; headers: Record<string, string> }

export type ManifestCheck =
  | { kind: 'valid' }
  /** The server has nothing newer. */
  | { kind: 'none' }
  /** Refused: never handed to expo-updates. */
  | { kind: 'invalid'; reason: string }
  | { kind: 'unreachable'; reason: string }

export async function checkManifest(network: Network, endpoint: UpdateEndpoint, runtime: { runtimeVersion: string; platform: 'ios' }): Promise<ManifestCheck> {
  const abort = new AbortController()
  try {
    const response = await network.request({
      method: 'GET',
      url: endpoint.manifestUrl,
      headers: { ...endpoint.headers, accept: 'application/json', 'expo-platform': runtime.platform, 'expo-runtime-version': runtime.runtimeVersion, 'expo-protocol-version': UPDATE_PROTOCOL_VERSION },
      body: null,
      signal: abort.signal,
    })
    // 204 is the protocol's "no update", also when none exists for this runtime.
    if (response.status === 204) return { kind: 'none' }
    if (response.status < 200 || response.status >= 300) return { kind: 'unreachable', reason: `HTTP ${response.status}` }
    let json: unknown
    try { json = JSON.parse(response.text) } catch { return { kind: 'invalid', reason: 'the manifest is not JSON' } }
    const parsed = UpdateManifest.safeParse(json)
    if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
    if (parsed.data.runtimeVersion !== runtime.runtimeVersion) return { kind: 'invalid', reason: `the manifest is for runtime ${parsed.data.runtimeVersion}` }
    return { kind: 'valid' }
  } catch (error) {
    return { kind: 'unreachable', reason: reasonOf(error) }
  }
}

/** A server's update endpoint. Open: no token goes into expo-updates' native storage. */
export const updateEndpointOf = (serverUrl: string): UpdateEndpoint => ({ manifestUrl: `${serverUrl.replace(/\/+$/, '')}${UPDATE_MANIFEST_PATH}`, headers: {} })
