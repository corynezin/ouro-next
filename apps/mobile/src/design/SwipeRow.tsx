// A list row with swipe actions on the trailing edge (as SwiftUI .swipeActions), tinted buttons.
import { useRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import * as Haptics from 'expo-haptics'
import { C } from './colors.ts'

export interface SwipeAction { title: string; color: ColorValue; onPress: () => void }

export function SwipeRow({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const ref = useRef<SwipeableMethods>(null)
  if (!actions.length) return <>{children}</>
  return (
    <ReanimatedSwipeable ref={ref} friction={1.5} childrenContainerStyle={{ backgroundColor: C.background }} rightThreshold={40} overshootRight={false}
      onSwipeableWillOpen={() => Haptics.selectionAsync()}
      renderRightActions={() => (
        <View style={s.actions}>
          {actions.map((a) => (
            <Pressable key={a.title} style={[s.action, { backgroundColor: a.color }]}
              onPress={() => { ref.current?.close(); a.onPress() }}>
              <Text style={s.title} numberOfLines={2}>{a.title}</Text>
            </Pressable>
          ))}
        </View>
      )}>
      {children}
    </ReanimatedSwipeable>
  )
}

const s = StyleSheet.create({
  actions: { flexDirection: 'row' },
  action: { width: 84, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  title: { color: 'white', fontWeight: '600', fontSize: 14, textAlign: 'center' },
})
