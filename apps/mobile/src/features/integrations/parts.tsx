// Pieces the account screens share: the provider's entity as the server last checked it, and a field for a pasted secret.
import { StyleSheet, TextInput } from 'react-native'
import { RNHostView } from '@expo/ui/swift-ui'
import type { IntegrationEntity, IntegrationProvider } from '@ouro/contract'
import { C } from '../../design/colors.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'

/** Null until the server has first checked the provider. Changes arrive with sync, so a screen never reloads it. */
export function useIntegration<P extends IntegrationProvider>(provider: P): Extract<IntegrationEntity, { provider: P }> | null {
  const session = useSession()
  useSessionVersion(session)
  return session.store.integration(provider)
}

interface KeyFieldProps { value: string; onChange: (text: string) => void; placeholder: string; onSubmit: () => void }

/** A field for a pasted secret, hidden as it is typed. */
export const SecretField = (props: KeyFieldProps) => <HostedField {...props} secure />

/** A field for the parts of a key that aren't secret, like its id or region: shown as typed. */
export const PlainKeyField = (props: KeyFieldProps) => <HostedField {...props} secure={false} />

/** Hosted so its width comes from the form row; a bare TextInput there grows with its text and runs off screen. */
function HostedField({ value, onChange, placeholder, onSubmit, secure }: KeyFieldProps & { secure: boolean }) {
  return (
    <RNHostView matchContents={{ vertical: true }}>
      <TextInput style={s.input} placeholder={placeholder} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false}
        secureTextEntry={secure} returnKeyType="done" onSubmitEditing={onSubmit} placeholderTextColor={C.tertiary} />
    </RNHostView>
  )
}

const s = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.opaqueSeparator, borderRadius: 10, padding: 12, fontSize: 16, color: C.label, fontFamily: 'Menlo' },
})
