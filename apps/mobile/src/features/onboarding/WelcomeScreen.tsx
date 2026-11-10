// A new person's first screen: an invite code and a name, or pairing with a server of their own. Renders onboarding/model.ts.
import { useEffect, useState } from 'react'
import { Image, Text, TextInput, View } from 'react-native'
import { C } from '../../design/colors.ts'
import { Page, pageStyles as s, Primary, Secondary } from '../../design/onboardingPage.tsx'
import { useCore, useHub } from '../../navigation/coreContext.tsx'
import { signupFailureText, signupRequestOf, WELCOME_COPY } from './model.ts'

/** `invitedCode`: from the last invite link opened. */
export function WelcomeScreen({ invitedCode, onChoosePair }: { invitedCode: string | null; onChoosePair: () => void }) {
  const core = useCore()
  const hub = useHub()
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // An invite link opened while this shows fills the code in.
  useEffect(() => { if (invitedCode) setInvite(invitedCode) }, [invitedCode])

  const signUp = async () => {
    const checked = signupRequestOf(invite, name)
    if ('error' in checked) return setError(checked.error)
    setBusy(true)
    setError('')
    const answer = await hub.signup(checked.request)
    if (!answer.ok) {
      setBusy(false)
      return setError(signupFailureText(answer.failure))
    }
    // Setup takes over from here; this screen goes away.
    await core.saveHostedAccount(answer.value).catch(() => {
      setBusy(false)
      setError(WELCOME_COPY.saveFailed)
    })
  }

  return (
    <Page>
      <Image source={require('../../../assets/icon.png')} style={{ width: 88, height: 88, borderRadius: 20, marginBottom: 4 }} accessibilityLabel="Ouro logo" />
      <Text style={s.title}>Ouro</Text>
      <Text style={s.body}>{WELCOME_COPY.pitch}</Text>
      <Text style={s.label}>Invite code</Text>
      <TextInput style={s.input} placeholder="from the person who invited you" value={invite} onChangeText={setInvite}
        autoCapitalize="none" autoCorrect={false} returnKeyType="next" placeholderTextColor={C.tertiary} />
      <Text style={s.label}>Your name</Text>
      <TextInput style={s.input} placeholder="Alex" value={name} onChangeText={setName} autoCorrect={false}
        textContentType="givenName" returnKeyType="go" onSubmitEditing={() => { void signUp() }} placeholderTextColor={C.tertiary} />
      <Primary title="Continue" onPress={() => { void signUp() }} busy={busy} />
      {!!error && <Text style={s.error}>{error}</Text>}
      <View style={{ height: 24 }} />
      <Secondary title={WELCOME_COPY.pairInstead} onPress={onChoosePair} />
    </Page>
  )
}
