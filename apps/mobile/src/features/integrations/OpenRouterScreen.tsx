// Settings → OpenRouter: give the server an OpenRouter key so agents can run its models. The key stays on the server.
// Renders model.ts.
import { useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { font, foregroundStyle } from '@expo/ui/swift-ui/modifiers'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { actionOutcome, CHECKING_TEXT, keyRemovalOutcome, openRouterSpentText, pasted } from './model.ts'
import { SecretField, useIntegration } from './parts.tsx'

export function OpenRouterScreen({ navigation }: ScreenProps<'OpenRouter'>) {
  const { api } = useSession()
  const openrouter = useIntegration('openrouter')?.state ?? null
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const configured = openrouter?.status === 'configured'

  const sendKey = async (text = key) => {
    const value = pasted(text)
    if (value === null) return
    setBusy(true); setError(null)
    const outcome = actionOutcome(await api.openrouterSetKey(value), 'That API key was not accepted.')
    setBusy(false)
    if (outcome.kind === 'failed') return setError(outcome.text)
    setKey('')
    toast('OpenRouter connected')
  }
  const remove = () => confirm('Remove the OpenRouter key?', 'Agents using the OpenRouter models (deepseek, qwen-coder, gemini-flash, haiku) will stop until you add a key again.', 'Remove', () => {
    void api.openrouterClearKey().then((result) => {
      const outcome = keyRemovalOutcome(result)
      if (outcome.kind === 'failed') return setError(outcome.text)
      toast('OpenRouter key removed')
    })
  })

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'OpenRouter', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {error !== null ? <Section><Note text={error} /></Section> : null}
        {!openrouter ? <Section title="OpenRouter"><KV k="Status" v={CHECKING_TEXT} /></Section> : null}
        {openrouter && configured ? (
          <Section title="Connected" footer={<Text>Agents run the OpenRouter models through this key. Usage is billed to your OpenRouter account.</Text>}>
            <KV k="Spent" v={openRouterSpentText(openrouter)} />
          </Section>
        ) : null}
        {openrouter && !configured ? (
          <Section title="OpenRouter" footer={<Text>OpenRouter is a pay-as-you-go provider of many models, including DeepSeek, Qwen Coder, Gemini Flash, and Claude Haiku. No Claude account needed: make an OpenRouter key and paste it here. It is stored only on your server.</Text>}>
            <Button label="Sign up for OpenRouter" onPress={() => { void Linking.openURL('https://openrouter.ai/signup') }} />
            <Button label="Open OpenRouter to make a key" onPress={() => { void Linking.openURL('https://openrouter.ai/keys') }} />
          </Section>
        ) : null}
        {openrouter ? (
          <Section title={configured ? 'Replace the key' : 'Add your key'} footer={<Text>Create a key on openrouter.ai/keys, then paste it here. It never leaves your server.</Text>}>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>OpenRouter API key</Text>
            <SecretField placeholder="sk-or-…" value={key} onChange={setKey} onSubmit={() => { void sendKey() }} />
            <Button label="Paste from clipboard" onPress={() => { void Clipboard.getStringAsync().then((text) => { setKey(text.trim()); void sendKey(text) }) }} />
            <Button label={busy ? 'Connecting…' : 'Connect'} onPress={() => { void sendKey() }} />
          </Section>
        ) : null}
        {configured ? <Section><Button label="Remove the OpenRouter key" role="destructive" onPress={remove} /></Section> : null}
      </Form>
    </Host>
  )
}
