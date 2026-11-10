// The person's account with the hosted service, if they signed up with an invite. Someone running their own server has none.
import { z } from 'zod'
import type { SecureStorage } from '../platform/ports.ts'

const ACCOUNT_KEY = 'ouronext.account'

/** What sign-up gave: `SignupResult` from the hub contract. */
const HostedAccountSchema = z.object({ accountId: z.string(), token: z.string(), name: z.string() })
export type HostedAccount = z.infer<typeof HostedAccountSchema>

export class HostedAccountStore {
  private readonly storage: SecureStorage
  constructor(storage: SecureStorage) { this.storage = storage }

  /** An unreadable account reads as none. Nothing is deleted, and signing up again replaces it. */
  async load(): Promise<HostedAccount | null> {
    const raw = await this.storage.read(ACCOUNT_KEY).catch(() => null)
    if (raw === null) return null
    try { return HostedAccountSchema.parse(JSON.parse(raw)) } catch { return null }
  }

  async save(account: HostedAccount | null) {
    if (account) await this.storage.write(ACCOUNT_KEY, JSON.stringify(account))
    else await this.storage.remove(ACCOUNT_KEY)
  }
}
