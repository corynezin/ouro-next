// A group chat, or someone else's direct chat: messages with who said them, and a text-only composer for members.
// Renders room/model.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useHeaderHeight } from '@react-navigation/elements'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { failureText } from '../../core/session/serverApi.ts'
import { Bubble } from '../../design/Bubble.tsx'
import { C } from '../../design/colors.ts'
import { Composer } from '../../design/Composer.tsx'
import type { ComposerFile } from '../../design/composerFiles.ts'
import { actionSheet, barButton } from '../../design/menus.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { useBannerHeight } from '../../navigation/UpdateBanner.tsx'
import { chatItems, FAILED_SEND_ACTIONS, JUMP_PAGE_SIZE, outboxBubble } from '../chat/model.ts'
import type { ChatItem } from '../chat/model.ts'
import { Marked, useJumpToMessage } from '../chat/useJumpToMessage.tsx'
import { HistoryFooter, useHistory } from '../chat/History.tsx'
import { mentionOptions } from '../chats/model.ts'
import { groupSend, homeDeliveryNote, ROOM_COPY, roomFooter, roomHeader, senderLabel } from './model.ts'

export function ChatRoomScreen({ navigation, route }: ScreenProps<'ChatRoom'>) {
  const { chatId, at } = route.params
  const session = useSession()
  const version = useSessionVersion(session)
  const headerHeight = useHeaderHeight()
  const bannerHeight = useBannerHeight()
  const bottomInset = useSafeAreaInsets().bottom
  const titleWidth = useWindowDimensions().width - 160 // clear of the back and info buttons
  const [note, setNote] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [fill, setFill] = useState<{ key: string; text: string; files: ComposerFile[] } | null>(null)
  const { store } = session
  const chat = store.chats.get(chatId)

  useEffect(() => session.openChat(chatId), [session, chatId])
  const { timeline, footer: historyFooter, loadOlder, hasOlder } = useHistory(session, chatId, setNote)

  const items = useMemo(() => chatItems({
    messages: timeline?.messages ?? [], outbox: session.outbox.entriesIn(chatId), viewerAddress: store.viewer?.address, recipientLastOutputAt: null,
  }), [version, chatId])
  const header = chat ? roomHeader(store, chat) : { title: '', subtitle: '' }
  const list = useRef<FlatList<ChatItem>>(null)
  const jump = useJumpToMessage({
    target: at, items, loaded: timeline !== undefined, hasOlder: timeline?.hasOlder === true, list, onNote: setNote,
    loadOlder: () => session.loadOlder(chatId, JUMP_PAGE_SIZE),
  })

  useLayoutEffect(() => {
    navigation.setOptions({
      title: header.title,
      headerTitle: () => (
        <View style={{ alignItems: 'center', maxWidth: titleWidth }}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: C.label }} numberOfLines={1}>{header.title}</Text>
          {header.subtitle ? <Text style={{ fontSize: 11, color: C.secondary }} numberOfLines={1}>{header.subtitle}</Text> : null}
        </View>
      ),
      unstable_headerRightItems: () => [barButton('info.circle', 'Details', () => navigation.navigate('ChatInfo', { chatId }))],
    })
  }, [navigation, header.title, header.subtitle, titleWidth, chatId])

  const send = (text: string) => {
    if (!chat || !text) return
    setNote(null)
    session.outbox.send(groupSend(chat, text))
    session.drafts.setText(chatId, '')
  }

  const join = async () => {
    const viewer = store.viewer
    if (!viewer || joining) return
    setNote(null)
    setJoining(true)
    const joined = await session.command('add_chat_member', { chatId, address: viewer.address })
    setJoining(false)
    if (!joined.ok) setNote(failureText(joined.failure))
  }

  const footer = chat ? roomFooter(store, chat) : null
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.background }} behavior="padding" keyboardVerticalOffset={headerHeight + bannerHeight}>
      <FlatList
        ref={list}
        inverted
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          if (item.kind === 'message') {
            return (
              <Marked on={item.message.id === jump.markedMessageId}>
                <Bubble text={item.message.text} sentAt={item.message.at} mine={item.mine} sender={senderLabel(store, item.message.from)}
                  footnote={item.failedText ?? (chat ? homeDeliveryNote(store, chat, item.message) : null) ?? undefined} failed={item.failedText !== null} onSelectText={(text) => navigation.navigate('SelectText', { text })} />
              </Marked>
            )
          }
          const shown = outboxBubble(item.entry)
          const reason = shown.failureReason
          const key = item.entry.idempotencyKey
          const onFailed = {
            retry: () => session.outbox.retry(key),
            edit: () => { void session.outbox.takeBack(key).then((taken) => { if (taken) setFill({ key, text: taken.text, files: [] }) }) },
            delete: () => { void session.outbox.discard(key) },
          }
          const failedMenu = FAILED_SEND_ACTIONS.map((action) => ({ title: action.title, destructive: action.destructive, onPress: onFailed[action.action] }))
          return <Bubble text={shown.text} sentAt={item.entry.createdAt} mine footnote={shown.footnote} failed={reason !== null} faded={shown.faded}
            extraActions={reason !== null ? failedMenu : undefined} onPress={reason !== null ? () => actionSheet(reason, failedMenu) : undefined}
            onSelectText={(text) => navigation.navigate('SelectText', { text })} />
        }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 12, gap: 8 }}
        extraData={jump.markedMessageId}
        onScrollToIndexFailed={jump.onScrollToIndexFailed}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => { if (hasOlder) void loadOlder() }}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={timeline ? <Text style={{ color: C.secondary, fontSize: 14, textAlign: 'center' }}>{ROOM_COPY.empty}</Text> : undefined}
        ListFooterComponent={<HistoryFooter footer={historyFooter} onLoad={() => { void loadOlder() }} />}
      />
      {note !== null && <Text style={{ color: C.orange, fontSize: 12, paddingHorizontal: 18, paddingVertical: 3, backgroundColor: C.bar }} numberOfLines={2}>{note}</Text>}
      {footer?.kind === 'reading_others' && <Text style={{ color: C.secondary, fontSize: 13, textAlign: 'center', padding: 14 }}>{ROOM_COPY.readingOthers}</Text>}
      {footer?.kind === 'members_only' && (
        <View style={{ alignItems: 'center', gap: 8, padding: 14, paddingBottom: 14 + bottomInset }}>
          <Text style={{ color: C.secondary, fontSize: 13 }}>{ROOM_COPY.membersOnly}</Text>
          <Pressable onPress={() => { void join() }} disabled={joining} accessibilityLabel={ROOM_COPY.join}
            style={({ pressed }) => ({ backgroundColor: C.blue, borderRadius: 18, paddingHorizontal: 22, paddingVertical: 8, opacity: pressed || joining ? 0.6 : 1 })}>
            <Text style={{ color: 'white', fontSize: 16, fontWeight: '600' }}>{joining ? ROOM_COPY.joining : ROOM_COPY.join}</Text>
          </Pressable>
        </View>
      )}
      {footer?.kind === 'composer' && chat && (
        <Composer initialText={session.drafts.textOf(chatId)} onTextChange={(text) => session.drafts.setText(chatId, text)} placeholder={footer.placeholder}
          onSend={send} onError={setNote} fill={fill} noFiles mentions={mentionOptions(store, chat)} />
      )}
    </KeyboardAvoidingView>
  )
}
