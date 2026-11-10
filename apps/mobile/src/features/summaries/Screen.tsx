// One agent's summaries, newest first, as dated cards; older pages load as the list reaches its end. Renders summaries/model.ts.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, RefreshControl, SectionList, Text, View } from 'react-native'
import { C } from '../../design/colors.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { SummariesReader, summariesModel, summariesTitle } from './model.ts'

const card = { backgroundColor: C.secondaryBackground, borderRadius: 10, marginHorizontal: 16, padding: 12, gap: 4 } as const
const header = { color: C.secondary, fontSize: 13, marginHorizontal: 32, marginTop: 18, marginBottom: 6 } as const
const PAGE_SIZE = 20

export function SummariesScreen({ route, navigation }: ScreenProps<'Summaries'>) {
  const session = useSession()
  useSessionVersion(session)
  const agent = agentByRef(session.store, route.params.agentRef)
  const agentId = agent?.id ?? route.params.agentRef
  const [reader] = useState(() => {
    let notify = () => {}
    const created = new SummariesReader({
      read: (position) => session.api.summaries(agentId, { beforeNumber: position.beforeNumber, limit: PAGE_SIZE }),
      onChange: () => notify(),
    })
    return { reader: created, subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {} } } }
  })
  const state = useSyncExternalStore(reader.subscribe, () => reader.reader.state)
  const [refreshing, setRefreshing] = useState(false)
  const model = summariesModel(session.store.summaries.get(agentId), state)

  useEffect(() => { void reader.reader.loadNewest() }, [reader])
  useLayoutEffect(() => {
    navigation.setOptions({ title: summariesTitle(agent?.name ?? route.params.agentRef) })
  }, [navigation, agent?.name])

  return (
    <SectionList
      style={{ flex: 1, backgroundColor: C.groupedBackground }}
      contentContainerStyle={{ paddingBottom: 30 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await reader.reader.loadNewest(); setRefreshing(false) }} />}
      sections={model.cards.map((summary) => ({ key: summary.key, title: summary.dateText, data: [summary] }))}
      keyExtractor={(summary) => summary.key}
      stickySectionHeadersEnabled={false}
      onEndReached={() => { void reader.reader.loadOlder() }}
      renderSectionHeader={({ section }) => <Text style={header}>{section.title}</Text>}
      renderItem={({ item }) => (
        <View style={card}>
          <Text selectable style={{ color: C.label, fontSize: 15 }}>{item.line}</Text>
          {item.details.map((detail, index) => <Text key={index} selectable style={{ color: C.secondary, fontSize: 13 }}>· {detail}</Text>)}
        </View>
      )}
      ListHeaderComponent={model.loading ? <ActivityIndicator style={{ margin: 24 }} /> : undefined}
      ListEmptyComponent={model.emptyText ? <Text style={{ color: C.secondary, margin: 32 }}>{model.emptyText}</Text> : undefined}
      ListFooterComponent={
        <View style={{ marginHorizontal: 32, marginTop: 12, gap: 6 }}>
          {state.loading && state.records !== null ? <ActivityIndicator /> : null}
          {model.lastAttemptFailedText ? <Text style={{ color: C.secondary, fontSize: 13 }}>{model.lastAttemptFailedText}</Text> : null}
          {model.loadFailureText ? <Text style={{ color: C.red }}>{model.loadFailureText}</Text> : null}
        </View>
      }
    />
  )
}
