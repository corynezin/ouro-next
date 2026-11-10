// Every agent's latest summary, in list order; a name opens that agent's summaries. Renders summaries/model.ts.
import { Pressable, SectionList, Text, View } from 'react-native'
import { C } from '../../design/colors.ts'
import { useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { StateDot } from '../shared/StateDot.tsx'
import { allSummariesModel, NO_SUMMARY_YET_IN_LIST } from './model.ts'

const card = { backgroundColor: C.secondaryBackground, borderRadius: 10, marginHorizontal: 16, padding: 12, gap: 4 } as const

export function AllSummariesScreen({ navigation }: ScreenProps<'AllSummaries'>) {
  const session = useSession()
  useSessionVersion(session)
  const now = useNow(30_000)
  const cards = allSummariesModel(session.store, now)
  return (
    <SectionList
      style={{ flex: 1, backgroundColor: C.groupedBackground }}
      contentContainerStyle={{ paddingBottom: 30 }}
      sections={cards.map((agent) => ({ key: agent.agentId, agent, data: [agent] }))}
      keyExtractor={(agent) => agent.agentId}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section: { agent } }) => (
        <Pressable onPress={() => navigation.push('Summaries', { agentRef: agent.agentId })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 32, marginTop: 18, marginBottom: 6 }}>
          <StateDot kind={agent.dot} />
          <Text style={{ color: C.secondary, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>{agent.name}</Text>
          <View style={{ flex: 1 }} />
          {agent.ageText !== null ? <Text style={{ color: C.secondary, fontSize: 11 }}>{agent.ageText}</Text> : null}
          <Text style={{ color: C.secondary, fontSize: 13 }}>›</Text>
        </Pressable>
      )}
      renderItem={({ item: agent }) => (
        <View style={card}>
          {agent.latest ? (
            <>
              <Text selectable style={{ color: C.label, fontSize: 15 }}>{agent.latest.line}</Text>
              {agent.latest.details.map((detail, index) => <Text key={index} selectable style={{ color: C.secondary, fontSize: 13 }}>· {detail}</Text>)}
              {agent.latest.beforeLatestTurn ? <Text style={{ color: C.secondary, fontSize: 11 }}>before its latest turn</Text> : null}
            </>
          ) : <Text style={{ color: C.secondary }}>{NO_SUMMARY_YET_IN_LIST}</Text>}
        </View>
      )}
    />
  )
}
