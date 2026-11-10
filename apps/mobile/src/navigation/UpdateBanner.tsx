// "A new version is ready": above the navigation, below the status bar. Its height is shared so screens that pad for the
// keyboard can add it, as the banner pushes them down.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { restartBannerText } from '../core/updates/updateFlow.ts'
import type { UpdateFlow } from '../core/updates/updateFlow.ts'
import { accent } from '../design/theme.ts'

const UpdateFlowContext = createContext<UpdateFlow | null>(null)
export const UpdateFlowProvider = UpdateFlowContext.Provider
export function useUpdateFlow() {
  const flow = useContext(UpdateFlowContext)
  if (!flow) throw new Error('useUpdateFlow outside UpdateFlowProvider')
  return flow
}

const BannerHeight = createContext(0)
export const BannerHeightProvider = ({ height, children }: { height: number; children: ReactNode }) => <BannerHeight.Provider value={height}>{children}</BannerHeight.Provider>
export const useBannerHeight = () => useContext(BannerHeight)

export function useReadyToRestart(flow: UpdateFlow) {
  const subscribe = useCallback((listener: () => void) => flow.subscribe(listener), [flow])
  return useSyncExternalStore(subscribe, () => flow.readyToRestart)
}

function useRestartState(flow: UpdateFlow) {
  const subscribe = useCallback((listener: () => void) => flow.subscribe(listener), [flow])
  return useSyncExternalStore(subscribe, () => flow.restartState)
}

export function UpdateBanner({ flow, onHeight }: { flow: UpdateFlow; onHeight: (height: number) => void }) {
  const ready = useReadyToRestart(flow)
  const restart = useRestartState(flow)
  const top = useSafeAreaInsets().top
  if (!ready) return null
  const text = restartBannerText(restart)
  // The status-bar inset is the outer view's, not the button's: a button that included it would have its centre under
  // the status bar and Dynamic Island, where a tap aimed at the button (Maestro's, VoiceOver's) does nothing.
  return (
    <View onLayout={(event) => onHeight(event.nativeEvent.layout.height)} style={{ backgroundColor: accent, paddingTop: top }}>
      <Pressable onPress={() => { void flow.restartKeepingPlace() }} disabled={restart.kind === 'restarting'} accessibilityRole="button" accessibilityLabel={text}
        style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10 }}>
        <Text style={{ color: 'white', textAlign: 'center', fontWeight: '600' }}>{text}</Text>
      </Pressable>
    </View>
  )
}
