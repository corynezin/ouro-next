// A status that isn't synced, asked of its own route as the screen opens and again each time it comes back into view
// (from that status's own screen, say).
import { useEffect, useState } from 'react'
import type { ApiResult } from '../../core/session/serverApi.ts'
import type { RouteStatus } from './model.ts'

/** `load`: how to ask, kept stable by the caller; null when this viewer isn't shown it, which leaves it checking. */
export function useRouteStatus<T>(navigation: { addListener: (event: 'focus', listener: () => void) => () => void }, load: (() => Promise<ApiResult<T>>) | null): RouteStatus<T> {
  const [status, setStatus] = useState<RouteStatus<T>>({ kind: 'checking' })
  useEffect(() => {
    if (load === null) return undefined
    const ask = () => { void load().then((result) => setStatus(result.ok ? { kind: 'loaded', value: result.value } : { kind: 'failed' })) }
    ask()
    return navigation.addListener('focus', ask)
  }, [navigation, load])
  return status
}
