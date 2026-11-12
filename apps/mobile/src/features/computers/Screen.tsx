// Servers → Link a computer with a command: for a computer this phone won't pair with, such as the person's own Mac, a
// one-time `ouro computers join` command to run on it. A server that reaches computers only over Tailscale (a Sprite) needs
// it connected first, under Settings → Integrations → Tailscale; one with its own public address (an EC2 instance) doesn't. The linked computers themselves are listed in Servers.
import { useEffect, useLayoutEffect, useState } from 'react'
import { Share } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { font, textSelection } from '@expo/ui/swift-ui/modifiers'
import type { ComputerInvite, TailscaleStatus } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, Note } from '../../design/form.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { COMPUTERS_COPY, inviteFooter, tailscaleBlocksComputers, TAILSCALE_COPY } from './model.ts'

export function ComputersScreen({ navigation }: ScreenProps<'Computers'>) {
  const session = useSession()
  const [invite, setInvite] = useState<ComputerInvite | null>(null)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)

  useEffect(() => {
    void session.api.tailscale('GET').then((answered) => {
      if (answered.ok) setTailscale(answered.value)
      else setError(answered.failure.kind === 'refused' ? failureText(answered.failure) : TAILSCALE_COPY.requestFailed)
    })
  }, [session])
  // Unknown until the first answer: no invite shows yet.
  const needsTailscale = tailscale !== null && tailscaleBlocksComputers(tailscale)

  useLayoutEffect(() => {
    navigation.setOptions({ title: COMPUTERS_COPY.addTitle, headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const add = async () => {
    setMaking(true)
    const made = await session.command('create_computer_invite', {})
    setMaking(false)
    if (made.ok) {
      setInvite(made.value)
      setError(null)
    } else setError(made.failure.kind === 'refused' ? failureText(made.failure) : COMPUTERS_COPY.inviteFailed)
  }

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {error ? <Section><Note text={error} /></Section> : null}
        {tailscale === null ? null : needsTailscale ? (
          <Section title={TAILSCALE_COPY.gateTitle} footer={<Text>{COMPUTERS_COPY.tailscaleFirst}</Text>}>
            <Button label={TAILSCALE_COPY.open} onPress={() => navigation.navigate('Tailscale')} />
          </Section>
        ) : invite ? (
          <Section title={COMPUTERS_COPY.inviteTitle} footer={<Text>{inviteFooter(invite.expiresAt, Date.now())}</Text>}>
            <Text modifiers={[font({ design: 'monospaced', textStyle: 'footnote' }), textSelection(true)]}>{invite.command}</Text>
            <Button label="Copy" onPress={async () => { await Clipboard.setStringAsync(invite.command); toast('Copied') }} />
            <Button label="Share" onPress={() => { Share.share({ message: invite.command }).catch(() => {}) }} />
            <Button label="I've run it" onPress={() => navigation.goBack()} />
          </Section>
        ) : (
          <Section footer={<Text>{COMPUTERS_COPY.addFooter}</Text>}>
            <Button label={making ? COMPUTERS_COPY.making : COMPUTERS_COPY.makeCommand} onPress={making ? () => {} : () => { void add() }} />
          </Section>
        )}
      </Form>
    </Host>
  )
}
