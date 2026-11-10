// Settings → ChatGPT: sign Codex on the server in to the person's ChatGPT plan with a device code entered on OpenAI's
// own page. The server watches for the sign-in to finish, and the change arrives with sync. Renders model.ts.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import type { ChatgptLoginStart } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { actionOutcome, CHECKING_TEXT, chatgptAccountText, chatgptSection, usageFooter, usageRows } from './model.ts'
import { useIntegration } from './parts.tsx'

export function ChatGptScreen({ navigation }: ScreenProps<'ChatGPT'>) {
  const session = useSession()
  const { api } = session
  useSessionVersion(session)
  const chatgpt = useIntegration('chatgpt')?.state ?? null
  // Read by the server after Codex turns and on a refresh; it arrives with sync.
  const usage = session.store.server?.planUsage.chatgpt ?? null
  const [login, setLogin] = useState<ChatgptLoginStart | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signedIn = chatgpt?.status === 'signed_in'

  const refreshUsage = useCallback(async () => {
    setRefreshing(true)
    const refreshed = await session.command('refresh_plan_usage', { provider: 'chatgpt' })
    setRefreshing(false)
    if (!refreshed.ok) setError(failureText(refreshed.failure))
  }, [session])
  useEffect(() => { if (signedIn) void refreshUsage() }, [signedIn, refreshUsage])

  // A code was out and the sign-in it was for has arrived.
  useEffect(() => {
    if (!signedIn || !login) return
    setLogin(null)
    toast('ChatGPT connected')
  }, [signedIn, login])

  const start = async () => {
    setBusy(true); setError(null)
    const started = await api.chatgptLoginStart()
    setBusy(false)
    if (started.ok) setLogin(started.value)
    else setError(failureText(started.failure))
  }
  const openOpenAi = async () => {
    if (!login) return
    await Clipboard.setStringAsync(login.code)
    toast('Code copied')
    await Linking.openURL(login.url)
  }
  const signOut = () => confirm('Sign out of ChatGPT?', 'Agents on GPT models will stop until you sign in again.', 'Sign out', () => {
    void api.chatgptSignOut().then((result) => {
      const outcome = actionOutcome(result, "Couldn't sign out of ChatGPT.")
      if (outcome.kind === 'failed') return setError(outcome.text)
      toast('Signed out of ChatGPT')
    })
  })

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'ChatGPT', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const section = chatgptSection(chatgpt, login !== null)
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {error !== null ? <Section><Note text={error} /></Section> : null}
        {section === 'checking' ? <Section title="ChatGPT"><KV k="Status" v={CHECKING_TEXT} /></Section> : null}
        {section === 'not_installed' ? <Section><Note text="Codex isn't installed on this server, so it can't run GPT models." /></Section> : null}
        {section === 'connected' && chatgpt?.status === 'signed_in' ? (
          <Section title="Connected" footer={<Text>Agents on GPT models run on Codex and count against your ChatGPT plan.</Text>}>
            <KV k="Account" v={chatgptAccountText(chatgpt)} />
            <KV k="Plan" v={chatgpt.plan} />
          </Section>
        ) : null}
        {section === 'enter_code' && login ? (
          <Section title="Enter this code" footer={<Text>Sign in on OpenAI's page and enter the code. This screen updates by itself once you're done. The code lasts 15 minutes.</Text>}>
            <KV k="Code" v={login.code} />
            <Button label="Copy code and open OpenAI" onPress={() => { void openOpenAi() }} />
            <Button label={busy ? 'Getting a code…' : 'Get a new code'} onPress={() => { void start() }} />
          </Section>
        ) : null}
        {section === 'sign_in' ? (
          <Section title="ChatGPT" footer={<Text>Run agents on GPT models with your ChatGPT plan. Codex on your computer keeps the sign-in; Ouro never sees your password.</Text>}>
            <Button label={busy ? 'Getting a code…' : 'Sign in with ChatGPT'} onPress={() => { void start() }} />
          </Section>
        ) : null}
        {signedIn ? (
          <Section title="Codex usage" footer={<Text>{usageFooter(usage, refreshing)}</Text>}>
            {usageRows(usage, refreshing, Date.now()).map((row) => <KV key={row.key} k={row.label} v={row.value} />)}
            <Button label="Refresh usage" onPress={() => { void refreshUsage() }} />
          </Section>
        ) : null}
        {signedIn ? <Section><Button label="Sign out of ChatGPT" role="destructive" onPress={signOut} /></Section> : null}
      </Form>
    </Host>
  )
}
