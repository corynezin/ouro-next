// Chats: yours, pinned first then latest first (long-press to pin), and others' you can read folded under "Other chats".
// Search finds chats by name here and messages on the server; a hit opens its chat at that message. Renders chats/model.ts
// and chats/search.ts.
import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { Avatar } from '../../design/Avatar.tsx'
import { C } from '../../design/colors.ts'
import { actionSheet, barButton } from '../../design/menus.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import { SEARCH_DEFAULT_LIMIT } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import type { ScreenProps } from '../../navigation/routes.ts'
import type { MessageAt } from '../chat/model.ts'
import { chatDestination, chatsListModel, pinTargetOfChat } from './model.ts'
import type { ChatRowModel } from './model.ts'
import { chatSearchModel, SEARCH_COPY, SEARCH_PAUSE_MS, searchFor } from './search.ts'
import type { AnsweredSearch, HitRowModel, SearchRow, SearchSection } from './search.ts'

interface Sec { key: 'mine' | 'others'; data: ChatRowModel[] }

export function ChatsScreen({ navigation }: ScreenProps<'Chats'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const now = useNow(30_000)
  const [othersOpen, setOthersOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [answered, setAnswered] = useState<AnsweredSearch | null>(null)
  const model = useMemo(() => chatsListModel(session.store, session.connection, now), [version, now])
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Chats',
      unstable_headerRightItems: () => [barButton('plus', 'New group', () => navigation.navigate('NewGroup'))],
      headerSearchBarOptions: {
        placeholder: SEARCH_COPY.placeholder, onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(''), hideWhenScrolling: true, autoCapitalize: 'none',
      },
    })
  }, [navigation])

  const searched = query.trim()
  useEffect(() => {
    if (!searched) return
    let current = true
    const timer = setTimeout(() => {
      void session.api.search(searched, SEARCH_DEFAULT_LIMIT).then((result) => {
        if (!current) return
        setAnswered({ query: searched, search: result.ok ? { kind: 'found', page: result.value } : { kind: 'failed', reason: failureText(result.failure) } })
      })
    }, SEARCH_PAUSE_MS)
    return () => { current = false; clearTimeout(timer) }
  }, [session, searched])
  const searchModel = useMemo(() => {
    if (!searched) return null
    return chatSearchModel(session.store, searched, searchFor(searched, answered), now)
  }, [version, now, searched, answered])

  const open = (chatId: string, at?: MessageAt) => {
    const chat = session.store.chats.get(chatId)
    if (!chat) { navigation.navigate('ChatRoom', { chatId, at }); return }
    const destination = chatDestination(session.store, chat)
    if (destination.screen === 'Chat') navigation.navigate('Chat', { agentRef: destination.agentRef, at })
    else navigation.navigate('ChatRoom', { chatId: destination.chatId, at })
  }
  const pinMenu = (chatId: string) => {
    const chat = session.store.chats.get(chatId)
    const target = chat && pinTargetOfChat(session.store, chat)
    if (!chat || !target) return
    const pinned = model.mine.some((row) => row.chatId === chatId && row.pinned)
    const toggle = async () => {
      const failure = await session.commandError(pinned ? 'unpin' : 'pin', { target }, 1)
      if (failure) Alert.alert(pinned ? 'Couldn’t unpin' : 'Couldn’t pin', failure)
    }
    actionSheet(undefined, [{ title: pinned ? 'Unpin' : 'Pin to top', onPress: () => { void toggle() } }])
  }
  const openHit = (hit: HitRowModel) => open(hit.chatId, { messageId: hit.messageId, seq: hit.seq })
  const refresh = async () => {
    setRefreshing(true)
    await session.refresh()
    setRefreshing(false)
  }

  if (searchModel) {
    return (
      <SectionList<SearchRow, SearchSection & { data: SearchRow[] }>
        sections={searchModel.sections.map((section) => ({ ...section, data: section.rows }))}
        keyExtractor={(row) => (row.kind === 'chat' ? row.chat.chatId : row.hit.key)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        style={{ backgroundColor: C.background }}
        renderSectionHeader={({ section }) => <View style={s.header}><Text style={s.headerText}>{section.title}</Text></View>}
        renderItem={({ item }) => (item.kind === 'chat' ? <ChatRow {...item.chat} onOpen={open} /> : <HitRow hit={item.hit} onOpen={openHit} />)}
        ItemSeparatorComponent={Separator}
        ListFooterComponent={<Text style={s.empty}>{searchModel.noteText}</Text>}
      />
    )
  }

  const sections: Sec[] = [{ key: 'mine', data: model.mine }, ...(model.others.length ? [{ key: 'others' as const, data: othersOpen ? model.others : [] }] : [])]
  return (
    <SectionList<ChatRowModel, Sec>
      sections={sections}
      keyExtractor={(row) => row.chatId}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      stickySectionHeadersEnabled={false}
      style={{ backgroundColor: C.background }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} />}
      renderSectionHeader={({ section }) => section.key === 'others' ? (
        <Pressable onPress={() => setOthersOpen(!othersOpen)} style={s.header} accessibilityLabel={`Other chats, ${model.others.length}`}>
          <Symbol name={othersOpen ? 'chevron.down' : 'chevron.right'} size={10} color="secondary" />
          <Text style={s.headerText}>Other chats ({model.others.length})</Text>
        </Pressable>
      ) : model.emptyText !== null ? <Text style={s.empty}>{model.emptyText}</Text> : null}
      renderItem={({ item }) => <ChatRow {...item} onOpen={open} onLongPress={pinMenu} />}
      ItemSeparatorComponent={Separator}
    />
  )
}

const Separator = () => <View style={s.sep} />

const ChatRow = memo(function ChatRow(row: ChatRowModel & { onOpen: (chatId: string) => void; onLongPress?: (chatId: string) => void }) {
  return (
    <Pressable onPress={() => row.onOpen(row.chatId)} onLongPress={row.onLongPress && (() => row.onLongPress!(row.chatId))} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}>
      <View style={s.icon}>
        {row.avatarAddress === null
          ? <Symbol name="person.2.fill" size={22} color="secondary" />
          : <Avatar seed={row.avatarAddress} kind={row.avatarIsPerson ? 'human' : 'agent'} size={56} />}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={s.line}>
          <Text style={s.name} numberOfLines={1}>{row.title}</Text>
          {row.kind === 'group' && <Text style={s.small}>{row.memberCount}</Text>}
          {row.pinned && <View accessible accessibilityRole="image" accessibilityLabel="pinned"><Symbol name="pin.fill" size={11} color="secondary" /></View>}
          <View style={{ flex: 1 }} />
          <Text style={s.small}>{row.timeText}</Text>
        </View>
        {row.previewText !== null && <Text style={s.sub} numberOfLines={2}>{row.previewText}</Text>}
      </View>
      {row.unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{row.unread}</Text></View>}
    </Pressable>
  )
})

/** A message found: its chat, who said it, and the words marked. */
const HitRow = memo(function HitRow({ hit, onOpen }: { hit: HitRowModel; onOpen: (hit: HitRowModel) => void }) {
  return (
    <Pressable onPress={() => onOpen(hit)} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}>
      <View style={s.icon}>
        {hit.avatarAddress === null
          ? <Symbol name="person.2.fill" size={22} color="secondary" />
          : <Avatar seed={hit.avatarAddress} kind={hit.avatarIsPerson ? 'human' : 'agent'} size={56} />}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={s.line}>
          <Text style={s.name} numberOfLines={1}>{hit.title}</Text>
          <View style={{ flex: 1 }} />
          <Text style={s.small}>{hit.timeText}</Text>
        </View>
        <Text style={s.sub} numberOfLines={3}>
          {hit.senderText}: {hit.excerpt.map((part, index) => <Text key={index} style={part.marked ? s.marked : undefined}>{part.text}</Text>)}
        </Text>
      </View>
    </Pressable>
  )
})

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingVertical: 9 },
  icon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: C.pressed },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 17, fontWeight: '600', color: C.label, flexShrink: 1 },
  small: { fontSize: 12, color: C.secondary },
  sub: { fontSize: 15, color: C.secondary },
  marked: { color: C.label, fontWeight: '600' },
  badge: { backgroundColor: C.blue, borderRadius: 11, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, alignSelf: 'center' },
  badgeText: { color: 'white', fontWeight: '700', fontSize: 12 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 54 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4 },
  headerText: { fontSize: 13, fontWeight: '700', color: C.secondary },
  empty: { color: C.secondary, fontSize: 14, paddingHorizontal: 16, paddingVertical: 10 },
})
