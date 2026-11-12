// The guardian's own check of an update manifest. It deliberately repeats the contract's rules instead of importing
// them: the check that decides on rollback must not depend on code a release can change. A test in the contract package
// runs both on the same cases, so the two can't drift apart unnoticed.

const ISO_WITH_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ASSET_HASH = /^[A-Za-z0-9_-]{43}$/
const FILE_EXTENSION = /^\.[A-Za-z0-9]+$/
const MANIFEST_KEYS = ['id', 'createdAt', 'runtimeVersion', 'launchAsset', 'assets', 'metadata', 'extra']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isAbsoluteUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol.length > 0
  } catch {
    return false
  }
}

function assetProblem(asset: unknown, where: string): string | null {
  if (!isRecord(asset)) return `${where} is not an object`
  if (typeof asset.key !== 'string' || asset.key.length === 0) return `${where}.key is missing`
  if (typeof asset.contentType !== 'string' || asset.contentType.length === 0) return `${where}.contentType is missing`
  if (asset.fileExtension !== undefined && (typeof asset.fileExtension !== 'string' || !FILE_EXTENSION.test(asset.fileExtension))) return `${where}.fileExtension is malformed`
  if (typeof asset.hash !== 'string' || !ASSET_HASH.test(asset.hash)) return `${where}.hash is not a base64url SHA-256`
  // expo-updates reuses a cached asset with the same key, even from another update: a key must be its content hash.
  if (asset.key !== asset.hash) return `${where}.key is not its content hash`
  if (!isAbsoluteUrl(asset.url)) return `${where}.url is not an absolute URL`
  return null
}

/** Null if a phone can safely be given this manifest, otherwise what is wrong with it. */
export function manifestProblem(manifest: unknown): string | null {
  if (!isRecord(manifest)) return 'the manifest is not an object'
  const unknownKeys = Object.keys(manifest).filter((key) => !MANIFEST_KEYS.includes(key))
  if (unknownKeys.length > 0) return `unknown fields: ${unknownKeys.join(', ')}`
  if (typeof manifest.id !== 'string' || !UUID.test(manifest.id)) return 'id is not a UUID'
  if (typeof manifest.createdAt !== 'string' || !ISO_WITH_MILLISECONDS.test(manifest.createdAt)) return 'createdAt is not an ISO time with milliseconds'
  if (typeof manifest.runtimeVersion !== 'string' || manifest.runtimeVersion.length === 0) return 'runtimeVersion is missing'
  const launchProblem = assetProblem(manifest.launchAsset, 'launchAsset')
  if (launchProblem) return launchProblem
  if ((manifest.launchAsset as Record<string, unknown>).contentType !== 'application/javascript') return 'launchAsset is not JavaScript'
  if (!Array.isArray(manifest.assets)) return 'assets is not a list'
  for (const [index, asset] of manifest.assets.entries()) {
    const problem = assetProblem(asset, `assets[${index}]`)
    if (problem) return problem
  }
  if (!isRecord(manifest.metadata) || !Object.values(manifest.metadata).every((value) => typeof value === 'string')) return 'metadata is not a map of strings'
  const ouro = isRecord(manifest.extra) ? manifest.extra.ouro : undefined
  if (!isRecord(ouro) || !Number.isInteger(ouro.updateNumber) || (ouro.updateNumber as number) <= 0) return 'extra.ouro.updateNumber is missing'
  if (ouro.commit !== null && typeof ouro.commit !== 'string') return 'extra.ouro.commit is malformed'
  if (ouro.machineId !== undefined && typeof ouro.machineId !== 'string') return 'extra.ouro.machineId is malformed'
  return null
}
