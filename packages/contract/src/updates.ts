// Phone updates, as the Expo Updates protocol (v1) serves them. This is the one manifest schema: the server builds every
// manifest through `buildUpdateManifest` and validates it before serving, and the app validates what it fetches with
// `UpdateManifest` before asking expo-updates to fetch it. A malformed manifest crashes expo-updates natively, beyond the
// reach of any JavaScript recovery, so nothing unvalidated may reach a phone.
import { z } from 'zod'

export const UPDATE_MANIFEST_PATH = '/updates/manifest'
export const UPDATE_ASSETS_PATH = '/updates/assets'
export const UPDATE_PROTOCOL_VERSION = '1'

/** Exactly what Date.prototype.toISOString produces: expo-updates' parser needs the milliseconds. */
const IsoTimestampWithMilliseconds = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

/** SHA-256, base64url without padding, as expo-updates checks it. */
const AssetHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const UpdateAssetFields = z.object({
  /**
   * expo-updates treats assets with the same key as the same file, across updates, and reuses what it has cached. So a
   * key is always its content hash: the same key can then only ever mean the same bytes.
   */
  key: z.string().min(1),
  contentType: z.string().min(1),
  fileExtension: z.string().regex(/^\.[A-Za-z0-9]+$/).optional(),
  hash: AssetHash,
  url: z.string().url(),
})
const keyIsContentHash = (asset: { key: string; hash: string }) => asset.key === asset.hash
const KEY_IS_CONTENT_HASH = { message: "an asset's key must be its content hash" }

export const UpdateAsset = UpdateAssetFields.refine(keyIsContentHash, KEY_IS_CONTENT_HASH)
export type UpdateAsset = z.infer<typeof UpdateAsset>

export const UpdateManifest = z.object({
  id: z.string().uuid(),
  createdAt: IsoTimestampWithMilliseconds,
  runtimeVersion: z.string().min(1),
  launchAsset: UpdateAssetFields.extend({ contentType: z.literal('application/javascript') }).refine(keyIsContentHash, KEY_IS_CONTENT_HASH),
  assets: z.array(UpdateAsset),
  metadata: z.record(z.string(), z.string()),
  extra: z.object({
    ouro: z.object({
      /** Numbers only rise. A phone shows this as its running update. */
      updateNumber: z.number().int().positive(),
      /** The source commit the update was built from, if known. */
      commit: z.string().nullable(),
      /** The computer that published it: update numbers count per computer. Absent from manifests made before it was added. */
      machineId: z.string().optional(),
    }),
  }),
}).strict()
export type UpdateManifest = z.infer<typeof UpdateManifest>

export interface UpdateForManifest {
  id: string
  createdAt: Date
  runtimeVersion: string
  updateNumber: number
  commit: string | null
  machineId: string
  launchAsset: { hash: string; url: string }
  assets: { contentType: string; fileExtension: string; hash: string; url: string }[]
}

/** The only way to make a manifest. Throws if the result wouldn't validate, so a bad one is never served. */
export function buildUpdateManifest(update: UpdateForManifest): UpdateManifest {
  return UpdateManifest.parse({
    id: update.id,
    createdAt: update.createdAt.toISOString(),
    runtimeVersion: update.runtimeVersion,
    launchAsset: { key: update.launchAsset.hash, contentType: 'application/javascript', hash: update.launchAsset.hash, url: update.launchAsset.url },
    assets: update.assets.map((asset) => ({ key: asset.hash, contentType: asset.contentType, fileExtension: asset.fileExtension, hash: asset.hash, url: asset.url })),
    metadata: {},
    extra: { ouro: { updateNumber: update.updateNumber, commit: update.commit, machineId: update.machineId } },
  })
}

/** What a server says about its newest update, unauthenticated, in its identity. */
export const PublishedUpdate = z.object({ updateNumber: z.number().int().positive(), runtimeVersion: z.string() })
export type PublishedUpdate = z.infer<typeof PublishedUpdate>

/**
 * The mark an agent puts in its message after `ouro publish`: a markdown link the app shows as whether that update is in
 * the app it's running. Elsewhere it reads as an ordinary link.
 */
export function updateMarkOf(updateNumber: number, machineId: string): string {
  return `[update ${updateNumber}](ouro://update/${updateNumber}?computer=${encodeURIComponent(machineId)})`
}

/** The update a mark's link names, or null when the link isn't one. */
export function parseUpdateMarkUrl(url: string): { updateNumber: number; machineId: string } | null {
  const m = /^ouro:\/\/update\/([1-9][0-9]*)\?computer=([^&\s]+)$/.exec(url)
  if (!m) return null
  try {
    return { updateNumber: Number(m[1]), machineId: decodeURIComponent(m[2]!) }
  } catch {
    return null
  }
}
