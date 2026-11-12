// What an agent was sent: its model requests, and for each the system prompt, tools and messages with token counts.
// Renders context/model.ts; the server rebuilds it from the agent's transcript. The list follows the agent's activity,
// at most every CONTEXT_FOLLOW_EVERY_MS, and on pull to refresh.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { ContextBlock, ContextBlockPlace, ContextBlockText, ContextDetail } from '@ouro/contract'
import { C, color } from '../../design/colors.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { CATEGORY_COLORS, CONTEXT_COPY, ContextReader, followDelayMs, Loader, percentOf, requestSubtitle, requestTitle, tokensText, usageSummary } from './model.ts'

const mono = { fontFamily: 'Menlo', fontSize: 12, lineHeight: 16 } as const

/** A model object that tells React when it changes, made once per screen and closed when the screen goes. */
function useModel<M extends { state: unknown; close: () => void }>(make: (onChange: () => void) => M): { model: M; state: M['state'] } {
  const [made] = useState(() => {
    let notify = () => {}
    const model = make(() => notify())
    return { model, subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {} } } }
  })
  useEffect(() => () => made.model.close(), [made])
  return { model: made.model, state: useSyncExternalStore(made.subscribe, () => made.model.state) }
}

export function ContextScreen({ route, navigation }: ScreenProps<'Context'>) {
  const session = useSession()
  useSessionVersion(session)
  const agent = agentByRef(session.store, route.params.agentRef)
  const agentId = agent?.id ?? route.params.agentRef
  const { model: reader, state } = useModel((onChange) => new ContextReader({ read: (before) => session.api.contextList(agentId, before), onChange }))
  const lastActivityAt = agent?.lastActivityAt ?? 0
  // Activity ticks on every word and tool call; look again at most every CONTEXT_FOLLOW_EVERY_MS.
  const lastFollow = useRef(0)
  useEffect(() => {
    const timer = setTimeout(() => { lastFollow.current = Date.now(); void reader.follow() }, followDelayMs(lastFollow.current, Date.now()))
    return () => clearTimeout(timer)
  }, [reader, lastActivityAt])
  useLayoutEffect(() => { navigation.setOptions({ title: CONTEXT_COPY.screenTitle(agent?.name ?? route.params.agentRef) }) }, [navigation, agent?.name, route.params.agentRef])
  const notice = state.failure ? <Text style={{ color: C.red, padding: 12 }}>{state.failure}</Text>
    : state.unavailable ? <Text style={{ color: C.secondary, padding: 12 }}>{CONTEXT_COPY.unavailable[state.unavailable]}</Text> : undefined
  return (
    <FlatList
      style={{ backgroundColor: C.background }}
      data={state.rows ?? []}
      keyExtractor={(row) => String(row.n)}
      refreshControl={<RefreshControl refreshing={state.loading && state.rows !== null} onRefresh={() => { void reader.follow() }} />}
      ListHeaderComponent={notice}
      ListEmptyComponent={state.rows === null && !state.failure ? <ActivityIndicator style={{ margin: 20 }} /> : state.rows && !state.unavailable ? <Text style={{ color: C.secondary, padding: 12 }}>{CONTEXT_COPY.empty}</Text> : undefined}
      ListFooterComponent={state.hasOlder ? (
        <Pressable onPress={() => { void reader.loadOlder() }} disabled={state.loading} style={{ alignItems: 'center', padding: 10 }}>
          <Text style={{ color: state.loading ? C.secondary : C.accent, fontSize: 13 }}>{state.loading ? CONTEXT_COPY.loading : CONTEXT_COPY.older}</Text>
        </Pressable>
      ) : undefined}
      renderItem={({ item }) => (
        <Pressable onPress={() => navigation.navigate('ContextRequest', { agentRef: agentId, n: item.n })}
          style={({ pressed }) => ({ padding: 12, borderBottomWidth: 0.5, borderColor: C.separator, backgroundColor: pressed ? C.pressed : C.background })}>
          <Text style={{ color: C.label, fontSize: 15 }}>{requestTitle(item.n, item.at)}  <Text style={{ color: C.accent }}>{tokensText(item.inputTokens)} in</Text></Text>
          <Text style={{ color: C.secondary, fontSize: 12 }}>{requestSubtitle(item)}</Text>
        </Pressable>
      )}
    />
  )
}

function Collapsible({ title, tokens, tag, children, open = false }: { title: string; tokens?: number; tag?: string; children: ReactNode; open?: boolean }) {
  const [shown, setShown] = useState(open)
  return (
    <View style={{ borderTopWidth: 0.5, borderColor: C.separator }}>
      <Pressable onPress={() => setShown(!shown)} style={{ flexDirection: 'row', padding: 10, gap: 8 }}>
        <Text style={{ color: C.label, fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1}>{shown ? '▾' : '▸'} {title}{tag ? <Text style={{ color: C.secondary, fontWeight: '400' }}>  {tag}</Text> : null}</Text>
        {tokens !== undefined && <Text style={{ color: C.secondary, fontSize: 12 }}>{CONTEXT_COPY.tokens(tokens)}</Text>}
      </Pressable>
      {shown && children}
    </View>
  )
}

/** A block as the server sent it; one it cut has a button that fetches the rest. */
function BlockView({ block, load }: { block: ContextBlock; load: () => Promise<ApiResult<ContextBlockText>> }) {
  const { model: full, state } = useModel((onChange) => new Loader({ read: load, onChange }))
  const whole = state.value?.text ?? null
  return (
    <View style={{ paddingHorizontal: 10, paddingBottom: 8 }}>
      <Text style={{ color: C.secondary, fontSize: 11 }}>{block.type === 'other' ? block.label : block.type}{block.label && block.type !== 'other' ? ` · ${block.label}` : ''} · {CONTEXT_COPY.tokens(block.tokens)}</Text>
      <Text selectable style={{ ...mono, color: C.label }}>{whole ?? block.text}</Text>
      {block.truncated && whole === null && (
        <Pressable onPress={() => { void full.load() }} disabled={state.loading}>
          <Text style={{ color: state.failure ? C.red : C.accent, fontSize: 13, paddingVertical: 4 }}>
            {state.loading ? CONTEXT_COPY.loading : state.failure ? CONTEXT_COPY.fullFailed : CONTEXT_COPY.showFull}
          </Text>
        </Pressable>
      )}
      {whole !== null && (
        <Pressable onPress={() => full.clear()}><Text style={{ color: C.accent, fontSize: 13, paddingVertical: 4 }}>{CONTEXT_COPY.showLess}</Text></Pressable>
      )}
    </View>
  )
}

function Detail({ detail, loadText }: { detail: ContextDetail; loadText: (where: ContextBlockPlace) => Promise<ApiResult<ContextBlockText>> }) {
  const total = detail.categories.reduce((sum, category) => sum + category.tokens, 0)
  return (
    <ScrollView style={{ backgroundColor: C.background }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 12 }}>
        <Text style={{ color: C.label, fontSize: 22, fontWeight: '700' }}>{CONTEXT_COPY.totalTokens(detail.totalInput)}</Text>
        <Text style={{ color: C.secondary, fontSize: 12 }}>{usageSummary(detail)}</Text>
        <View style={{ flexDirection: 'row', height: 14, borderRadius: 3, overflow: 'hidden', marginVertical: 10, backgroundColor: C.fill }}>
          {detail.categories.map((category) => <View key={category.name} style={{ width: `${percentOf(category.tokens, total)}%`, backgroundColor: color(CATEGORY_COLORS[category.name]) }} />)}
        </View>
        {detail.categories.map((category) => (
          <View key={category.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 1 }}>
            <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: color(CATEGORY_COLORS[category.name]) }} />
            <Text style={{ color: C.label, fontSize: 13, flex: 1 }}>{CONTEXT_COPY.categories[category.name]}</Text>
            <Text style={{ color: C.secondary, fontSize: 13 }}>{tokensText(category.tokens)} · {percentOf(category.tokens, total)}%</Text>
          </View>
        ))}
        <Text style={{ color: C.tertiary, fontSize: 11, marginTop: 6 }}>{detail.exact ? CONTEXT_COPY.exactNote : CONTEXT_COPY.estimateNote}</Text>
      </View>
      <Collapsible title={CONTEXT_COPY.systemPrompt} tokens={detail.system.reduce((sum, block) => sum + block.tokens, 0)}>
        {detail.system.map((block, index) => <BlockView key={index} block={block} load={() => loadText({ part: 'system', item: index, block: 0 })} />)}
      </Collapsible>
      <Collapsible title={CONTEXT_COPY.tools(detail.tools.length)} tokens={detail.tools.reduce((sum, tool) => sum + tool.tokens, 0)}>
        {detail.tools.map((tool, index) => (
          <View key={index} style={{ paddingHorizontal: 10, paddingBottom: 6 }}>
            <Text style={{ color: C.label, fontSize: 13 }}>{tool.name}  <Text style={{ color: C.secondary }}>{CONTEXT_COPY.tokens(tool.tokens)}</Text></Text>
            <Text style={{ color: C.secondary, fontSize: 11 }} numberOfLines={2}>{tool.description}</Text>
          </View>
        ))}
      </Collapsible>
      {detail.messages.map((message, index) => message.kind === 'unresolved'
        ? <Collapsible key={index} title={CONTEXT_COPY.unresolvedTitle(index)} tag={CONTEXT_COPY.unresolved}>{null}</Collapsible>
        : (
          <Collapsible key={index} title={CONTEXT_COPY.messageTitle(index, message.role)} tag={message.blocks.map((block) => block.type).join(', ')}
            tokens={message.blocks.reduce((sum, block) => sum + block.tokens, 0)} open={index >= detail.messages.length - 2}>
            {message.blocks.map((block, k) => <BlockView key={k} block={block} load={() => loadText({ part: 'message', item: index, block: k })} />)}
          </Collapsible>
        ))}
      <Collapsible title={CONTEXT_COPY.reply} open>
        {detail.response.map((block, index) => <BlockView key={index} block={block} load={() => loadText({ part: 'response', item: 0, block: index })} />)}
      </Collapsible>
    </ScrollView>
  )
}

export function ContextRequestScreen({ route, navigation }: ScreenProps<'ContextRequest'>) {
  const session = useSession()
  const { agentRef, n } = route.params
  const { model: loader, state } = useModel((onChange) => new Loader({ read: () => session.api.contextDetail(agentRef, n), onChange }))
  useEffect(() => { void loader.load() }, [loader])
  useLayoutEffect(() => { navigation.setOptions({ title: CONTEXT_COPY.requestScreenTitle(n) }) }, [navigation, n])
  if (state.value) return <Detail detail={state.value} loadText={(where) => session.api.contextText(agentRef, n, where)} />
  return state.failure ? <Text style={{ color: C.red, padding: 12 }}>{state.failure}</Text> : <ActivityIndicator style={{ margin: 20 }} />
}
