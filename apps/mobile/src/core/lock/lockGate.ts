// Face ID lock: when required, the app is covered at launch and again after any time in the background, until the
// person unlocks it. It prompts by itself at launch and on coming back; a failed or cancelled prompt leaves the cover.
// While the app isn't the active one it is also shielded, without needing Face ID to remove: that is what iOS snapshots
// for the app switcher, and a brief look away (Notification Centre, the Face ID prompt itself) shouldn't demand a prompt.
import type { AppLifecycle } from '../platform/ports.ts'

export class LockGate {
  private readonly lifecycle: AppLifecycle
  private readonly required: () => boolean
  private readonly authenticate: () => Promise<boolean>
  private isLocked = false
  private isShielded = false
  private prompting = false
  private listeners = new Set<() => void>()
  private cleanups: (() => void)[] = []

  constructor(deps: { lifecycle: AppLifecycle; required: () => boolean; authenticate: () => Promise<boolean> }) {
    this.lifecycle = deps.lifecycle
    this.required = deps.required
    this.authenticate = deps.authenticate
  }

  /** Needs Face ID to remove. */
  get locked() { return this.isLocked }
  /** Whether anything hides the app now: locked, or shielded while switched away. */
  get covered() { return this.isLocked || this.isShielded }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Once the preference that requires it has been read. */
  start() {
    this.setLocked(this.required())
    this.cleanups.push(this.lifecycle.onSwitchingAway(() => { if (this.required()) this.setShielded(true) }))
    this.cleanups.push(this.lifecycle.onBackground(() => { if (this.required()) this.setLocked(true) }))
    this.cleanups.push(this.lifecycle.onActiveAgain(() => this.setShielded(false)))
    // Only a return from the background prompts: a cancelled prompt also ends in "active", and must not reprompt.
    this.cleanups.push(this.lifecycle.onForeground(() => { void this.unlock() }))
    void this.unlock()
  }

  stop() {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  /** Prompts if covered. One prompt at a time: a second tap while the system prompt is up does nothing. */
  async unlock() {
    if (!this.isLocked || this.prompting) return
    this.prompting = true
    const passed = await this.authenticate().catch(() => false)
    this.prompting = false
    if (passed) this.setLocked(false)
  }

  private setLocked(locked: boolean) {
    if (locked === this.isLocked) return
    this.isLocked = locked
    this.changed()
  }

  private setShielded(shielded: boolean) {
    if (shielded === this.isShielded) return
    this.isShielded = shielded
    this.changed()
  }

  private changed() { for (const listener of this.listeners) listener() }
}
