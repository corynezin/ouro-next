// An agent on another of the person's computers: the direct chat with it, its open asks, its status, and with full trust
// its latest summary, its log and its controls.
// Renders remoteAgent/model.ts.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { RemoteAgentAction } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { Bubble } from '../../design/Bubble.tsx'
import { C } from '../../design/colors.ts'
import { Composer } from '../../design/Composer.tsx'
import type { ComposerFile } from '../../design/composerFiles.ts'
import { actionSheet, barMenu, confirm } from '../../design/menus.tsx'
import { useSteady } from '../../design/steady.ts'
import { useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { useBannerHeight } from '../../navigation/UpdateBanner.tsx'
import { AsksPanel } from '../chat/AsksPanel.tsx'
import { asksPanel, ChoiceTapGuard, chatItems, choicesForMessage, composerPlaceholder, outboxBubble } from '../chat/model.ts'
import { directChatWith, openCopyOf } from '../shared/agentFacts.ts'
import { openSnoozeSheet } from '../shared/snoozeSheet.ts'
import { REMOTE_COPY, remoteActionsOf, remoteAsksOf, remoteChatModel, remoteSend } from './model.ts'

const ACTION_TITLE = { interrupt: 'Interrupt', stop: 'Stop', archive: 'Archive' } as const

export function RemoteChatScreen({ navigation, route }: ScreenProps<'RemoteChat'>) {
  const { remoteAgentId } = route.params
  const session = useSession()
  const version = useSessionVersion(session)
  const now = useNow(1000)
  const headerHeight = useHeaderHeight()
  const bannerHeight = useBannerHeight()
  const titleWidth = useWindowDimensions().width - 160 // clear of the back and menu buttons
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fill, setFill] = useState<{ key: string; text: string; files: ComposerFile[] } | null>(null)
  const [answeringAskId, setAnsweringAskId] = useState<string | null>(null)
  const [choiceGuard] = useState(() => new ChoiceTapGuard())
  const { store } = session
  const remote = store.remoteAgents.get(remoteAgentId)
  const computer = remote && store.computers.get(remote.computerId)
  const chat = remote && directChatWith(store, remote.address)
  const chatId = chat?.id ?? null
  const timeline = chatId === null ? undefined : store.timeline(chatId)

  useEffect(() => (chatId === null ? undefined : session.openChat(chatId)), [session, chatId])

  const items = useMemo(() => chatItems({
    messages: timeline?.messages ?? [], outbox: session.outbox.entriesIn(remoteAgentId), viewerAddress: store.viewer?.address, recipientLastOutputAt: null,
  }), [version, chatId, remoteAgentId])

  const header = remote && computer ? remoteChatModel(remote, computer, now) : null
  const status = useSteady({ text: header?.statusText ?? '', label: header?.statusLabel ?? '', busy: header?.busy ?? false }, (held) => held.label)
  const asks = remote ? remoteAsksOf(store, remote) : []
  const panel = asksPanel(asks.map(openCopyOf), answeringAskId, Date.now())
  const actions = remote && computer ? remoteActionsOf(remote, computer) : []

  const control = async (action: RemoteAgentAction) => {
    setNote(null)
    const done = await session.command('control_remote_agent', { remoteAgentId, action })
    if (!done.ok) setNote(failureText(done.failure))
  }

  const canReadLog = header?.canReadLog ?? false
  const menuKey = `${actions.map((action) => action.kind).join(',')}|${canReadLog}`
  useLayoutEffect(() => {
    navigation.setOptions({
      title: header?.title ?? '',
      headerTitle: () => header && (
        <View style={{ alignItems: 'center', maxWidth: titleWidth }}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: C.label }} numberOfLines={1}>{header.title}</Text>
          <Text style={{ fontSize: 11, color: C.secondary }} numberOfLines={1}>{header.subtitle}</Text>
        </View>
      ),
      unstable_headerRightItems: () => actions.length || canReadLog ? [barMenu('ellipsis.circle', 'More', [
        ...(canReadLog ? [{ title: 'Log', onPress: () => navigation.navigate('RemoteLog', { remoteAgentId }) }] : []),
        ...actions.map((action) => ({
          title: ACTION_TITLE[action.kind],
          destructive: action.kind === 'stop',
          onPress: action.kind === 'archive' && remote
            ? () => confirm(REMOTE_COPY.archiveTitle(remote.name), REMOTE_COPY.archiveMessage, 'Archive', () => { void control(action) })
            : () => { void control(action) },
        })),
      ])] : [],
    })
  }, [navigation, header?.title, header?.subtitle, titleWidth, menuKey])

  const loadOlder = async () => {
    if (loading || chatId === null) return
    setLoading(true)
    const loaded = await session.loadOlder(chatId)
    setLoading(false)
    setNote(loaded.ok ? null : failureText(loaded.failure))
  }
  const send = (text: string) => {
    if (!remote || !text) return
    setNote(null)
    setAnsweringAskId(null)
    session.outbox.send(remoteSend(remote, text, answeringAskId))
    session.drafts.setText(remoteAgentId, '')
  }
  /** False for a tap the guard ignores, so it doesn't buzz either. */
  const chooseAnswer = (askId: string, choice: string): boolean => {
    if (!remote || !choiceGuard.accept(askId, Date.now())) return false
    session.outbox.send(remoteSend(remote, choice, askId))
    return true
  }

  if (!remote || !header) return <View style={{ flex: 1, backgroundColor: C.background }} />
  const hasOlder = timeline?.hasOlder === true
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.background }} behavior="padding" keyboardVerticalOffset={headerHeight + bannerHeight}>
      <FlatList
        inverted
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          if (item.kind === 'message') {
            const choices = choicesForMessage(item.message, store.remoteAsks)
            return <Bubble text={item.message.text} sentAt={item.message.at} mine={item.mine}
              choices={choices && { options: choices.options, onChoose: (choice) => chooseAnswer(choices.askId, choice) }}
              footnote={item.failedText ?? undefined} failed={item.failedText !== null} onSelectText={(text) => navigation.navigate('SelectText', { text })} />
          }
          const shown = outboxBubble(item.entry)
          const reason = shown.failureReason
          const key = item.entry.idempotencyKey
          const failedMenu = [
            { title: 'Retry', onPress: () => session.outbox.retry(key) },
            { title: 'Edit', onPress: () => { void session.outbox.takeBack(key).then((taken) => { if (taken) setFill({ key, text: taken.text, files: [] }) }) } },
            { title: 'Delete', destructive: true, onPress: () => { void session.outbox.discard(key) } },
          ]
          return <Bubble text={shown.text} sentAt={item.entry.createdAt} mine footnote={shown.footnote} failed={reason !== null} faded={shown.faded}
            extraActions={reason !== null ? failedMenu : undefined} onPress={reason !== null ? () => actionSheet(reason, failedMenu) : undefined}
            onSelectText={(text) => navigation.navigate('SelectText', { text })} />
        }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 12, gap: 8 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => { if (hasOlder) void loadOlder() }}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={chatId === null || timeline ? <Text style={{ color: C.secondary, fontSize: 14, textAlign: 'center' }}>{REMOTE_COPY.empty}</Text> : <ActivityIndicator />}
        ListFooterComponent={hasOlder ? (
          <Pressable onPress={() => { void loadOlder() }} style={{ alignItems: 'center', paddingVertical: 8 }}>
            {loading ? <ActivityIndicator /> : <Text style={{ color: C.blue, fontSize: 13 }}>Earlier messages</Text>}
          </Pressable>
        ) : undefined}
      />
      {note !== null && <Text style={{ color: C.orange, fontSize: 12, paddingHorizontal: 18, paddingVertical: 3, backgroundColor: C.bar }} numberOfLines={2}>{note}</Text>}
      {header.summaryLine !== null && (
        <Text style={{ color: C.label, fontSize: 12, paddingHorizontal: 18, paddingVertical: 3, backgroundColor: C.bar }} numberOfLines={1}>{header.summaryLine}</Text>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 4, backgroundColor: C.bar }}>
        {status.busy && <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }] }} />}
        <Text style={{ color: C.secondary, fontSize: 12, flexShrink: 1 }} numberOfLines={2}>{status.text}</Text>
      </View>
      <AsksPanel rows={panel.rows} hint={panel.hint} setAnsweringAskId={setAnsweringAskId} onChoose={chooseAnswer}
        onOptions={(ask, toggle) => openSnoozeSheet(session, ask, setNote, [{ title: ask.answering ? 'Reply to all instead' : 'Answer just this', onPress: toggle }])} />
      <Composer initialText={session.drafts.textOf(remoteAgentId)} onTextChange={(text) => session.drafts.setText(remoteAgentId, text)}
        placeholder={composerPlaceholder(remote.name, panel.rows)} onSend={send} onError={setNote} fill={fill} noFiles />
    </KeyboardAvoidingView>
  )
}
