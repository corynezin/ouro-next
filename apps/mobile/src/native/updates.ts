// expo-updates as core's UpdateSource, and which code is running.
import { useEffect } from 'react'
import * as Updates from 'expo-updates'
import type { RunningCode, UpdateFlow, UpdateSource } from '../core/updates/updateFlow.ts'
import type { UpdateEndpoint } from '../core/updates/manifest.ts'
import { UpdateManifest } from '@ouro/contract'

export const nativeUpdateSource: UpdateSource = {
  enabled: Updates.isEnabled,
  // A cleared override falls back to the built-in version and ignores the old endpoint's updates, as tested.
  pointAt(endpoint: UpdateEndpoint | null) {
    Updates.setUpdateURLAndRequestHeadersOverride(endpoint ? { updateUrl: endpoint.manifestUrl, requestHeaders: endpoint.headers } : null)
  },
  async downloadNewVersion() {
    const check = await Updates.checkForUpdateAsync()
    if (!check.isAvailable) return false
    const fetched = await Updates.fetchUpdateAsync()
    return fetched.isNew
  },
  restart: () => Updates.reloadAsync(),
}

/** Tells the flow about an update expo-updates downloaded by itself, as its launch check does. */
export function useUpdatesDownloadedAtLaunch(flow: UpdateFlow) {
  const { isUpdatePending } = Updates.useUpdates()
  useEffect(() => { if (isUpdatePending) flow.newVersionDownloaded() }, [flow, isUpdatePending])
}

export function runningCode(): RunningCode {
  if (!Updates.isEnabled) return { kind: 'development' }
  if (Updates.isEmbeddedLaunch || Updates.updateId === null) return { kind: 'embedded', runtimeVersion: Updates.runtimeVersion }
  return { kind: 'update', updateId: Updates.updateId, createdAt: Updates.createdAt, updateNumber: updateNumberOf(Updates.manifest) }
}

/** The running manifest was validated before it was fetched; this reads only the part Settings shows. */
function updateNumberOf(manifest: unknown): number | null {
  const extra = typeof manifest === 'object' && manifest !== null && 'extra' in manifest ? manifest.extra : undefined
  const parsed = UpdateManifest.shape.extra.safeParse(extra)
  return parsed.success ? parsed.data.ouro.updateNumber : null
}
