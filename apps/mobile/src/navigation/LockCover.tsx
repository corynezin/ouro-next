// The Face ID cover (Settings → Require Face ID). On a binary with the lock window module it is a native window above
// everything, open sheets included. On an older binary it is a view over the root, which UIKit's sheets sit above: so
// when the app locks, open sheets are closed first and reopened after unlocking, and the shield while switching away
// (the app-switcher snapshot) can't hide a sheet that is still open.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { NavigationState } from '@react-navigation/native'
import type { LockGate } from '../core/lock/lockGate.ts'
import { C } from '../design/colors.ts'
import { Symbol } from '../design/Symbol.tsx'
import { lockWindow } from '../native/lockWindow.ts'
import type { LockWindow } from '../native/lockWindow.ts'
import { useCore } from './coreContext.tsx'
import { navigationRef } from './navigationRef.ts'
import { withoutSheets } from './sheets.ts'

export function LockCover({ gate }: { gate: LockGate }) {
  return lockWindow ? <WindowLockCover gate={gate} window={lockWindow} /> : <ViewLockCover gate={gate} />
}

/** Follows the gate straight from its listener, not after a render, so the shield is up before iOS takes the snapshot. */
function WindowLockCover({ gate, window }: { gate: LockGate; window: LockWindow }) {
  useEffect(() => {
    const follow = () => {
      if (gate.covered) window.show(gate.locked)
      else window.hide()
    }
    follow()
    const unsubscribe = gate.subscribe(follow)
    const unlockPresses = window.addListener('onUnlockPress', () => { void gate.unlock() })
    return () => {
      unsubscribe()
      unlockPresses.remove()
      window.hide()
    }
  }, [gate, window])
  return null
}

function ViewLockCover({ gate }: { gate: LockGate }) {
  const subscribe = useCallback((listener: () => void) => gate.subscribe(listener), [gate])
  const covered = useSyncExternalStore(subscribe, () => gate.covered)
  const locked = useSyncExternalStore(subscribe, () => gate.locked)
  useSheetsClosedWhileLocked(gate)
  if (!covered) return null
  return (
    <View style={[StyleSheet.absoluteFill, s.cover]} accessibilityViewIsModal>
      <Symbol name="lock.fill" size={40} color="secondary" />
      <Text style={s.title}>Ouro is locked</Text>
      {locked && (
        <Pressable onPress={() => { void gate.unlock() }} style={s.button} accessibilityRole="button">
          <Text style={{ color: 'white', fontWeight: '600', fontSize: 16 }}>Unlock with Face ID</Text>
        </Pressable>
      )}
    </View>
  )
}

/** The stack as it was when the app locked, reopened on unlock if the same server is still on screen. */
function useSheetsClosedWhileLocked(gate: LockGate) {
  const core = useCore()
  useEffect(() => {
    let toReopen: { serverId: string; state: NavigationState } | null = null
    return gate.subscribe(() => {
      if (gate.locked && toReopen === null) {
        const serverId = core.activeSession?.serverId
        if (!serverId || !navigationRef.isReady()) return
        const state = navigationRef.getRootState()
        const closed = state ? withoutSheets(state) : null
        if (!state || !closed) return
        toReopen = { serverId, state }
        navigationRef.resetRoot(closed)
      } else if (!gate.locked && toReopen !== null) {
        const { serverId, state } = toReopen
        toReopen = null
        if (core.activeSession?.serverId === serverId && navigationRef.isReady()) navigationRef.resetRoot(state)
      }
    })
  }, [gate, core])
}

const s = StyleSheet.create({
  cover: { backgroundColor: C.background, alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 1000 },
  title: { fontSize: 20, fontWeight: '600', color: C.label },
  button: { backgroundColor: C.blue, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
})
