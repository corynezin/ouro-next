// Settings → Invite someone: their name, then a one-time code (and a link) to send them. The owner's alone.
import { useLayoutEffect, useState } from 'react'
import { Share } from 'react-native'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { disabled } from '@expo/ui/swift-ui/modifiers'
import { failureText } from '../../core/session/serverApi.ts'
import { timeOfDay } from '../../design/format.ts'
import { Field, HeaderButton, KV, Note, useBlurFields } from '../../design/form.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { SETTINGS_COPY } from './model.ts'

export function InviteScreen({ navigation }: ScreenProps<'Invite'>) {
  const session = useSession()
  const { field, blurFields } = useBlurFields()
  const [name, setName] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: number; link: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Invite someone', headerRight: () => <HeaderButton title="Done" bold onPress={() => { void blurFields().then(() => navigation.goBack()) }} /> })
  }, [navigation])

  const send = async () => {
    await blurFields()
    setFailure(null)
    const started = await session.command('start_pairing', { inviteePersonName: name.trim() })
    if (started.ok) setInvite(started.value)
    else setFailure(failureText(started.failure))
  }

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {invite ? (
          <Section title={`Invite for ${name.trim()}`} footer={<Text>{SETTINGS_COPY.inviteFooter}</Text>}>
            <KV k="Code" v={invite.code} mono />
            <KV k="Expires" v={timeOfDay(invite.expiresAt)} />
            <KV k="Server" v={session.api.endpoint.url} mono />
            <Button label="Share link" onPress={() => { Share.share({ message: invite.link }).catch(() => {}) }} />
          </Section>
        ) : (
          <Section title="Their name" footer={<Text>{SETTINGS_COPY.inviteFooter}</Text>}>
            <Field ref={field} placeholder="Name" value={name} onChange={setName} onSubmit={() => { if (name.trim()) void send() }} />
            <Button label="Make an invite" modifiers={[disabled(!name.trim())]} onPress={() => { void send() }} />
            {failure !== null ? <Note text={failure} color="red" /> : null}
          </Section>
        )}
      </Form>
    </Host>
  )
}
