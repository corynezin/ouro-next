// Sign in to Claude Code on the server: Anthropic's own login with a code, an Anthropic API key, or OpenRouter instead.
// Or share: one approval makes a year-long plan token that signs this server and the person's other computers in.
// Shown from Settings → Claude Code, in its sheet.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { C } from '../../design/colors.ts'
import { accent } from '../../design/theme.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { failureText } from '../../core/session/serverApi.ts'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ClaudeShareComputer, IntegrationActionResult } from '@ouro/contract'
import { actionOutcome, CONNECT_COPY, pasted, SHARE_COPY, shareOutcome } from './model.ts'
import type { ConnectMode } from './model.ts'

type Busy = 'none' | 'open' | 'code' | 'key' | 'openrouter'

export function ConnectClaude({ onDone }: { onDone: () => void }) {
  const { api } = useSession()
  const [mode, setMode] = useState<ConnectMode>('login')
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [key, setKey] = useState('')
  const [openRouterKey, setOpenRouterKey] = useState('')
  const [busy, setBusy] = useState<Busy>('none')
  const [error, setError] = useState('')

  const switchTo = (next: ConnectMode) => { setMode(next); setError('') }

  const openLogin = async () => {
    setBusy('open'); setError('')
    const started = await api.claudeLoginStart()
    setBusy('none')
    if (!started.ok) return setError(failureText(started.failure))
    setOpened(true)
    await Linking.openURL(started.value.url)
  }

  /** Sends a pasted secret; `refused` is what to say if the server didn't accept it. */
  const submit = async (kind: Exclude<Busy, 'none' | 'open'>, text: string, send: (value: string) => Promise<ApiResult<IntegrationActionResult>>, refused: string, clear: () => void) => {
    const value = pasted(text)
    if (value === null) return
    setBusy(kind); setError('')
    const outcome = actionOutcome(await send(value), refused)
    setBusy('none')
    if (outcome.kind === 'failed') return setError(outcome.text)
    clear()
    onDone()
  }
  const sendCode = (text = code) => submit('code', text, (value) => api.claudeLoginFinish(value), CONNECT_COPY.codeRefused, () => setCode(''))
  const sendKey = (text = key) => submit('key', text, (value) => api.claudeSetApiKey(value), CONNECT_COPY.keyRefused, () => setKey(''))
  const sendOpenRouterKey = (text = openRouterKey) => submit('openrouter', text, (value) => api.openrouterSetKey(value), CONNECT_COPY.openRouterRefused, () => setOpenRouterKey(''))
  const pasteInto = async (set: (text: string) => void, send: (text: string) => Promise<void>) => {
    const text = (await Clipboard.getStringAsync()).trim()
    set(text)
    void send(text)
  }

  return (
    <Page>
      <Text style={s.title}>{CONNECT_COPY.title}</Text>
      {mode === 'login' && (
        <>
          <Text style={s.body}>Your agents run Claude Code on your own computer. This opens Anthropic's own login for that Claude Code. Usage counts against your own Claude plan.</Text>
          <Text style={s.small}>After you approve, Anthropic shows a code: copy it and paste it here.</Text>
          <Primary title={opened ? 'Open the login page again' : 'Open Anthropic login'} onPress={() => { void openLogin() }} busy={busy === 'open'} />
          {opened && (
            <>
              <Text style={s.label}>Code from Anthropic</Text>
              <TextInput style={[s.input, { fontFamily: 'Menlo' }]} placeholder="paste the code" value={code} onChangeText={setCode}
                autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => { void sendCode() }} placeholderTextColor={C.tertiary} />
              <Secondary title="Paste from clipboard" onPress={() => { void pasteInto(setCode, sendCode) }} />
              <Primary title="Sign in" onPress={() => { void sendCode() }} busy={busy === 'code'} disabled={!code.trim()} />
            </>
          )}
          <Text style={s.small}>The code goes straight to Claude Code on your computer; Ouro doesn't keep it.</Text>
          <Secondary title="Use an Anthropic API key instead (recommended for heavy use)" onPress={() => switchTo('api_key')} />
          <Secondary title="No Claude account? Use OpenRouter instead" onPress={() => switchTo('openrouter')} />
        </>
      )}
      {mode === 'api_key' && (
        <>
          <Text style={s.body}>Claude Code on your computer uses this key from the Anthropic Console (console.anthropic.com). Usage is billed to that API account.</Text>
          <Text style={s.label}>Anthropic API key</Text>
          <TextInput style={[s.input, { fontFamily: 'Menlo' }]} placeholder="sk-ant-…" value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false}
            secureTextEntry returnKeyType="done" onSubmitEditing={() => { void sendKey() }} placeholderTextColor={C.tertiary} />
          <Secondary title="Paste from clipboard" onPress={() => { void pasteInto(setKey, sendKey) }} />
          <Primary title="Use this key" onPress={() => { void sendKey() }} busy={busy === 'key'} disabled={!key.trim()} />
          <Text style={s.small}>The key is stored only on your computer; Ouro doesn't keep it.</Text>
          <Secondary title="Sign in with your Claude plan instead" onPress={() => switchTo('login')} />
        </>
      )}
      {mode === 'openrouter' && (
        <>
          <Text style={s.body}>OpenRouter is a pay-as-you-go provider of many models — DeepSeek, Qwen Coder, Gemini Flash, and Claude Haiku — no Claude account needed. Your agents run those models through this key.</Text>
          <Secondary title="Sign up for OpenRouter" onPress={() => { void Linking.openURL('https://openrouter.ai/signup') }} />
          <Secondary title="Open OpenRouter to make a key" onPress={() => { void Linking.openURL('https://openrouter.ai/keys') }} />
          <Text style={s.label}>OpenRouter API key</Text>
          <TextInput style={[s.input, { fontFamily: 'Menlo' }]} placeholder="sk-or-…" value={openRouterKey} onChangeText={setOpenRouterKey} autoCapitalize="none" autoCorrect={false}
            secureTextEntry returnKeyType="done" onSubmitEditing={() => { void sendOpenRouterKey() }} placeholderTextColor={C.tertiary} />
          <Secondary title="Paste from clipboard" onPress={() => { void pasteInto(setOpenRouterKey, sendOpenRouterKey) }} />
          <Primary title="Use this key" onPress={() => { void sendOpenRouterKey() }} busy={busy === 'openrouter'} disabled={!openRouterKey.trim()} />
          <Text style={s.small}>The key is stored only on your computer; Ouro doesn't keep it.</Text>
          <Secondary title="Sign in with your Claude plan instead" onPress={() => switchTo('login')} />
        </>
      )}
      {!!error && <Text style={s.error}>{error}</Text>}
    </Page>
  )
}

export function ShareClaude({ onShared }: { onShared: (computers: ClaudeShareComputer[]) => void }) {
  const { api } = useSession()
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'none' | 'open' | 'code'>('none')
  const [error, setError] = useState('')

  const openApproval = async () => {
    setBusy('open'); setError('')
    const started = await api.claudeShareStart()
    setBusy('none')
    if (!started.ok) return setError(failureText(started.failure))
    setOpened(true)
    await Linking.openURL(started.value.url)
  }
  const sendCode = async (text = code) => {
    const value = pasted(text)
    if (value === null) return
    setBusy('code'); setError('')
    const outcome = shareOutcome(await api.claudeShareFinish(value), SHARE_COPY.codeRefused)
    setBusy('none')
    if (outcome.kind === 'failed') return setError(outcome.text)
    setCode('')
    onShared(outcome.computers)
  }
  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim()
    setCode(text)
    void sendCode(text)
  }

  return (
    <Page>
      <Text style={s.title}>{SHARE_COPY.title}</Text>
      <Text style={s.body}>{SHARE_COPY.body}</Text>
      <Text style={s.small}>After you approve, Anthropic shows a code: copy it and paste it here.</Text>
      <Primary title={opened ? 'Open the approval page again' : 'Open Anthropic approval'} onPress={() => { void openApproval() }} busy={busy === 'open'} />
      {opened && (
        <>
          <Text style={s.label}>Code from Anthropic</Text>
          <TextInput style={[s.input, { fontFamily: 'Menlo' }]} placeholder="paste the code" value={code} onChangeText={setCode}
            autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => { void sendCode() }} placeholderTextColor={C.tertiary} />
          <Secondary title="Paste from clipboard" onPress={() => { void paste() }} />
          <Primary title="Sign in all my computers" onPress={() => { void sendCode() }} busy={busy === 'code'} disabled={!code.trim()} />
        </>
      )}
      <Text style={s.small}>The token is kept only by Claude Code on your computers; Ouro's servers elsewhere never see it.</Text>
      {!!error && <Text style={s.error}>{error}</Text>}
    </Page>
  )
}

function Page({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: C.background }}>
      <ScrollView contentContainerStyle={[s.wrap, { paddingTop: 24, paddingBottom: 24 }]} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </KeyboardAvoidingView>
  )
}

const Primary = ({ title, onPress, busy, disabled }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean }) => (
  <Pressable style={[s.button, { backgroundColor: accent, opacity: disabled ? 0.4 : 1 }]} onPress={onPress} disabled={busy || disabled}>
    {busy ? <ActivityIndicator color="white" /> : <Text style={s.buttonText}>{title}</Text>}
  </Pressable>
)
const Secondary = ({ title, onPress }: { title: string; onPress: () => void }) => (
  <Pressable style={s.secondary} onPress={onPress}><Text style={{ color: accent, fontSize: 15 }}>{title}</Text></Pressable>
)

const s = StyleSheet.create({
  wrap: { flexGrow: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 30, fontWeight: '700', color: C.label },
  body: { fontSize: 16, color: C.secondary, lineHeight: 22 },
  small: { fontSize: 13, color: C.secondary },
  label: { fontSize: 13, color: C.secondary, marginTop: 8, marginBottom: -6 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.opaqueSeparator, borderRadius: 10, padding: 12, fontSize: 16, color: C.label },
  secondary: { alignItems: 'center', padding: 8 },
  button: { borderRadius: 12, padding: 15, alignItems: 'center', marginTop: 4 },
  buttonText: { color: 'white', fontWeight: '600', fontSize: 17 },
  error: { color: C.red },
})
