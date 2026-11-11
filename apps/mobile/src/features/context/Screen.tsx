// What an agent was sent: its model requests, and for each the system prompt, tools and messages with token counts.
// Renders context/model.ts; the server rebuilds it from the agent's transcript.
import { useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { ContextBlock, ContextBlockPlace, ContextBlockText, ContextDetail, ContextList } from '@ouro/contract'
import { C, color } from '../../design/colors.ts'
import { failureText } from '../../core/session/serverApi.ts'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { CATEGORY_COLORS, CONTEXT_COPY, percentOf, requestSubtitle, requestTitle, tokensText, usageSummary } from './model.ts'

const mono = { fontFamily: 'Menlo', fontSize: 12, lineHeight: 16 } as const

/** Loads once per change of `deps`; `reload` loads again. What's shown stays until an answer replaces it. */
function useLoaded<T>(load: () => Promise<ApiResult<T>>, deps: unknown[]) {
  const [state, setState] = useState<{ value: T | null; failure: string | null }>({ value: null, failure: null })
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    void load().then((result) => {
      if (!live) return
      setState((shown) => (result.ok ? { value: result.value, failure: null } : { value: shown.value, failure: failureText(result.failure) }))
      setLoading(false)
    })
    return () => { live = false }
  }, [...deps, attempt]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, loading, reload: () => setAttempt((count) => count + 1) }
}

export function ContextScreen({ route, navigation }: ScreenProps<'Context'>) {
  const session = useSession()
  useSessionVersion(session)
  const agent = agentByRef(session.store, route.params.agentRef)
  const agentId = agent?.id ?? route.params.agentRef
  // A new request shows once the agent has done something since.
  const { value, failure, loading, reload } = useLoaded<ContextList>(() => session.api.contextList(agentId), [agentId, agent?.lastActivityAt ?? 0])
  useLayoutEffect(() => { navigation.setOptions({ title: `${agent?.name ?? route.params.agentRef} · context` }) }, [navigation, agent?.name])
  const rows = [...(value?.requests ?? [])].reverse()
  return (
    <FlatList
      style={{ backgroundColor: C.background }}
      data={rows}
      keyExtractor={(row) => String(row.n)}
      refreshControl={<RefreshControl refreshing={loading && value !== null} onRefresh={reload} />}
      ListHeaderComponent={failure ? <Text style={{ color: C.red, padding: 12 }}>{failure}</Text> : value?.unavailable ? <Text style={{ color: C.secondary, padding: 12 }}>{value.unavailable}</Text> : undefined}
      ListEmptyComponent={value === null && !failure ? <ActivityIndicator style={{ margin: 20 }} /> : value && !value.unavailable ? <Text style={{ color: C.secondary, padding: 12 }}>{CONTEXT_COPY.empty}</Text> : undefined}
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
        {tokens !== undefined && <Text style={{ color: C.secondary, fontSize: 12 }}>{tokensText(tokens)} tok</Text>}
      </Pressable>
      {shown && children}
    </View>
  )
}

/** A block as the server sent it; one it cut has a button that fetches the rest. */
function BlockView({ block, load }: { block: ContextBlock; load: () => Promise<ApiResult<ContextBlockText>> }) {
  const [full, setFull] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const showFull = async () => {
    setState('loading')
    const result = await load()
    if (result.ok) setFull(result.value.text)
    setState(result.ok ? 'idle' : 'failed')
  }
  return (
    <View style={{ paddingHorizontal: 10, paddingBottom: 8 }}>
      <Text style={{ color: C.secondary, fontSize: 11 }}>{block.type}{block.label ? ` · ${block.label}` : ''} · {tokensText(block.tokens)} tok</Text>
      <Text selectable style={{ ...mono, color: C.label }}>{full ?? block.text}</Text>
      {block.truncated && full === null && (
        <Pressable onPress={() => { void showFull() }} disabled={state === 'loading'}>
          <Text style={{ color: state === 'failed' ? C.red : C.accent, fontSize: 13, paddingVertical: 4 }}>
            {state === 'loading' ? CONTEXT_COPY.loading : state === 'failed' ? CONTEXT_COPY.fullFailed : CONTEXT_COPY.showFull}
          </Text>
        </Pressable>
      )}
      {full !== null && (
        <Pressable onPress={() => setFull(null)}><Text style={{ color: C.accent, fontSize: 13, paddingVertical: 4 }}>{CONTEXT_COPY.showLess}</Text></Pressable>
      )}
    </View>
  )
}

function Detail({ detail, loadText }: { detail: ContextDetail; loadText: (where: ContextBlockPlace) => Promise<ApiResult<ContextBlockText>> }) {
  const total = detail.categories.reduce((sum, category) => sum + category.tokens, 0)
  return (
    <ScrollView style={{ backgroundColor: C.background }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ padding: 12 }}>
        <Text style={{ color: C.label, fontSize: 22, fontWeight: '700' }}>{tokensText(detail.totalInput)} tokens</Text>
        <Text style={{ color: C.secondary, fontSize: 12 }}>{usageSummary(detail)}</Text>
        <View style={{ flexDirection: 'row', height: 14, borderRadius: 3, overflow: 'hidden', marginVertical: 10, backgroundColor: C.fill }}>
          {detail.categories.map((category) => <View key={category.name} style={{ width: `${percentOf(category.tokens, total)}%`, backgroundColor: color(CATEGORY_COLORS[category.name] ?? 'gray') }} />)}
        </View>
        {detail.categories.map((category) => (
          <View key={category.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 1 }}>
            <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: color(CATEGORY_COLORS[category.name] ?? 'gray') }} />
            <Text style={{ color: C.label, fontSize: 13, flex: 1 }}>{category.name}</Text>
            <Text style={{ color: C.secondary, fontSize: 13 }}>{tokensText(category.tokens)} · {percentOf(category.tokens, total)}%</Text>
          </View>
        ))}
        <Text style={{ color: C.tertiary, fontSize: 11, marginTop: 6 }}>{detail.exact ? CONTEXT_COPY.exactNote : CONTEXT_COPY.estimateNote}</Text>
      </View>
      <Collapsible title="System prompt" tokens={detail.system.reduce((sum, block) => sum + block.tokens, 0)}>
        {detail.system.map((block, index) => <BlockView key={index} block={block} load={() => loadText({ part: 'system', item: index, block: 0 })} />)}
      </Collapsible>
      <Collapsible title={`Tools (${detail.tools.length})`} tokens={detail.tools.reduce((sum, tool) => sum + tool.tokens, 0)}>
        {detail.tools.map((tool, index) => (
          <View key={index} style={{ paddingHorizontal: 10, paddingBottom: 6 }}>
            <Text style={{ color: C.label, fontSize: 13 }}>{tool.name}  <Text style={{ color: C.secondary }}>{tokensText(tool.tokens)} tok</Text></Text>
            <Text style={{ color: C.secondary, fontSize: 11 }} numberOfLines={2}>{tool.description}</Text>
          </View>
        ))}
      </Collapsible>
      {detail.messages.map((message, index) => (
        <Collapsible key={index} title={`#${index} ${message.role}`} tag={message.unresolved ? CONTEXT_COPY.unresolved : message.blocks.map((block) => block.type).join(', ')}
          tokens={message.blocks.reduce((sum, block) => sum + block.tokens, 0)} open={index >= detail.messages.length - 2}>
          {message.blocks.map((block, k) => <BlockView key={k} block={block} load={() => loadText({ part: 'message', item: index, block: k })} />)}
        </Collapsible>
      ))}
      <Collapsible title="Reply" open>
        {detail.response.map((block, index) => <BlockView key={index} block={block} load={() => loadText({ part: 'response', item: 0, block: index })} />)}
      </Collapsible>
    </ScrollView>
  )
}

export function ContextRequestScreen({ route, navigation }: ScreenProps<'ContextRequest'>) {
  const session = useSession()
  const { agentRef, n } = route.params
  const { value, failure } = useLoaded<ContextDetail>(() => session.api.contextDetail(agentRef, n), [agentRef, n])
  useLayoutEffect(() => { navigation.setOptions({ title: `Request #${n}` }) }, [navigation, n])
  if (value) return <Detail detail={value} loadText={(where) => session.api.contextText(agentRef, n, where)} />
  return failure ? <Text style={{ color: C.red, padding: 12 }}>{failure}</Text> : <ActivityIndicator style={{ margin: 20 }} />
}
