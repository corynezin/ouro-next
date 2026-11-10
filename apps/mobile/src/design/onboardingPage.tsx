// The full-screen onboarding pages (Welcome, Setup, Connect Claude): centred, scrollable above the keyboard, with one
// primary button and quieter links.
import type { ReactNode } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { C } from './colors.ts'
import { accent } from './theme.ts'

export function Page({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.background }}>
      <ScrollView contentContainerStyle={[pageStyles.wrap, { paddingTop: 24, paddingBottom: 24 }]} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </KeyboardAvoidingView>
  )
}

export const Primary = ({ title, onPress, busy, disabled }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean }) => (
  <Pressable style={[pageStyles.button, { backgroundColor: accent, opacity: disabled ? 0.4 : 1 }]} onPress={onPress} disabled={busy || disabled}>
    {busy ? <ActivityIndicator color="white" /> : <Text style={pageStyles.buttonText}>{title}</Text>}
  </Pressable>
)

export const Secondary = ({ title, onPress }: { title: string; onPress: () => void }) => (
  <Pressable style={pageStyles.secondary} onPress={onPress}><Text style={{ color: accent, fontSize: 15 }}>{title}</Text></Pressable>
)

export const pageStyles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 30, fontWeight: '700', color: C.label },
  titleInline: { fontSize: 22, fontWeight: '700', color: C.label },
  body: { fontSize: 16, color: C.secondary, lineHeight: 22 },
  small: { fontSize: 13, color: C.secondary },
  label: { fontSize: 13, color: C.secondary, marginTop: 8, marginBottom: -6 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.opaqueSeparator, borderRadius: 10, padding: 12, fontSize: 16, color: C.label },
  secondary: { alignItems: 'center', padding: 8 },
  button: { borderRadius: 12, padding: 15, alignItems: 'center', marginTop: 4 },
  buttonText: { color: 'white', fontWeight: '600', fontSize: 17 },
  error: { color: C.red },
})
