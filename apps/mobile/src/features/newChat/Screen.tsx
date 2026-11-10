// A sheet for a new group (a name, then who's in it), or with a chatId, for adding to an existing group. Anyone not
// listed can be typed as an address. Draws chats/model.ts's memberChoices.
import { useLayoutEffect, useState } from 'react'
import { Form, Host, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { failureText } from '../../core/session/serverApi.ts'
import { Field, HeaderButton, Note } from '../../design/form.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { memberLabel } from '../shared/agentFacts.ts'
import { addMembersInTurn, agentsElsewhereChoices, chosenMembers, memberChoices, memberPickerDoneTitle, NEW_CHAT_COPY } from '../chats/model.ts'
import type { MemberChoice } from '../chats/model.ts'

export function NewGroupScreen({ navigation }: ScreenProps<'NewGroup'>) {
  const session = useSession()
  const [name, setName] = useState('')
  return (
    <MemberPicker navigation={navigation} chatId={null} name={name} setName={setName} finish={async (members) => {
      const created = await session.command('create_chat', { title: name.trim() || null, members })
      if (!created.ok) return failureText(created.failure)
      navigation.goBack()
      navigation.navigate('ChatRoom', { chatId: created.value.chat.id })
      return null
    }} />
  )
}

export function AddToChatScreen({ navigation, route }: ScreenProps<'AddToChat'>) {
  const session = useSession()
  const { chatId } = route.params
  return (
    <MemberPicker navigation={navigation} chatId={chatId} name={null} setName={null} finish={async (members) => {
      const add = async (address: string) => {
        const added = await session.command('add_chat_member', { chatId, address })
        return added.ok ? null : failureText(added.failure)
      }
      const refusal = await addMembersInTurn(members, add, (address) => memberLabel(session.store, address))
      if (refusal === null) navigation.goBack()
      return refusal
    }} />
  )
}

type SheetNavigation = ScreenProps<'NewGroup'>['navigation'] | ScreenProps<'AddToChat'>['navigation']

function MemberPicker({ navigation, chatId, name, setName, finish }: {
  navigation: SheetNavigation
  /** Null for a new group. */
  chatId: string | null
  name: string | null
  setName: ((name: string) => void) | null
  /** Null when done, else the failure to show. */
  finish: (members: string[]) => Promise<string | null>
}) {
  const session = useSession()
  useSessionVersion(session)
  const [query, setQuery] = useState('')
  const [typed, setTyped] = useState('')
  const [toggled, setToggled] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const adding = chatId !== null
  const chat = chatId === null ? null : session.store.chats.get(chatId) ?? null
  const choices = memberChoices(session.store, chat, query)
  const elsewhere = agentsElsewhereChoices(session.store.remoteAgents.values(), session.store.computers, chat, query)
  const members = chosenMembers(toggled, typed)
  const canFinish = !busy && members.length > 0
  const toggle = (address: string, on: boolean) => setToggled((current) => (on ? [...current, address] : current.filter((x) => x !== address)))
  const submit = async () => {
    setBusy(true)
    setFailure(null)
    const failed = await finish(members)
    if (failed === null) return
    setBusy(false)
    setFailure(failed)
  }

  const doneTitle = memberPickerDoneTitle(adding, busy)
  useLayoutEffect(() => {
    navigation.setOptions({
      title: adding ? 'Add to chat' : 'New group',
      headerLeft: () => <HeaderButton title="Cancel" onPress={() => navigation.goBack()} />,
      headerRight: () => <HeaderButton title={doneTitle} bold disabled={!canFinish} onPress={() => { void submit() }} />,
    })
  })

  const toggles = (list: MemberChoice[]) => list.map((choice) => (
    <Toggle key={choice.address} label={choice.label} isOn={toggled.includes(choice.address)} onIsOnChange={(on) => toggle(choice.address, on)} />
  ))
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {name !== null && setName !== null ? <Section title="Name"><Field placeholder="Group name" value={name} onChange={setName} /></Section> : null}
        <Section>
          <Field plain placeholder="Find a person or agent" value={query} onChange={setQuery} />
        </Section>
        <Section title="People" footer={<Text>{NEW_CHAT_COPY.notListedFooter}</Text>}>
          {toggles(choices.people)}
          <Field plain placeholder="name@server" value={typed} onChange={setTyped} />
        </Section>
        {choices.agents.length ? <Section title="Agents">{toggles(choices.agents)}</Section> : null}
        {elsewhere.map(({ computerName, agents }) => <Section key={computerName} title={`Agents on ${computerName}`}>{toggles(agents)}</Section>)}
        {failure !== null ? <Section><Note text={failure} color="red" /></Section> : null}
      </Form>
    </Host>
  )
}
