// The agents list, the root screen: Asks, one list by latest activity, Idle folding, search, swipe actions. Renders agents/model.ts.
import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import type { AgentEntity, CommandInput, CommandName } from '@ouro/contract'
import { STOP_ATTEMPTS } from '../../core/session/serverApi.ts'
import { AskChoices } from '../../design/AskChoices.tsx'
import { Avatar } from '../../design/Avatar.tsx'
import { C } from '../../design/colors.ts'
import { barButton, confirm } from '../../design/menus.tsx'
import { SwipeRow } from '../../design/SwipeRow.tsx'
import type { SwipeAction } from '../../design/SwipeRow.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { toast } from '../../design/Toast.tsx'
import { otaLabel } from '../../design/theme.ts'
import { runningCodeText } from '../../core/updates/updateFlow.ts'
import { runningCode } from '../../native/updates.ts'
import { useCore, useNow, useOtherServersUnread, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { ChoiceTapGuard, directSend } from '../chat/model.ts'
import { StateDot } from '../shared/StateDot.tsx'
import { listOrder, nextUnread, quickSnooze } from '../shared/agentFacts.ts'
import type { Asker } from '../shared/agentFacts.ts'
import type { NewSend } from '../../core/session/outbox.ts'
import { openSnoozeSheet, snoozeAsk } from '../shared/snoozeSheet.ts'
import { agentsListModel, otherServersUnreadTotal, swipeActionsOf } from './model.ts'
import type { AgentRowModel, AskRowModel, ListedRow, MasterCardModel, NoteRow } from './model.ts'
import { remoteActionsOf, REMOTE_COPY, remoteSend } from '../remoteAgent/model.ts'
import type { RemoteActionModel, RemoteAgentRowModel } from '../remoteAgent/model.ts'

const LIST_TICK_MS = 30_000

type Row =
  | ListedRow
  | { kind: 'ask'; row: AskRowModel }
  | { kind: 'note'; note: NoteRow | { kind: 'empty'; text: string } }
interface Sec { key: string; header: { kind: 'idle'; count: number } | { kind: 'asks'; text: string; tone: 'orange' | 'secondary' } | null; data: Row[] }

const noteColor = { offline: 'orange', unpaired: 'red', failure: 'red', empty: 'secondary' } as const

export function AgentsScreen({ navigation }: ScreenProps<'Agents'>) {
  const core = useCore()
  const session = useSession()
  const version = useSessionVersion(session)
  // Ticks fast while down, so "Offline" appears when the grace ends rather than at the next half-minute.
  const now = useNow(session.connection.downSince === null ? LIST_TICK_MS : 1000)
  const [idleOpen, setIdleOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [choiceGuard] = useState(() => new ChoiceTapGuard())
  const { store } = session
  const fold = core.preferences.current.idleFold

  useEffect(() => session.followPlanUsage(), [session])

  const model = useMemo(
    () => agentsListModel(store, { connection: session.connection, fold, query, failureNote: notice, now: Math.max(now, Date.now()) }),
    [version, now, fold, query, notice],
  )

  const sections = useMemo(() => {
    const out: Sec[] = []
    if (model.notes.length) out.push({ key: 'notes', header: null, data: model.notes.map((note) => ({ kind: 'note', note })) })
    if (model.search) {
      const empty: Row[] = model.search.emptyText ? [{ kind: 'note', note: { kind: 'empty', text: model.search.emptyText } }] : []
      out.push({ key: 'search', header: null, data: [...model.search.rows, ...empty] })
      return out
    }
    if (model.asks) out.push({ key: 'asks', header: { kind: 'asks', text: model.asks.headerText, tone: model.asks.headerTone }, data: model.asks.rows.map((row) => ({ kind: 'ask', row })) })
    if (model.awake.length) out.push({ key: 'awake', header: null, data: model.awake })
    if (model.idle.length) out.push({ key: 'idle', header: { kind: 'idle', count: model.idle.length }, data: idleOpen ? model.idle : [] })
    if (model.emptyText) out.push({ key: 'empty', header: null, data: [{ kind: 'note', note: { kind: 'empty', text: model.emptyText } }] })
    return out
  }, [model, idleOpen])

  const open = (agentId: string) => navigation.navigate('Chat', { agentRef: agentId })
  const openRemote = (remoteAgentId: string) => navigation.navigate('RemoteChat', { remoteAgentId })

  const act = async <N extends CommandName>(name: N, input: CommandInput<N>, attempts = 1) => {
    setNotice(null)
    const failure = await session.commandError(name, input, attempts)
    setNotice(failure)
    void Haptics.notificationAsync(failure ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success)
  }

  const swipes = (agentId: string): SwipeAction[] => {
    const agent = store.agents.get(agentId)
    if (!agent) return []
    return swipeActionsOf(store, agent).flatMap((action): SwipeAction[] => {
      const target = { agentId: agent.id }
      switch (action.kind) {
        case 'interrupt': return [{ title: 'Interrupt', color: C.orange, onPress: () => { void act('interrupt_agent', target) } }]
        case 'stop': return [{ title: 'Stop', color: C.red, onPress: () => { void act('stop_agent', target, STOP_ATTEMPTS) } }]
        case 'archive': return [{ title: 'Archive', color: C.gray, onPress: () => confirm(`Archive ${agent.name}?`,
          'It stops and leaves the list; nothing is deleted (Archived brings it back).', 'Archive', () => { void act('archive_agent', target) }) }]
        case 'pause_goal': return [{ title: 'Pause goal', color: C.yellow, onPress: () => { void act('pause_goal', { agentId: agent.id, reason: null }) } }]
        case 'resume_goal': return [{ title: 'Resume goal', color: C.yellow, onPress: () => { void act('resume_goal', target) } }]
      }
    })
  }

  const remoteSwipes = (remoteAgentId: string): SwipeAction[] => {
    const remote = store.remoteAgents.get(remoteAgentId)
    const computer = remote && store.computers.get(remote.computerId)
    if (!remote || !computer) return []
    const control = (action: RemoteActionModel) => { void act('control_remote_agent', { remoteAgentId, action }) }
    return remoteActionsOf(remote, computer).map((action): SwipeAction => {
      switch (action.kind) {
        case 'interrupt': return { title: 'Interrupt', color: C.orange, onPress: () => control(action) }
        case 'stop': return { title: 'Stop', color: C.red, onPress: () => control(action) }
        case 'archive': return { title: 'Archive', color: C.gray, onPress: () => confirm(REMOTE_COPY.archiveTitle(remote.name), REMOTE_COPY.archiveMessage, 'Archive', () => control(action)) }
      }
    })
  }

  const openAsker = (asker: Asker) => (asker.kind === 'local' ? open(asker.agentId) : openRemote(asker.remoteAgentId))
  /** False for a tap that sends nothing (the guard ignores it, or its asker is gone), so it doesn't buzz either. */
  const answerAsk = (row: AskRowModel, choice: string): boolean => {
    const send = answerSendOf(row.asker, choice, row.askId)
    if (!send || !choiceGuard.accept(row.askId, Date.now())) return false
    session.outbox.send(send)
    return true
  }
  const answerSendOf = (asker: Asker, choice: string, askId: string): NewSend | null => {
    if (asker.kind === 'local') {
      const agent = store.agents.get(asker.agentId)
      return agent ? directSend(agent, choice, [], askId) : null
    }
    const remote = store.remoteAgents.get(asker.remoteAgentId)
    return remote ? remoteSend(remote, choice, askId) : null
  }

  const removeThisServer = () => {
    core.removeServer(session.serverId).catch(() => toast('Could not remove saved server.', 'exclamationmark.triangle'))
  }

  const refresh = async () => {
    setRefreshing(true)
    await session.refresh()
    setRefreshing(false)
  }

  const goToNextUnread = () => {
    const at = Date.now()
    const { awake, idle } = listOrder(store, fold, at)
    const next = nextUnread(store, null, [...awake, ...idle], at)
    if (next) open(next.id)
  }

  const otherServers = useOtherServersUnread()
  const elsewhere = otherServersUnreadTotal(otherServers.counts, session.serverId)
  // Read once when the list opens; after that, on each return to the foreground (at most once a minute).
  useEffect(() => { void otherServers.checkIfDue() }, [otherServers, session])
  const others = model.nextUnreadCount
  const groupUnread = model.groupChatUnread
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Ouro',
      unstable_headerLeftItems: () => [barButton('gearshape', 'Settings', () => navigation.navigate('Settings'))],
      unstable_headerRightItems: () => [
        barButton('chevron.forward.2', others ? `Next unread, ${others}` : 'No other unread', goToNextUnread, { disabled: others === 0, badge: others }),
        barButton('bubble.left.and.text.bubble.right', groupUnread ? `Chats, ${groupUnread} unread` : 'Chats', () => navigation.navigate('Chats'), { badge: groupUnread }),
        barButton('plus', 'New agent', () => navigation.navigate('New')),
      ],
      headerSearchBarOptions: {
        placeholder: 'Agents, tasks, messages', onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(''), hideWhenScrolling: false, autoCapitalize: 'none',
      },
    })
  }, [navigation, others, groupUnread])

  return (
    <SectionList<Row, Sec>
      sections={sections}
      keyExtractor={(row, index) => row.kind === 'local' ? row.row.agentId : row.kind === 'remote' ? `remote:${row.row.remoteAgentId}` : row.kind === 'ask' ? `ask:${row.row.askId}` : `note${index}`}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      stickySectionHeadersEnabled={false}
      style={{ backgroundColor: C.background }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh() }} />}
      ListHeaderComponent={
        <View>
          <Text style={s.screenTitle} accessibilityRole="header">Ouro</Text>
          <View style={s.top}>
            <Symbol name="circle.fill" size={7} color={model.dotColor} />
            {elsewhere > 0 && (
              <Pressable onPress={() => navigation.navigate('Servers')} style={s.elsewhere} accessibilityLabel={`${elsewhere} unread on other servers`}>
                <View style={s.miniBadge}><Text style={s.miniBadgeText}>{elsewhere}</Text></View>
                <Symbol name="chevron.down" size={7} color="secondary" />
              </Pressable>
            )}
            {model.usageLine !== null && <Text style={s.topText}>{model.usageLine}</Text>}
          </View>
          {model.master && !query.trim() && <MasterCard card={model.master} agent={store.agents.get(model.master.agentId)} onOpen={open} />}
        </View>
      }
      renderSectionHeader={({ section }) => <SectionHeader header={section.header} idleOpen={idleOpen} toggleIdle={() => setIdleOpen(!idleOpen)} />}
      renderItem={({ item }) => {
        if (item.kind === 'note') {
          return (
            <View style={s.note}>
              <Text style={{ color: C[noteColor[item.note.kind]], fontSize: 14 }}>{item.note.text}</Text>
              {item.note.kind === 'unpaired' && <Pressable onPress={removeThisServer}><Text style={{ color: C.blue, marginTop: 6 }}>Remove this server</Text></Pressable>}
            </View>
          )
        }
        if (item.kind === 'ask') {
          const { row } = item
          // A remote ask's copy snoozes the same way: the server passes the snooze to the ask's own computer.
          const quick = quickSnooze(row.snoozed, Date.now())
          const swipe = [{ title: quick.title, color: C.indigo, onPress: () => { void snoozeAsk(session, row.askId, quick.snooze, setNotice) } }]
          const sheet = () => openSnoozeSheet(session, row, setNotice, [{ title: 'Open conversation', onPress: () => openAsker(row.asker) }])
          return <SwipeRow actions={swipe}><AskRow row={row} onOpen={openAsker} onLongPress={sheet} onChoose={answerAsk} /></SwipeRow>
        }
        if (item.kind === 'remote') return <SwipeRow actions={remoteSwipes(item.row.remoteAgentId)}><RemoteAgentRow {...item.row} onOpen={openRemote} /></SwipeRow>
        return <SwipeRow actions={swipes(item.row.agentId)}><AgentRow {...item.row} onOpen={open} /></SwipeRow>
      }}
      ItemSeparatorComponent={Separator}
      ListFooterComponent={<View style={{ padding: 16 }}><Text style={s.foot}>{otaLabel}</Text><Text style={s.foot}>{runningCodeText(runningCode())}</Text></View>}
    />
  )
}

const Separator = () => <View style={s.sep} />

function SectionHeader({ header, idleOpen, toggleIdle }: { header: Sec['header']; idleOpen: boolean; toggleIdle: () => void }) {
  if (!header) return null
  if (header.kind === 'idle') {
    return (
      <Pressable onPress={toggleIdle} style={s.header} accessibilityLabel={`Idle, ${header.count} agents`}>
        <Symbol name={idleOpen ? 'chevron.down' : 'chevron.right'} size={10} color="secondary" />
        <Text style={s.headerText}>Idle ({header.count})</Text>
      </Pressable>
    )
  }
  return <View style={s.header}><Text style={[s.headerText, { color: C[header.tone] }]}>{header.text}</Text></View>
}

function MasterCard({ card, agent, onOpen }: { card: MasterCardModel; agent: AgentEntity | undefined; onOpen: (agentId: string) => void }) {
  return (
    <Pressable onPress={() => onOpen(card.agentId)} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]} accessibilityLabel="Master agent">
      <View style={s.icon}><Symbol name="sparkles" size={20} color="white" /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={s.line}>
          <Text style={s.cardTitle}>Master</Text>
          {agent && <StateDot kind={card.dot} />}
          <View style={{ flex: 1 }} />
          <Text style={s.small}>{card.timeText}</Text>
        </View>
        <Text style={s.cardSub} numberOfLines={1}>{card.statusText}</Text>
        {card.previewText !== null && <Text style={[s.cardSub, { color: C.label }]} numberOfLines={2}>{card.previewText}</Text>}
      </View>
      {card.unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{card.unread}</Text></View>}
    </Pressable>
  )
}

// Every prop is a primitive or a stable function, so this draws again only when something it shows changed.
const AgentRow = memo(function AgentRow(row: AgentRowModel & { onOpen: (agentId: string) => void }) {
  return (
    <Pressable onPress={() => row.onOpen(row.agentId)} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}>
      <View style={s.rowInner}>
        <Avatar seed={row.name} kind="agent" model={row.model} size={52} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={s.line}>
            <Text style={s.name} numberOfLines={1}>{row.name}</Text>
            {row.goalMarker !== null && row.goalColor !== null && <Text style={{ fontSize: 15, color: C[row.goalColor] }}>{row.goalMarker}</Text>}
            {row.runningOldRelease && <Text style={{ fontSize: 12, fontWeight: '700', color: C.yellow }} accessibilityLabel="old build">↑</Text>}
            <View style={{ flex: 1 }} />
            {row.costText !== null && <Text style={s.small}>{`${row.costText} · `}</Text>}
            <Text style={s.small}>{row.timeText}</Text>
          </View>
          <Text style={[s.sub, { color: row.statusTone === 'busy' ? C.blue : C.secondary }]} numberOfLines={1}>{row.statusText}</Text>
          {row.summaryLine !== null && <Text style={[s.sub, { color: C.label }]}>{row.summaryLine}</Text>}
          {row.previewText !== null && <Text style={s.sub} numberOfLines={row.previewLines}>{row.previewText}</Text>}
        </View>
        {row.askSymbolName !== null && row.askSymbolColor !== null && (
          // `accessible` keeps this view: a view with only a label is flattened away, and VoiceOver reads the symbol's name.
          <View accessible accessibilityRole="image" accessibilityLabel={`${row.askCount} open ask${row.askCount === 1 ? '' : 's'}`}>
            <Symbol name={row.askSymbolName} color={row.askSymbolColor} size={18} />
          </View>
        )}
        {row.unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{row.unread}</Text></View>}
      </View>
    </Pressable>
  )
})

// The reference's remote row: the bare name with its computer small beside it, and no goal, cost or asks to show.
const RemoteAgentRow = memo(function RemoteAgentRow(row: RemoteAgentRowModel & { onOpen: (remoteAgentId: string) => void }) {
  return (
    <Pressable onPress={() => row.onOpen(row.remoteAgentId)} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}>
      <View style={[s.rowInner, row.statusTone === 'offline' && { opacity: 0.5 }]}>
        <Avatar seed={row.name} kind="agent" model={row.model ?? undefined} size={52} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={s.line}>
            <Text style={s.name} numberOfLines={1}>{row.name}<Text style={s.small}>{` @${row.computerName}`}</Text></Text>
            <View style={{ flex: 1 }} />
            {row.timeText !== null && <Text style={s.small}>{row.timeText}</Text>}
          </View>
          <Text style={[s.sub, { color: row.statusTone === 'busy' ? C.blue : row.statusTone === 'offline' ? C.orange : C.secondary }]} numberOfLines={1}>{row.statusText}</Text>
          {row.summaryLine !== null && <Text style={[s.sub, { color: C.label }]}>{row.summaryLine}</Text>}
          {row.previewText !== null && <Text style={s.sub} numberOfLines={row.previewLines}>{row.previewText}</Text>}
        </View>
        {row.unread > 0 && <View style={s.badge}><Text style={s.badgeText}>{row.unread}</Text></View>}
      </View>
    </Pressable>
  )
})

function AskRow({ row, onOpen, onLongPress, onChoose }: {
  row: AskRowModel; onOpen: (asker: Asker) => void; onLongPress: (() => void) | undefined; onChoose: (row: AskRowModel, choice: string) => boolean
}) {
  return (
    <Pressable onPress={() => onOpen(row.asker)} onLongPress={onLongPress} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}>
      <View style={[s.rowInner, { opacity: row.snoozed ? 0.5 : 1 }]}>
        <View style={{ paddingTop: 2 }}><Symbol name={row.symbolName} color={row.symbolColor} size={18} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={s.line}>
            <Text style={[s.name, { flex: 1 }]} numberOfLines={1}>{row.agentName}</Text>
            <Text style={s.small}>{row.timeText}</Text>
          </View>
          <Text style={[s.sub, { color: C.label }]} numberOfLines={3}>{row.text}</Text>
          {row.choices.length > 0 && <AskChoices choices={row.choices} compact onChoose={(choice) => onChoose(row, choice)} />}
        </View>
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  screenTitle: { color: C.label, fontSize: 34, fontWeight: '700', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingBottom: 6 },
  topText: { color: C.secondary, fontSize: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 9 },
  rowInner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 17, fontWeight: '600', color: C.label, flexShrink: 1 },
  small: { fontSize: 12, color: C.secondary, fontWeight: '400' },
  sub: { fontSize: 15, color: C.secondary },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.separator, marginLeft: 52 },
  badge: { backgroundColor: C.blue, borderRadius: 11, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, alignSelf: 'center' },
  badgeText: { color: 'white', fontWeight: '700', fontSize: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  headerText: { fontSize: 13, fontWeight: '700', color: C.secondary },
  note: { paddingHorizontal: 16, paddingVertical: 10 },
  elsewhere: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  miniBadge: { backgroundColor: C.red, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  miniBadgeText: { color: 'white', fontWeight: '700', fontSize: 10 },
  foot: { color: C.secondary, fontSize: 11, textAlign: 'center', marginVertical: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginTop: 4, marginBottom: 8, padding: 12, borderRadius: 16, backgroundColor: C.secondaryBackground },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.indigo, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 18, fontWeight: '700', color: C.label },
  cardSub: { fontSize: 14, color: C.secondary },
})
