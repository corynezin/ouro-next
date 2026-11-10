// A chat's details: who made it, its members, and in a group, leaving, removing and adding. Renders chatInfo/model.ts.
import { useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { failureText } from '../../core/session/serverApi.ts'
import { Avatar } from '../../design/Avatar.tsx'
import { C } from '../../design/colors.ts'
import { confirm } from '../../design/menus.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { CHAT_INFO_COPY, chatInfoModel, memberDestination } from './model.ts'
import type { MemberRowModel } from './model.ts'

export function ChatInfoScreen({ navigation, route }: ScreenProps<'ChatInfo'>) {
  const { chatId } = route.params
  const session = useSession()
  useSessionVersion(session)
  const [failure, setFailure] = useState<string | null>(null)

  const chat = session.store.chats.get(chatId)
  if (!chat) return <Text style={s.gone}>{CHAT_INFO_COPY.gone}</Text>
  const model = chatInfoModel(session.store, chat)

  const open = (address: string) => {
    const destination = memberDestination(session.store, address)
    if (destination.screen === 'Agent') navigation.navigate('Agent', { agentRef: destination.agentRef })
    else navigation.navigate('Person', { address: destination.address })
  }
  const remove = (member: MemberRowModel) => {
    if (!member.removal) return
    confirm(member.removal.confirmTitle, CHAT_INFO_COPY.removeMessage, member.removal.confirmAction, async () => {
      setFailure(null)
      const removed = await session.command('remove_chat_member', { chatId, address: member.address })
      if (!removed.ok) setFailure(failureText(removed.failure))
    })
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.background }}
      data={model.members}
      keyExtractor={(member) => member.address}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={(
        <View style={s.top}>
          {failure !== null && <Text style={{ color: C.orange, fontSize: 13 }}>{failure}</Text>}
          {model.facts.map((fact) => <Text key={fact} style={s.fact}>{fact}</Text>)}
          <Text style={s.head}>{model.membersTitle}</Text>
        </View>
      )}
      renderItem={({ item: member }) => (
        <Pressable onPress={() => open(member.address)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.pressed }]}>
          <View style={{ width: 48, alignItems: 'center' }}><Avatar seed={member.address} kind={member.isPerson ? 'human' : 'agent'} size={48} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>{member.label}</Text>
            <Text style={s.fact} numberOfLines={1}>{member.address}</Text>
          </View>
          {member.removal && (
            <Pressable hitSlop={10} onPress={() => remove(member)} accessibilityLabel={member.removal.buttonLabel}>
              <Symbol name="minus.circle" size={20} color="red" />
            </Pressable>
          )}
        </Pressable>
      )}
      ListFooterComponent={model.canAddMembers ? (
        <Pressable onPress={() => navigation.navigate('AddToChat', { chatId })} style={s.add}>
          <Symbol name="plus.circle" size={18} color="blue" />
          <Text style={{ color: C.blue, fontSize: 16 }}>{CHAT_INFO_COPY.add}</Text>
        </Pressable>
      ) : undefined}
    />
  )
}

const Separator = () => <View style={s.sep} />

const s = StyleSheet.create({
  top: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, gap: 4 },
  head: { fontSize: 13, fontWeight: '700', color: C.secondary, paddingTop: 12 },
  fact: { fontSize: 13, color: C.secondary },
  gone: { color: C.secondary, padding: 16, backgroundColor: C.background, flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9 },
  name: { fontSize: 17, color: C.label },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 54 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
})
