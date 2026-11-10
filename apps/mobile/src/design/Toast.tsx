// A short message over everything ("Copied"), as the Lab's Bridge.toast.
import { useEffect, useState } from 'react'
import { Animated, Platform, StyleSheet, Text, View } from 'react-native'
import { FullWindowOverlay } from 'react-native-screens'
import { Symbol } from './Symbol.tsx'

let show: ((text: string, symbol: string) => void) | null = null
export const toast = (text: string, symbol = 'checkmark.circle.fill') => show?.(text, symbol)

export function ToastHost() {
  const [t, setT] = useState<{ text: string; symbol: string; key: number } | null>(null)
  const [opacity] = useState(() => new Animated.Value(0))
  useEffect(() => { show = (text, symbol) => setT({ text, symbol, key: Date.now() }); return () => { show = null } }, [])
  useEffect(() => {
    if (!t) return
    opacity.setValue(0)
    Animated.sequence([Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }), Animated.delay(1200),
      Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true })]).start(() => setT(null))
  }, [t?.key])
  if (!t) return null
  const content = (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[s.toast, { opacity }]}>
        <Symbol name={t.symbol} size={16} color="white" />
        <Text style={s.text}>{t.text}</Text>
      </Animated.View>
    </View>
  )
  // On iOS a modal sheet is its own view controller above the root view, so a toast shown from a sheet ("ChatGPT
  // connected" in Settings) would sit behind it. The overlay is a window above every sheet. Android's sheets are not.
  return Platform.OS === 'ios' ? <FullWindowOverlay>{content}</FullWindowOverlay> : content
}

const s = StyleSheet.create({
  toast: { position: 'absolute', top: 70, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(40,40,40,0.92)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22 },
  text: { color: 'white', fontWeight: '600', fontSize: 15 },
})
