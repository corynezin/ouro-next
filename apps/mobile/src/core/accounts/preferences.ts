// This phone's preferences. Invalid fields fall back to defaults and mark storage damaged: changes then apply for this run
// only, until the person resets, so nothing that recovery still needs gets overwritten.
import { z } from 'zod'
import type { IdSource, SecureStorage } from '../platform/ports.ts'
import { saveRecoveryCopy } from './recoveryCopy.ts'

const PREFERENCES_KEY = 'ouronext.preferences'

const IdleFold = z.discriminatedUnion('kind', [
  /** As the server decides. */
  z.object({ kind: z.literal('server_default') }),
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('after_minutes'), minutes: z.number().positive() }),
])
export type IdleFold = z.infer<typeof IdleFold>

const preferenceSchemas = {
  requireFaceId: z.boolean(),
  idleFold: IdleFold,
  modelAvatars: z.boolean(),
  /** Servers already asked to connect Claude during onboarding: asked once per server. */
  claudeAskedServerIds: z.array(z.string()),
  /** The one server updates come from, chosen apart from the active one. Null: the built-in version only. */
  updateHomeServerId: z.string().nullable(),
}

export type Preferences = { [K in keyof typeof preferenceSchemas]: z.infer<(typeof preferenceSchemas)[K]> }

export const DEFAULT_PREFERENCES: Preferences = {
  requireFaceId: false,
  idleFold: { kind: 'server_default' },
  modelAvatars: true,
  claudeAskedServerIds: [],
  updateHomeServerId: null,
}

export class PreferencesStore {
  private readonly storage: SecureStorage
  private readonly ids: IdSource
  private values: Preferences = { ...DEFAULT_PREFERENCES }
  private damaged = false
  private loadedOk = false
  private listeners = new Set<() => void>()

  constructor(storage: SecureStorage, ids: IdSource) {
    this.storage = storage
    this.ids = ids
  }

  get needsRecovery() { return this.damaged }
  get current(): Readonly<Preferences> { return this.values }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed() { for (const listener of this.listeners) listener() }

  /** A read that rejects rejects here, and writes stay blocked: unknown isn't the same as empty. */
  async load() {
    this.loadedOk = false
    const raw = await this.storage.read(PREFERENCES_KEY)
    const { values, damaged } = interpretStoredPreferences(raw)
    this.values = values
    this.damaged = damaged
    this.loadedOk = true
    this.changed()
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    this.values = { ...this.values, [key]: value }
    this.changed()
    if (this.loadedOk && !this.damaged) void this.storage.write(PREFERENCES_KEY, JSON.stringify(this.values)).catch(() => {})
  }

  /** Keeps a valid Face ID setting, so resetting unrelated damage can't quietly unlock the app, and the update home, so
   * it can't quietly stop updates. */
  async resetDamaged() {
    await saveRecoveryCopy(this.storage, this.ids, PREFERENCES_KEY)
    const { requireFaceId, updateHomeServerId } = this.values
    const next: Preferences = { ...DEFAULT_PREFERENCES, requireFaceId, updateHomeServerId }
    await this.storage.write(PREFERENCES_KEY, JSON.stringify(next))
    this.values = next
    this.damaged = false
    this.loadedOk = true
    this.changed()
  }
}

function interpretStoredPreferences(raw: string | null): { values: Preferences; damaged: boolean } {
  if (raw === null) return { values: { ...DEFAULT_PREFERENCES }, damaged: false }
  let stored: unknown
  try { stored = JSON.parse(raw) } catch { return { values: { ...DEFAULT_PREFERENCES }, damaged: true } }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return { values: { ...DEFAULT_PREFERENCES }, damaged: true }
  const record = stored as Record<string, unknown>
  const values: Preferences = { ...DEFAULT_PREFERENCES }
  let damaged = false
  for (const key of Object.keys(preferenceSchemas) as (keyof Preferences)[]) {
    if (!(key in record)) continue
    const parsed = preferenceSchemas[key].safeParse(record[key])
    if (parsed.success) (values as Record<string, unknown>)[key] = parsed.data
    else damaged = true
  }
  return { values, damaged }
}
