// The Face ID cover's own window (modules/lock-window), above sheets and alerts. Null on a binary built before the
// module existed: an update can reach those, and there the cover is a view and sheets close while locked.
import { requireOptionalNativeModule } from 'expo'
import { NativeModule } from 'expo'

type LockWindowEvents = { onUnlockPress: () => void }

export declare class LockWindow extends NativeModule<LockWindowEvents> {
  /** Shows the cover, or updates the one showing. The Unlock button shows only when `unlockable`. */
  show(unlockable: boolean): void
  hide(): void
}

export const lockWindow = requireOptionalNativeModule<LockWindow>('LockWindow')
