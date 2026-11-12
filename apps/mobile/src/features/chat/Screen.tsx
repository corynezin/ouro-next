// A conversation with one agent: your messages with receipts, its replies, live; files both ways; goal, summary and status
// bars; its open asks; the message box; interrupt and stop; next unread. Renders chat/model.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { AgentEntity, CommandInput, CommandName, MessageEntity } from '@ouro/contract'
import { STOP_ATTEMPTS } from '../../core/session/serverApi.ts'
import type { ServerSession } from '../../core/session/serverSession.ts'
import type { OutboxEntry } from '../../core/session/outbox.ts'
import { AskChoices } from '../../design/AskChoices.tsx'
import { Avatar } from '../../design/Avatar.tsx'
import { Bubble } from '../../design/Bubble.tsx'
import type { BubbleFile } from '../../design/Bubble.tsx'
import { C } from '../../design/colors.ts'
import { Composer } from '../../design/Composer.tsx'
import type { ComposerFile } from '../../design/composerFiles.ts'
import { actionSheet, barButton, barMenu, confirm } from '../../design/menus.tsx'
import { useSteady } from '../../design/steady.ts'
import { Symbol } from '../../design/Symbol.tsx'
import { useCore, useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import { useBannerHeight } from '../../navigation/UpdateBanner.tsx'
import type { Routes, ScreenProps } from '../../navigation/routes.ts'
import { agentByRef, asksOf, directChatOf, isBusy, isMaster, listOrder, nextUnread, stateOf, unreadElsewhereCount } from '../shared/agentFacts.ts'
import type { Asker } from '../shared/agentFacts.ts'
import { StateDot } from '../shared/StateDot.tsx'
import { HistoryFooter, useHistory } from './History.tsx'
import { AsksPanel } from './AsksPanel.tsx'
import { openSnoozeSheet } from '../shared/snoozeSheet.ts'
import {
  asksPanel, asksStrip, ChoiceTapGuard, chatItems, choicesForMessage, composedFilesOf, composerPlaceholder, directSend, goalBar, messageFiles, outboxBubble, recipientLastOutputOf,
  JUMP_PAGE_SIZE, routedAgents, statusBar, summaryBar,
  chatMoreMenu, FAILED_SEND_ACTIONS, nextUnreadLabel, STOP_COPY,
} from './model.ts'
import type { ChatItem, ChatMenuAction, MessageAt, StatusBarModel } from './model.ts'
import { Marked, useJumpToMessage } from './useJumpToMessage.tsx'

export function ChatScreen({ navigation, route }: ScreenProps<'Chat'>) {
  const { agentRef, at } = route.params
  const session = useSession()
  useSessionVersion(session)
  const agent = agentByRef(session.store, agentRef)
  useLayoutEffect(() => {
    if (!agent) navigation.setOptions({ title: agentRef })
  }, [navigation, agent === undefined, agentRef])
  if (!agent) {
    return (
      <View style={s.missing}>
        {session.store.server === null ? <ActivityIndicator /> : <Text style={{ color: C.secondary }}>No agent named {agentRef}.</Text>}
      </View>
    )
  }
  // A new agent is a new conversation: nothing typed or loading carries over.
  return <Conversation key={agent.id} agent={agent} session={session} navigation={navigation} at={at} />
}

function Conversation({ agent, session, navigation, at }: {
  agent: AgentEntity; session: ServerSession; navigation: ScreenProps<'Chat'>['navigation']; at: MessageAt | undefined
}) {
  const core = useCore()
  const version = useSessionVersion(session)
  const list = useRef<FlatList<ChatItem>>(null)
  const headerHeight = useHeaderHeight()
  const bannerHeight = useBannerHeight()
  const [note, setNote] = useState<string | null>(null)
  const [answeringAskId, setAnsweringAskId] = useState<string | null>(null)
  const [fill, setFill] = useState<{ key: string; text: string; files: ComposerFile[] } | null>(null)
  const [choiceGuard] = useState(() => new ChoiceTapGuard())
  const { store } = session
  const chat = directChatOf(store, agent)
  const chatId = chat?.id ?? null
  const master = isMaster(agent)
  const viewerAddress = store.viewer?.address

  useEffect(() => (chatId !== null ? session.openChat(chatId) : undefined), [session, chatId])
  useEffect(() => session.watchAgent(agent.id), [session, agent.id])
  const { timeline, footer, loadOlder, hasOlder } = useHistory(session, chatId, setNote)

  const items = useMemo(() => chatItems({
    messages: timeline?.messages ?? [],
    outbox: session.outbox.entriesIn(agent.id),
    viewerAddress,
    recipientLastOutputAt: recipientLastOutputOf(agent),
  }), [version, agent.id])

  const jump = useJumpToMessage({
    target: at, items, loaded: timeline !== undefined, hasOlder: timeline?.hasOlder === true, list, onNote: setNote,
    loadOlder: () => (chatId === null ? Promise.resolve({ ok: true as const, value: undefined }) : session.loadOlder(chatId, JUMP_PAGE_SIZE)),
  })

  const act = async <N extends CommandName>(name: N, input: CommandInput<N>, attempts: number, doneNote: string | null) => {
    const failure = await session.commandError(name, input, attempts)
    setNote(failure ?? doneNote)
  }

  const send = (text: string, files: ComposerFile[]) => {
    if (!text && !files.length) return
    setNote(null)
    setAnsweringAskId(null)
    session.outbox.send(directSend(agent, text, files, answeringAskId))
    session.drafts.setText(agent.id, '')
  }

  /** False for a tap the guard ignores, so it doesn't buzz either. */
  const chooseAnswer = (askId: string, choice: string): boolean => {
    if (!choiceGuard.accept(askId, Date.now())) return false
    session.outbox.send(directSend(agent, choice, [], askId))
    return true
  }

  const fold = core.preferences.current.idleFold
  const orderNow = () => {
    const at = Date.now()
    const { awake, idle } = listOrder(store, fold, at)
    return { at, order: [...awake, ...idle] }
  }
  const openOther = (agentId: string) => navigation.push('Chat', { agentRef: agentId })
  const openAsker = (asker: Asker) => (asker.kind === 'local' ? openOther(asker.agentId) : navigation.push('RemoteChat', { remoteAgentId: asker.remoteAgentId }))
  const goToNextUnread = () => {
    const { at, order } = orderNow()
    const next = nextUnread(store, agent, order, at)
    if (next) navigation.replace('Chat', { agentRef: next.id })
  }
  const { at: orderAt, order } = orderNow()
  const others = unreadElsewhereCount(store, agent, order, orderAt)
  const running = stateOf(agent) === 'running'
  const busy = isBusy(agent)
  const hasGoal = session.store.goals.has(agent.id)

  const onMenu = (action: ChatMenuAction) => {
    const target = { agentId: agent.id }
    switch (action) {
      case 'log': return navigation.navigate('Log', { agentRef: agent.id })
      case 'context': return navigation.navigate('Context', { agentRef: agent.id })
      case 'goal': return navigation.navigate('Goal', { agentRef: agent.id })
      case 'summaries': return navigation.navigate('Summaries', { agentRef: agent.id })
      case 'details': return navigation.navigate('Agent', { agentRef: agent.id })
      case 'interrupt': return void act('interrupt_agent', target, 1, null)
      case 'stop': return confirm(STOP_COPY.confirmTitle(agent.name), STOP_COPY.confirmMessage, STOP_COPY.confirmAction, () => { void act('stop_agent', target, STOP_ATTEMPTS, STOP_COPY.done(agent.name)) })
    }
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      title: agent.name,
      unstable_headerRightItems: () => [
        barButton('chevron.forward.2', nextUnreadLabel(others), goToNextUnread, { disabled: others === 0, badge: others }),
        barMenu('ellipsis.circle', 'More', chatMoreMenu({ hasGoal, running, busy }).map((item) => ({ ...item, onPress: () => onMenu(item.action) }))),
      ],
    })
  }, [navigation, agent.id, agent.name, others, running, busy, hasGoal])

  const renderMessage = (message: MessageEntity, item: Extract<ChatItem, { kind: 'message' }>) => {
    const choices = choicesForMessage(message, store.asks)
    const bubble = (
      <Bubble
        text={message.text}
        sentAt={message.at}
        mine={item.mine}
        files={bubbleFilesOf(message, session, (file) => navigation.navigate('File', file))}
        receipt={item.receiptText}
        footnote={item.failedText ?? undefined}
        failed={item.failedText !== null}
        doneReport={item.doneReport}
        choices={choices && { options: choices.options, onChoose: (choice) => chooseAnswer(choices.askId, choice) }}
        avatar={item.mine ? undefined : <Avatar seed={message.from} kind="agent" model={agent.model} size={36} />}
        onSelectText={(text) => navigation.navigate('SelectText', { text })}
      />
    )
    if (!master || item.mine) return bubble
    return <View>{bubble}<RouteChips text={message.text} session={session} selfId={agent.id} onOpen={openOther} /></View>
  }

  const renderOutbox = (entry: OutboxEntry) => {
    const shown = outboxBubble(entry)
    const reason = shown.failureReason
    const key = entry.idempotencyKey
    const onFailed = {
      retry: () => session.outbox.retry(key),
      edit: () => { void session.outbox.takeBack(key).then((taken) => { if (taken) setFill({ key, text: taken.text, files: composedFilesOf(taken) }) }) },
      delete: () => { void session.outbox.discard(key) },
    }
    const failedMenu = FAILED_SEND_ACTIONS.map((item) => ({ title: item.title, destructive: item.destructive, onPress: onFailed[item.action] }))
    return (
      <Bubble
        text={shown.text}
        sentAt={entry.createdAt}
        mine
        footnote={shown.footnote}
        failed={reason !== null}
        faded={shown.faded}
        extraActions={reason !== null ? failedMenu : undefined}
        onPress={reason !== null ? () => actionSheet(reason, failedMenu) : undefined}
        onSelectText={(text) => navigation.navigate('SelectText', { text })}
      />
    )
  }

  const asks = asksOf(store, agent)
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.background }} behavior="padding" keyboardVerticalOffset={headerHeight + bannerHeight}>
      {master && <AsksStrip session={session} onOpen={openAsker} />}
      <FlatList
        ref={list}
        inverted
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (item.kind === 'message'
          ? <Marked on={item.message.id === jump.markedMessageId}>{renderMessage(item.message, item)}</Marked>
          : renderOutbox(item.entry))}
        extraData={jump.markedMessageId}
        onScrollToIndexFailed={jump.onScrollToIndexFailed}
        contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 12, gap: 8 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => { if (hasOlder) void loadOlder() }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={<HistoryFooter footer={footer} onLoad={() => { void loadOlder() }} />}
      />
      <Bars agent={agent} session={session} note={note} asks={asks} answeringAskId={answeringAskId} setAnsweringAskId={setAnsweringAskId} onChoose={chooseAnswer}
        onOpenGoal={() => navigation.navigate('Goal', { agentRef: agent.id })}
        onOpenSummaries={() => navigation.navigate('Summaries', { agentRef: agent.id })} onError={setNote} />
      <Composer
        initialText={session.drafts.textOf(agent.id)}
        onTextChange={(text) => session.drafts.setText(agent.id, text)}
        placeholder={composerPlaceholder(agent.name, asksPanel(asks, answeringAskId, Date.now()).rows)}
        onSend={send}
        onError={setNote}
        fill={fill}
      />
    </KeyboardAvoidingView>
  )
}

function bubbleFilesOf(message: MessageEntity, session: ServerSession, onOpen: (file: Routes['File']) => void): BubbleFile[] {
  return messageFiles(message, (attachmentId) => session.api.attachmentUrl(attachmentId), session.api.authorizationHeaders()).map((file) => ({
    key: file.key,
    fileName: file.fileName,
    isImage: file.isImage,
    sizeText: file.sizeText,
    imageSource: file.imageSource,
    onOpen: () => onOpen({ attachmentId: file.attachmentId, fileName: file.fileName, isImage: file.isImage }),
  }))
}

function RouteChips({ text, session, selfId, onOpen }: { text: string; session: ServerSession; selfId: string; onOpen: (agentId: string) => void }) {
  const routed = routedAgents(text, session.store, selfId)
  if (!routed.length) return null
  return (
    <View style={s.chips}>
      {routed.map((agent) => (
        <Pressable key={agent.id} onPress={() => onOpen(agent.id)} style={({ pressed }) => [s.chip, pressed && { opacity: 0.6 }]} accessibilityLabel={`Open ${agent.name}`}>
          <Text style={s.chipText}>→ {agent.name}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function AsksStrip({ session, onOpen }: { session: ServerSession; onOpen: (asker: Asker) => void }) {
  const asks = asksStrip(session.store, Date.now())
  if (!asks.length) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.strip} contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
      {asks.map((ask) => (
        <Pressable key={ask.askId} onPress={() => onOpen(ask.asker)} style={({ pressed }) => [s.ask, pressed && { opacity: 0.6 }]}>
          <View style={s.barRow}><Symbol name={ask.symbol.name} color={ask.symbol.color} size={11} /><Text style={s.askWho} numberOfLines={1}>{ask.agentName}</Text></View>
          <Text style={s.askText} numberOfLines={2}>{ask.text}</Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

function Bars({ agent, session, note, asks, answeringAskId, setAnsweringAskId, onChoose, onOpenGoal, onOpenSummaries, onError }: {
  agent: AgentEntity
  onOpenGoal: () => void
  onOpenSummaries: () => void
  onError: (reason: string) => void
  session: ServerSession
  note: string | null
  asks: ReturnType<typeof asksOf>
  answeringAskId: string | null
  setAnsweringAskId: (askId: string | null) => void
  onChoose: (askId: string, choice: string) => boolean
}) {
  const now = useNow(1000)
  const { store } = session
  const goal = goalBar(store.goals.get(agent.id))
  const summary = summaryBar(store.summaries.get(agent.id), agent, now)
  const status = useSteady(statusBar(store, agent, session.connection, now), statusBarKey)
  const panel = asksPanel(asks, answeringAskId, now)
  return (
    <View>
      {goal && <Pressable onPress={onOpenGoal} style={s.bar}><Text style={[s.barText, { color: C[goal.color] }]} numberOfLines={1}>{goal.text}</Text></Pressable>}
      {summary && (
        <Pressable onPress={onOpenSummaries} style={[s.bar, s.barRow]}>
          <Text style={[s.barText, { flex: 1 }]} numberOfLines={1}>{summary.text}</Text>
          <Text style={[s.barText, { color: C.secondary }]} numberOfLines={1}>{summary.ageText}</Text>
        </Pressable>
      )}
      <View style={[s.bar, s.barRow]}>
        {status.kind === 'agent' ? (
          <>
            <StateDot kind={status.dot} />
            {status.busy && <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }] }} />}
            <Text style={[s.barText, { color: C.secondary, flexShrink: 1 }]} numberOfLines={1}>{status.text}</Text>
          </>
        ) : <Text style={[s.barText, { color: C.orange, flexShrink: 1 }]} numberOfLines={1}>{status.text}</Text>}
        <View style={{ flex: 1 }} />
        {note !== null && <Text style={[s.barText, { color: C.orange, flexShrink: 1 }]} numberOfLines={1}>{note}</Text>}
      </View>
      <AsksPanel rows={panel.rows} hint={panel.hint} setAnsweringAskId={setAnsweringAskId} onChoose={onChoose}
        onOptions={(ask, toggle) => openSnoozeSheet(session, ask, onError, [{ title: ask.answering ? 'Reply to all instead' : 'Answer just this', onPress: toggle }])} />
    </View>
  )
}

/** The bar holds by everything but the running timer, which stays live. */
const statusBarKey = (status: StatusBarModel) => (status.kind === 'agent' ? `${status.dot}|${status.busy}|${status.label}` : `lost|${status.text}`)

const s = StyleSheet.create({
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.background },
  bar: { backgroundColor: C.bar, paddingHorizontal: 18, paddingVertical: 3 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  barText: { fontSize: 12, color: C.label },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: C.tertiaryFill },
  chipText: { fontSize: 13, fontWeight: '600', color: C.indigo },
  strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  ask: { width: 200, borderRadius: 12, padding: 8, gap: 2, backgroundColor: C.secondaryBackground },
  askWho: { fontSize: 12, fontWeight: '700', color: C.label, flexShrink: 1 },
  askText: { fontSize: 13, color: C.secondary },
})
