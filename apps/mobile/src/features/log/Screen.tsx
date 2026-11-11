// An agent's journal, here or on another computer: messages it got, its words, tools and results. Earlier pages load at
// the top; what it writes follows below, fetched when its activity changes, every minute, and on the refresh button. Renders log/model.ts.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { C } from '../../design/colors.ts'
import { HeaderIcon } from '../../design/form.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { LOG_COPY, LOG_FOLLOW_EVERY_MS, LogReader } from './model.ts'
import type { LogPosition, LogTone } from './model.ts'
import type { LogPage } from '@ouro/contract'
import type { ApiResult } from '../../core/session/serverApi.ts'

const toneColor: Record<LogTone, string> = { incoming: C.blue as string, words: C.label as string, tool: C.orange as string, result: C.secondary as string, notice: C.gray as string }

export function LogScreen({ route, navigation }: ScreenProps<'Log'>) {
  const session = useSession()
  useSessionVersion(session)
  const agent = agentByRef(session.store, route.params.agentRef)
  const agentId = agent?.id ?? route.params.agentRef
  return <LogView navigation={navigation} title={`${agent?.name ?? route.params.agentRef} · log`}
    read={(position) => session.api.log(agentId, position)} lastActivityAt={agent?.lastActivityAt ?? 0} />
}

/** An agent on another computer: its log is read from there, through this server. */
export function RemoteLogScreen({ route, navigation }: ScreenProps<'RemoteLog'>) {
  const session = useSession()
  useSessionVersion(session)
  const { remoteAgentId } = route.params
  const remote = session.store.remoteAgents.get(remoteAgentId)
  return <LogView navigation={navigation} title={`${remote?.address ?? remoteAgentId} · log`}
    read={(position) => session.api.remoteLog(remoteAgentId, position)} lastActivityAt={Math.max(remote?.details?.lastActivityAt ?? 0, remote?.details?.state.since ?? 0)} />
}

function LogView({ navigation, title, read, lastActivityAt }: {
  navigation: ScreenProps<'Log'>['navigation'] | ScreenProps<'RemoteLog'>['navigation']
  title: string
  read: (position: LogPosition) => Promise<ApiResult<LogPage>>
  /** When it changes, what the agent wrote since is fetched. */
  lastActivityAt: number
}) {
  const [reader] = useState(() => {
    let notify = () => {}
    const created = new LogReader({ read, onChange: () => notify() })
    return { reader: created, subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {} } } }
  })
  const state = useSyncExternalStore(reader.subscribe, () => reader.reader.state)

  useEffect(() => { void reader.reader.follow() }, [reader, lastActivityAt])
  useEffect(() => {
    const timer = setInterval(() => { void reader.reader.follow() }, LOG_FOLLOW_EVERY_MS)
    return () => clearInterval(timer)
  }, [reader])
  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerRight: () => <HeaderIcon symbol="arrow.clockwise" onPress={() => { void reader.reader.follow() }} />,
    })
  }, [navigation, title, reader])

  // Inverted: the newest line sits at the bottom and new ones keep it in view; "Earlier" is the footer, on top.
  const newestFirst = [...(state.lines ?? [])].reverse()
  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <FlatList
        inverted
        data={newestFirst}
        keyExtractor={(line) => line.key}
        contentContainerStyle={{ padding: 8 }}
        renderItem={({ item }) => (
          <Text selectable style={{ fontFamily: 'Menlo', fontSize: 12, lineHeight: 16, color: toneColor[item.tone], marginVertical: 1 }}>{item.text}</Text>
        )}
        ListHeaderComponent={state.failure !== null ? <Text style={{ color: C.red, fontSize: 13, paddingVertical: 6 }}>{state.failure}</Text> : undefined}
        ListFooterComponent={state.hasEarlier ? (
          <Pressable onPress={() => { void reader.reader.loadEarlier() }} disabled={state.loading} style={{ alignItems: 'center', padding: 10 }}>
            <Text style={{ color: state.loading ? C.secondary : C.accent, fontSize: 13 }}>{state.loading ? LOG_COPY.loading : LOG_COPY.earlier}</Text>
          </Pressable>
        ) : state.lines === null ? <ActivityIndicator style={{ margin: 20 }} /> : undefined}
        ListEmptyComponent={state.lines !== null && state.failure === null ? <Text style={{ color: C.secondary, padding: 12 }}>{LOG_COPY.empty}</Text> : undefined}
      />
    </View>
  )
}
