// Pieces the account screens share: the provider's entity as the server last checked it, and a field for a pasted secret.
import { StyleSheet, TextInput } from 'react-native'
import type { IntegrationEntity, IntegrationProvider } from '@ouro/contract'
import { C } from '../../design/colors.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'

/** Null until the server has first checked the provider. Changes arrive with sync, so a screen never reloads it. */
export function useIntegration<P extends IntegrationProvider>(provider: P): Extract<IntegrationEntity, { provider: P }> | null {
  const session = useSession()
  useSessionVersion(session)
  return session.store.integration(provider)
}

export function SecretField({ value, onChange, placeholder, onSubmit }: { value: string; onChange: (text: string) => void; placeholder: string; onSubmit: () => void }) {
  return (
    <TextInput style={s.input} placeholder={placeholder} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false}
      secureTextEntry returnKeyType="done" onSubmitEditing={onSubmit} placeholderTextColor={C.tertiary} />
  )
}

const s = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.opaqueSeparator, borderRadius: 10, padding: 12, fontSize: 16, color: C.label, fontFamily: 'Menlo' },
})
