import type { IdSource, SecureStorage } from '../platform/ports.ts'

/** Keeps the exact stored value under a new key, before an explicitly requested replacement. */
export async function saveRecoveryCopy(storage: SecureStorage, ids: IdSource, key: string) {
  const raw = await storage.read(key)
  if (raw !== null) await storage.write(`${key}.recovery.${ids.newId()}`, raw)
}
