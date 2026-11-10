// What the Pair form's fields amount to. Pure: Screen.tsx only draws it.
import { parsePairLink, serverUrlFromInput } from '../../core/accounts/pairing.ts'

export const NOTHING_USABLE_TO_PAIR_WITH = 'Paste the pairing link (ouronext://pair?…), or enter the address and code.'

/** The link if it's one; otherwise the address and code. */
export function pairingTarget(form: { link: string; address: string; code: string }): { url: string; code: string } | null {
  const fromLink = parsePairLink(form.link)
  if (fromLink) return fromLink
  const url = serverUrlFromInput(form.address)
  const code = form.code.trim()
  return url && code ? { url, code } : null
}

/**
 * One pairing at a time. A code works once, so a second tap while one is under way (or a tap the test driver repeats
 * when the system's paste prompt hides the change) must not send it again and spend it.
 */
export class PairingGate {
  private underWay = false

  /** False when one was already under way, and this one wasn't tried. */
  async run(attempt: () => Promise<void>): Promise<boolean> {
    if (this.underWay) return false
    this.underWay = true
    try {
      await attempt()
      return true
    } finally {
      this.underWay = false
    }
  }
}
