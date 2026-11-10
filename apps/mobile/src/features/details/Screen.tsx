// An agent's details: model, state, who and where, its summary, its chats, its task, and Interrupt, Merge, Stop, Archive.
// Renders details/model.ts.
import { useLayoutEffect, useMemo, useState } from 'react'
import { Button, Form, Host, Section, Text, VStack } from '@expo/ui/swift-ui'
import { font, foregroundStyle, textSelection } from '@expo/ui/swift-ui/modifiers'
import type { CommandInput, CommandName } from '@ouro/contract'
import { failureText, STOP_ATTEMPTS } from '../../core/session/serverApi.ts'
import { KV, Note } from '../../design/form.tsx'
import { ChoiceMenu, confirm } from '../../design/menus.tsx'
import { useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { STOP_COPY } from '../chat/model.ts'
import { chatDestination } from '../chats/model.ts'
import { modelGroups } from '../newAgent/model.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { branchMergeText, DETAILS_COPY, detailsModel, screensAboutAgent } from './model.ts'

const DETAILS_TICK_MS = 5000

export function DetailsScreen({ route, navigation }: ScreenProps<'Agent'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const now = useNow(DETAILS_TICK_MS)
  const [note, setNote] = useState<string | null>(null)
  const agent = agentByRef(session.store, route.params.agentRef)
  const model = useMemo(() => (agent ? detailsModel(session.store, agent, now) : null), [version, now, agent?.id])
  const groups = useMemo(() => modelGroups(session.store.server?.models ?? [], agent?.model ?? null), [version, agent?.model])
  useLayoutEffect(() => { navigation.setOptions({ title: agent?.name ?? route.params.agentRef }) }, [navigation, agent?.name])

  if (!agent || !model || agent.state.state === 'archived') {
    return <Host style={{ flex: 1 }}><Form><Text modifiers={[foregroundStyle('secondary')]}>{`${agent?.name ?? route.params.agentRef} is gone (archived?)`}</Text></Form></Host>
  }

  const target = { agentId: agent.id }
  const act = async <N extends CommandName>(name: N, input: CommandInput<N>, attempts: number, doneNote: string | null) => {
    const failure = await session.commandError(name, input, attempts)
    setNote(failure ?? doneNote)
    return failure === null
  }
  const archive = () => confirm(`Archive ${agent.name}?`, 'It stops and leaves the list; nothing is deleted.', 'Archive', () => {
    void act('archive_agent', target, 1, null).then((archived) => {
      if (archived) navigation.pop(screensAboutAgent(navigation.getState().routes, { id: agent.id, name: agent.name }))
    })
  })
  const mergeBranch = async () => {
    setNote(null)
    const merged = await session.command('merge_agent_branch', target)
    setNote(merged.ok ? branchMergeText(merged.value.merge) : failureText(merged.failure))
  }
  const openChat = (chatId: string) => {
    const chat = session.store.chats.get(chatId)
    if (!chat) return
    const destination = chatDestination(session.store, chat)
    if (destination.screen === 'Chat') navigation.navigate('Chat', { agentRef: destination.agentRef })
    else navigation.navigate('ChatRoom', { chatId: destination.chatId })
  }

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section footer={<Text>{DETAILS_COPY.modelFooter}</Text>}>
          <ChoiceMenu label="Model" chosenKey={agent.model}
            groups={groups.map((group) => ({ title: group.title, choices: group.models.map((option) => ({ key: option.id, label: option.label })) }))}
            onChoose={(chosen) => { void act('set_agent_model', { agentId: agent.id, model: chosen }, 1, null) }} />
        </Section>
        <Section>
          {model.rows.map((row) => <KV key={row.label} k={row.label} v={row.value} mono={row.monospaced} />)}
        </Section>
        {model.doneSummary !== null ? <Section title="Done"><Text modifiers={[textSelection(true)]}>{model.doneSummary}</Text></Section> : null}
        {model.lately ? (
          <Section title={model.lately.title}>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ textStyle: 'subheadline' }), textSelection(true)]}>{model.lately.line}</Text>
              {model.lately.details.map((detail, index) => <Text key={index} modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary'), textSelection(true)]}>{'· ' + detail}</Text>)}
              {model.lately.stale ? <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle('secondary')]}>{DETAILS_COPY.staleSummary}</Text> : null}
            </VStack>
            <Button label={DETAILS_COPY.earlierSummaries} onPress={() => navigation.navigate('Summaries', { agentRef: agent.id })} />
          </Section>
        ) : null}
        <Section title="Chats">
          {model.chats.length ? model.chats.map((chat) => <Button key={chat.chatId} label={chat.title} onPress={() => openChat(chat.chatId)} />)
            : <Text modifiers={[foregroundStyle('secondary')]}>{DETAILS_COPY.noChats}</Text>}
        </Section>
        <Section title="Task">
          <Text modifiers={[font({ textStyle: 'footnote' }), textSelection(true)]}>{model.task}</Text>
        </Section>
        {note !== null ? <Section><Note text={note} /></Section> : null}
        <Section>
          {model.canInterrupt ? <Button label="Interrupt" systemImage="hand.raised" onPress={() => { void act('interrupt_agent', target, 1, null) }} /> : null}
          {model.mergeable ? <Button label={`Merge into ${model.mergeable.base}`} systemImage="arrow.triangle.merge" onPress={() => { void mergeBranch() }} /> : null}
          {model.canStop ? <Button label="Stop" systemImage="stop.circle" onPress={() => { void act('stop_agent', target, STOP_ATTEMPTS, STOP_COPY.done(agent.name)) }} /> : null}
          <Button label="Archive" role="destructive" onPress={archive} />
        </Section>
      </Form>
    </Host>
  )
}
