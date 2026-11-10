// The servers this phone is paired with. The list and tokens are separate keychain items, so a damaged list can't lose a
// token. Damage is never fixed silently: usable entries stay usable, changes are refused until the person resets it, and
// resetting saves a recovery copy first and leaves tokens alone.
import { z } from 'zod'
import type { IdSource, SecureStorage } from '../platform/ports.ts'
import { saveRecoveryCopy } from './recoveryCopy.ts'

const SERVER_LIST_KEY = 'ouronext.servers'
const ACTIVE_SERVER_KEY = 'ouronext.activeServer'
const tokenKey = (serverId: string) => `ouronext.server.${serverId}.token`

const SavedServerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  label: z.string(),
  url: z.url({ protocol: /^https?$/ }),
  deviceName: z.string(),
  deviceId: z.string(),
  /** Whose phone this is on that server. */
  personName: z.string().nullable(),
  /** The hosted-service server this came from. Null for a server the person runs themselves. */
  hostedServerId: z.string().nullable(),
})
export type SavedServer = z.infer<typeof SavedServerSchema>

export interface ServerWithToken { server: SavedServer; token: string }

/** Changes to a damaged list are refused, because writing would replace what recovery still needs. */
export const SERVER_LIST_DAMAGED_PAIRING = 'Reset the damaged server list from the recovery warning before pairing.'

export class ServerListDamaged extends Error {
  constructor(message = 'Saved server list needs recovery. Reset it from the recovery warning before making changes.') { super(message) }
}

const withoutTrailingSlashes = (url: string) => url.replace(/\/+$/, '')

export class SavedServers {
  private readonly storage: SecureStorage
  private readonly ids: IdSource
  private damaged = false

  constructor(storage: SecureStorage, ids: IdSource) {
    this.storage = storage
    this.ids = ids
  }

  get needsRecovery() { return this.damaged }

  /** Everything usable. A read that rejects rejects here too: unknown isn't the same as empty. */
  async list(): Promise<SavedServer[]> {
    const raw = await this.storage.read(SERVER_LIST_KEY)
    if (raw === null) {
      this.damaged = false
      return []
    }
    const { servers, damaged } = interpretStoredList(raw)
    this.damaged = damaged
    return servers
  }

  private async write(servers: SavedServer[]) {
    await this.list()
    if (this.damaged) throw new ServerListDamaged()
    await this.storage.write(SERVER_LIST_KEY, JSON.stringify(servers))
  }

  /** Pairing the same address again replaces that entry and its token, and it becomes active. */
  async add(paired: { url: string; token: string; deviceName: string; deviceId: string; personName: string | null }, details: { label?: string; hostedServerId?: string } = {}): Promise<SavedServer> {
    const servers = await this.list()
    if (this.damaged) throw new ServerListDamaged(SERVER_LIST_DAMAGED_PAIRING)
    const existing = servers.find((s) => withoutTrailingSlashes(s.url) === withoutTrailingSlashes(paired.url))
    const id = existing?.id ?? this.ids.newId()
    const server: SavedServer = {
      id,
      label: details.label ?? existing?.label ?? labelFromUrl(paired.url),
      url: paired.url,
      deviceName: paired.deviceName,
      deviceId: paired.deviceId,
      personName: paired.personName,
      hostedServerId: details.hostedServerId ?? existing?.hostedServerId ?? null,
    }
    await this.storage.write(tokenKey(id), paired.token)
    await this.write(existing ? servers.map((s) => (s.id === id ? server : s)) : [...servers, server])
    await this.setActiveId(id)
    return server
  }

  async rename(id: string, label: string) {
    const servers = await this.list()
    await this.write(servers.map((s) => (s.id === id ? { ...s, label } : s)))
  }

  /** Forgets it on this phone only. The token goes last, after the list no longer points at it. */
  async remove(id: string) {
    const servers = await this.list()
    const remaining = servers.filter((s) => s.id !== id)
    await this.write(remaining)
    await this.storage.remove(tokenKey(id))
    if (await this.activeId() === id) await this.setActiveId(remaining[0]?.id ?? null)
  }

  async removeAll() {
    const servers = await this.list()
    if (this.damaged) throw new ServerListDamaged('Reset the damaged server list before signing out.')
    for (const server of servers) await this.storage.remove(tokenKey(server.id))
    await this.write([])
    await this.setActiveId(null)
  }

  activeId() { return this.storage.read(ACTIVE_SERVER_KEY) }

  async setActiveId(id: string | null) {
    if (id === null) await this.storage.remove(ACTIVE_SERVER_KEY)
    else await this.storage.write(ACTIVE_SERVER_KEY, id)
  }

  async tokenOf(serverId: string): Promise<string | null> {
    const token = await this.storage.read(tokenKey(serverId))
    return token?.trim() ? token : null
  }

  async withToken(server: SavedServer): Promise<ServerWithToken | null> {
    const token = await this.tokenOf(server.id)
    return token === null ? null : { server, token }
  }

  /** The active server, or else the first other one with a usable token, so a working phone is never stranded. */
  async firstUsable(): Promise<ServerWithToken | null> {
    const activeId = await this.activeId()
    const servers = await this.list()
    const ordered = [...servers.filter((s) => s.id === activeId), ...servers.filter((s) => s.id !== activeId)]
    for (const server of ordered) {
      const usable = await this.withToken(server)
      if (usable) return usable
    }
    return null
  }

  /** The person's explicit reset. A failed backup leaves everything as it was. */
  async resetDamagedList() {
    await saveRecoveryCopy(this.storage, this.ids, SERVER_LIST_KEY)
    await this.storage.write(SERVER_LIST_KEY, '[]')
    await this.setActiveId(null)
    this.damaged = false
  }
}

function interpretStoredList(raw: string): { servers: SavedServer[]; damaged: boolean } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { servers: [], damaged: true } }
  if (!Array.isArray(value)) return { servers: [], damaged: true }
  const valid = value.flatMap((item) => {
    const parsed = SavedServerSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  // Ambiguous duplicate ids must not select another server's token.
  const servers = valid.filter((server) => valid.filter((s) => s.id === server.id).length === 1)
  return { servers, damaged: servers.length !== value.length }
}

export function labelFromUrl(url: string) {
  try { return new URL(url).host || url } catch { return url }
}
