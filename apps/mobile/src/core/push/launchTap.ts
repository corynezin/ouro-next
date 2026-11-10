// The notification tap that launched the app. iOS keeps reporting it for as long as the process lives, and a restart into
// a downloaded update is the same process, so a tap handled once would open its chat again after the update.
export interface LaunchTapSource<Tap> {
  /** The tap that launched the app, until cleared. */
  last(): Tap | null
  clear(): void
}

/** The launching tap, once: it is cleared before it is handled, so a handler that restarts can't see it again. */
export function takeLaunchTap<Tap>(source: LaunchTapSource<Tap>): Tap | null {
  const tap = source.last()
  if (tap !== null) source.clear()
  return tap
}
