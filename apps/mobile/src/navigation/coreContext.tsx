// How screens reach the core. A screen reads the session's store, and renders again when any of it changes; a Screen's
// model call is memoized on the version this returns, so a burst of changes is one render.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppCore } from '../core/appCore.ts'
import type { HostedServers } from '../core/hub/hostedServers.ts'
import type { PushCenter } from '../core/push/pushCenter.ts'
import type { OtherServersUnread } from '../core/servers/otherServersUnread.ts'
import type { ServerSession } from '../core/session/serverSession.ts'

const CoreContext = createContext<AppCore | null>(null)
export const CoreProvider = CoreContext.Provider
export function useCore() {
  const core = useContext(CoreContext)
  if (!core) throw new Error('useCore outside CoreProvider')
  return core
}

const PushContext = createContext<PushCenter | null>(null)
export const PushProvider = PushContext.Provider
export function usePush() {
  const push = useContext(PushContext)
  if (!push) throw new Error('usePush outside PushProvider')
  return push
}

const HostedServersContext = createContext<HostedServers | null>(null)
export const HostedServersProvider = HostedServersContext.Provider
export function useHostedServers() {
  const hosted = useContext(HostedServersContext)
  if (!hosted) throw new Error('useHostedServers outside HostedServersProvider')
  return hosted
}

export function useHub() {
  return useHostedServers().api
}

const OtherServersUnreadContext = createContext<OtherServersUnread | null>(null)
export const OtherServersUnreadProvider = OtherServersUnreadContext.Provider
/** Renders again when a check starts or ends. */
export function useOtherServersUnread() {
  const unread = useContext(OtherServersUnreadContext)
  if (!unread) throw new Error('useOtherServersUnread outside OtherServersUnreadProvider')
  const subscribe = useCallback((listener: () => void) => unread.subscribe(listener), [unread])
  useSyncExternalStore(subscribe, () => unread.checking)
  return unread
}

const SessionContext = createContext<ServerSession | null>(null)
export const SessionProvider = SessionContext.Provider
export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionProvider')
  return session
}

/** Moves on whenever the core's own state changes: startup, the active server, the account, preferences. */
export function useCoreVersion(core: AppCore) {
  const version = useRef(0)
  const subscribe = useCallback((listener: () => void) => {
    const changed = () => { version.current++; listener() }
    const unsubscribers = [core.subscribe(changed), core.preferences.subscribe(changed)]
    return () => { for (const unsubscribe of unsubscribers) unsubscribe() }
  }, [core])
  return useSyncExternalStore(subscribe, () => version.current)
}

/** Moves on whenever anything a screen could show from this session changes: entities, sends, connection. */
export function useSessionVersion(session: ServerSession) {
  const version = useRef(0)
  const subscribe = useCallback((listener: () => void) => {
    const changed = () => { version.current++; listener() }
    const unsubscribers = [session.store.subscribe(changed), session.outbox.subscribe(changed), session.subscribeToConnection(changed)]
    return () => { for (const unsubscribe of unsubscribers) unsubscribe() }
  }, [session])
  return useSyncExternalStore(subscribe, () => version.current)
}

/** The time, moved on every `intervalMs`, for "5m" and timers. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
