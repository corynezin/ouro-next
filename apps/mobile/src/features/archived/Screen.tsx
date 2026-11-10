// Archived agents: tap one to unarchive it. Renders archived/model.ts.
import { useLayoutEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { C } from '../../design/colors.ts'
import { actionSheet } from '../../design/menus.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { archivedRows, unarchivedNote } from './model.ts'
import type { ArchivedRow } from './model.ts'

export function ArchivedScreen({ navigation }: ScreenProps<'Archived'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const [note, setNote] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const rows = useMemo(() => archivedRows(session.store), [version])
  useLayoutEffect(() => { navigation.setOptions({ title: 'Archived' }) }, [navigation])

  const unarchive = async (row: ArchivedRow) => {
    const failure = await session.commandError('unarchive_agent', { agentId: row.agentId })
    setNote(failure ?? unarchivedNote(row.name))
  }
  const refresh = async () => {
    setRefreshing(true)
    await session.refresh()
    setRefreshing(false)
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.background }}
      data={rows}
      keyExtractor={(row) => row.agentId}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} />}
      ItemSeparatorComponent={() => <View style={{ height: 0.5, backgroundColor: C.separator, marginLeft: 16 }} />}
      ListHeaderComponent={note !== null ? <Text style={{ color: C.orange, fontSize: 13, padding: 16, paddingBottom: 4 }}>{note}</Text> : undefined}
      ListEmptyComponent={<Text style={{ color: C.secondary, padding: 16 }}>Nothing archived</Text>}
      ListFooterComponent={rows.length ? <Text style={{ color: C.secondary, fontSize: 12, padding: 16 }}>Tap an agent to unarchive it.</Text> : undefined}
      renderItem={({ item: row }) => (
        <Pressable
          onPress={() => { if (!row.nameInUse) actionSheet(row.name, [{ title: 'Unarchive', onPress: () => { void unarchive(row) } }]) }}
          style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 10, gap: 3, backgroundColor: pressed && !row.nameInUse ? C.fill : undefined })}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{ color: C.label, fontSize: 17, fontWeight: '600' }}>{row.name}</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: C.secondary, fontSize: 12 }}>{row.dateText}</Text>
          </View>
          {row.detail !== null && <Text style={{ color: C.secondary, fontSize: 15 }} numberOfLines={2}>{row.detail}</Text>}
          {row.nameInUse && <Text style={{ color: C.orange, fontSize: 12 }}>name in use by another agent</Text>}
        </Pressable>
      )}
    />
  )
}
