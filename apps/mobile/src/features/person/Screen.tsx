// A chat member with no agent page here: a person, or an agent on another machine. Who they are and the chats they're in.
import { useLayoutEffect } from 'react'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { foregroundStyle } from '@expo/ui/swift-ui/modifiers'
import { parseAddress } from '@ouro/contract'
import { KV } from '../../design/form.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { chatDestination, chatsWithMember } from '../chats/model.ts'
import { memberLabel } from '../shared/agentFacts.ts'

export function PersonScreen({ navigation, route }: ScreenProps<'Person'>) {
  const { address } = route.params
  const session = useSession()
  useSessionVersion(session)
  const label = memberLabel(session.store, address)
  useLayoutEffect(() => { navigation.setOptions({ title: label }) }, [navigation, label])

  const chats = chatsWithMember(session.store, address)
  const open = (chatId: string) => {
    const chat = session.store.chats.get(chatId)
    if (!chat) return
    const destination = chatDestination(session.store, chat)
    if (destination.screen === 'Chat') navigation.navigate('Chat', { agentRef: destination.agentRef })
    else navigation.navigate('ChatRoom', { chatId: destination.chatId })
  }
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section>
          <KV k={parseAddress(address).kind === 'agent' ? 'Agent' : 'Person'} v={address} />
        </Section>
        <Section title="Chats">
          {chats.length ? chats.map((chat) => <Button key={chat.chatId} label={chat.title} onPress={() => open(chat.chatId)} />)
            : <Text modifiers={[foregroundStyle('secondary')]}>None yet</Text>}
        </Section>
      </Form>
    </Host>
  )
}
