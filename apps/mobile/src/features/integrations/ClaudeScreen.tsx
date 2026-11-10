// Settings → Claude Code: the sign-in on the server, and a way to sign in again. Renders model.ts.
import { useLayoutEffect, useState } from 'react'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { HeaderButton, KV } from '../../design/form.tsx'
import { toast } from '../../design/Toast.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { ConnectClaude } from './ConnectClaude.tsx'
import { claudeButtonLabel, claudeStatusText } from './model.ts'
import { useIntegration } from './parts.tsx'

export function ClaudeScreen({ navigation }: ScreenProps<'Claude'>) {
  const claude = useIntegration('claude')?.state ?? null
  const [connecting, setConnecting] = useState(false)
  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Claude Code', headerRight: () => <HeaderButton title="Done" onPress={() => navigation.goBack()} /> })
  }, [navigation])
  if (connecting) return <ConnectClaude onDone={() => { toast('Claude Code is signed in'); navigation.goBack() }} />
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Claude Code" footer={<Text>Claude Code runs on your computer using your Claude plan or Anthropic API key.</Text>}>
          <KV k="Status" v={claudeStatusText(claude)} />
        </Section>
        {claude ? <Section><Button label={claudeButtonLabel(claude)} onPress={() => setConnecting(true)} /></Section> : null}
      </Form>
    </Host>
  )
}
