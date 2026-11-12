// A status that changes faster than it can be read flickers: an agent goes "running Bash" → "thinking" → "running Bash"
// within a second, many times a minute. A steady value shows every change, but holds each one at least `HOLD_MS`; a change
// that arrives sooner waits, and only the latest waiting one is shown when the hold ends. So a blip that comes and goes
// within the hold never shows, the first change after a quiet spell shows at once, and the shown value is never more
// than `HOLD_MS` behind.
import { useEffect, useRef, useState } from 'react'

export const HOLD_MS = 1500

export interface Steady<T> {
  shown: T
  shownAt: number
  /** The latest value whose key differs from what's shown, waiting for the hold to end. */
  pending: T | null
}

export const steadyStart = <T>(value: T, now: number): Steady<T> => ({ shown: value, shownAt: now, pending: null })

/**
 * Take in the current value. A value with the shown key replaces it in place (its details, such as a timer, stay live)
 * and drops any waiting change: the blip is over.
 */
export function steadyPush<T>(state: Steady<T>, value: T, key: (value: T) => string, now: number): Steady<T> {
  if (key(value) === key(state.shown)) return { shown: value, shownAt: state.shownAt, pending: null }
  if (now - state.shownAt >= HOLD_MS) return { shown: value, shownAt: now, pending: null }
  return { ...state, pending: value }
}

/** Show the waiting change once the hold is over. */
export function steadyTick<T>(state: Steady<T>, now: number): Steady<T> {
  if (state.pending === null || now - state.shownAt < HOLD_MS) return state
  return { shown: state.pending, shownAt: now, pending: null }
}

/** When `steadyTick` next has something to do, or null. */
export const steadyWakeAt = <T>(state: Steady<T>): number | null => (state.pending === null ? null : state.shownAt + HOLD_MS)

/** `value`, held steady by `key`: what a component shows in place of a fast-changing status. */
export function useSteady<T>(value: T, key: (value: T) => string): T {
  const state = useRef<Steady<T> | null>(null)
  const [, rerender] = useState(0)
  state.current = state.current === null ? steadyStart(value, Date.now()) : steadyPush(state.current, value, key, Date.now())
  const wakeAt = steadyWakeAt(state.current)
  useEffect(() => {
    if (wakeAt === null) return
    const timer = setTimeout(() => {
      if (state.current === null) return
      state.current = steadyTick(state.current, Date.now())
      rerender((n) => n + 1)
    }, Math.max(0, wakeAt - Date.now()))
    return () => clearTimeout(timer)
  }, [wakeAt])
  return state.current.shown
}
