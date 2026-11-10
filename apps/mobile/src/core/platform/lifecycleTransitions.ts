// The app's state changes as the transitions the ports name. A system prompt (Face ID, permissions) or a glance at
// Notification Centre goes active → inactive → active: that is not a return to the foreground, and treating it as one
// made a cancelled Face ID prompt reappear at once.

export type AppStateName = 'active' | 'inactive' | 'background'
export type LifecycleTransition = 'foreground' | 'background' | 'switching_away' | 'active_again'

export function transitionsOf(previous: AppStateName, next: AppStateName): LifecycleTransition[] {
  const fired: LifecycleTransition[] = []
  if (previous === 'active' && next !== 'active') fired.push('switching_away')
  if (next === 'background' && previous !== 'background') fired.push('background')
  if (next === 'active' && previous !== 'active') fired.push('active_again')
  if (next === 'active' && previous === 'background') fired.push('foreground')
  return fired
}
