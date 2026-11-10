// Links the app is opened with: what each one does, and holding them until startup has read the server list, since
// whether a pair link pairs at once or opens the Pair form depends on whether there is a server to switch from.
import { parseInviteLink, parsePairLink } from '../core/accounts/pairing.ts'

export type OpenedLinkAction =
  | { kind: 'pair_and_switch'; url: string; code: string }
  | { kind: 'open_pair_form'; link: string }
  | { kind: 'fill_invite_code'; code: string }

/** Null for a link that isn't ours. */
export function openedLinkAction(link: string, hasActiveServer: boolean): OpenedLinkAction | null {
  const target = parsePairLink(link)
  if (target) return hasActiveServer ? { kind: 'pair_and_switch', ...target } : { kind: 'open_pair_form', link }
  const code = parseInviteLink(link)
  return code ? { kind: 'fill_invite_code', code } : null
}

/** Each link handled once: at once after startup, or, arriving during it, as soon as it has read the server list. */
export class OpenedLinks {
  private readonly waiting: string[] = []
  private startupRead = false
  private readonly handle: (link: string) => void

  constructor(handle: (link: string) => void) {
    this.handle = handle
  }

  arrived(link: string) {
    if (this.startupRead) this.handle(link)
    else this.waiting.push(link)
  }

  startupFinished() {
    if (this.startupRead) return
    this.startupRead = true
    for (const link of this.waiting.splice(0)) this.handle(link)
  }
}
