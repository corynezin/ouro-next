// Servers → New server, a step at a time: where it runs, then its name (or, for a server already run, its pairing link),
// then its network; then its setup. The network is kept on this phone until it pairs with the server
// (core/servers/networkPlans.ts). Servers → Network… → Start a network is the page for a new network. Draws model.ts.
import { useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import type { MachineList } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { C } from '../../design/colors.ts'
import { HeaderButton } from '../../design/form.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { accent } from '../../design/theme.ts'
import { useCore, useHostedServers, useOtherServersUnread, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { HostedServerSetupView, MachineSetupView } from '../onboarding/SetupScreen.tsx'
import { NOTHING_USABLE_TO_PAIR_WITH, PairingGate } from '../pair/model.ts'
import {
  createFailureText, defaultNetworkChoiceKey, detailsHintOf, EXISTING_SERVER, existingServerTargetOf, machineAsHosted, NETWORKS_COPY,
  NEW_SERVER_COPY, networkNameOf, networkStartOf, newServerLabelOf, newServerNetworkChoices, whereActionOf, whereChoices,
} from './model.ts'
import type { NewServerNetworkChoice } from './model.ts'
import { createNewServer } from './newServer.ts'
import type { NewServerPorts, SettingUp } from './newServer.ts'

// ---- Step 1: where it runs ----

export function NewServerScreen({ navigation }: ScreenProps<'NewServer'>) {
  const core = useCore()
  const session = useSession()
  const hostedServers = useHostedServers()
  const account = core.hostedAccount
  const [machines, setMachines] = useState<MachineList | null | undefined>(undefined)
  const [hostedAvailable, setHostedAvailable] = useState(false)

  // Again on coming back, as after connecting an account in Integrations.
  useEffect(() => navigation.addListener('focus', () => {
    void session.api.machines().then((result) => setMachines(result.ok ? result.value : null))
    if (account) void hostedServers.load(account).then((view) => setHostedAvailable(view.available))
  }), [navigation, session, account, hostedServers])

  useLayoutEffect(() => {
    navigation.setOptions({ title: NEW_SERVER_COPY.button })
  }, [navigation])

  const choices = whereChoices(machines?.providers ?? [], hostedAvailable && account !== null)
  return (
    <Step title={NEW_SERVER_COPY.whereTitle}>
      {machines === undefined && <ActivityIndicator style={{ marginTop: 12 }} />}
      <Rows>
        {choices.map((choice) => {
          const action = whereActionOf(choice)
          return (
            <Row key={choice.key} title={choice.title} detail={choice.detail} chevron={action.kind !== 'none'} disabled={action.kind === 'none'}
              onPress={() => {
                switch (action.kind) {
                  case 'details': return navigation.navigate('NewServerDetails', { where: choice.key, detail: choice.detail })
                  // Connected there, it comes back here (focus reloads the providers) and is then one to make.
                  case 'set_up': return navigation.navigate(action.route)
                  case 'none': return
                }
              }} />
          )
        })}
      </Rows>
    </Step>
  )
}

// ---- Step 2: its name, or its pairing link ----

export function NewServerDetailsScreen({ navigation, route }: ScreenProps<'NewServerDetails'>) {
  const { where, detail } = route.params
  const existing = where === EXISTING_SERVER
  const [typed, setTyped] = useState('')
  const named = existing ? null : newServerLabelOf(typed)
  const target = existing ? existingServerTargetOf(typed) : null
  const problem = named !== null && 'error' in named ? named.error : existing && typed.trim() && target === null ? NOTHING_USABLE_TO_PAIR_WITH : null
  const label = named !== null && 'label' in named ? named.label : null
  const ready = existing ? target !== null : label !== null
  const next = () => {
    if (!ready) return
    navigation.navigate('NewServerNetwork', existing ? { where, label: null, link: typed.trim() } : { where, label, link: null })
  }

  useLayoutEffect(() => {
    navigation.setOptions({ title: NEW_SERVER_COPY.button, headerRight: () => <HeaderButton title="Next" bold disabled={!ready} onPress={next} /> })
  })

  return (
    <Step title={existing ? NEW_SERVER_COPY.linkTitle : NEW_SERVER_COPY.nameTitle} hint={detailsHintOf(where, detail)}>
      <TextInput style={s.input} value={typed} onChangeText={setTyped} autoFocus autoCapitalize="none" autoCorrect={false}
        placeholder={existing ? 'ouronext://pair?url=…&code=…' : NEW_SERVER_COPY.placeholder} returnKeyType="next" onSubmitEditing={next} />
      {existing && (
        <Pressable onPress={() => { void Clipboard.getStringAsync().then(setTyped) }} style={s.link}>
          <Text style={s.linkText}>Paste</Text>
        </Pressable>
      )}
      {problem !== null && <Text style={s.error}>{problem}</Text>}
    </Step>
  )
}

// ---- Step 3: its network, then it's made and set up ----

export function NewServerNetworkScreen({ navigation, route }: ScreenProps<'NewServerNetwork'>) {
  const { where, label, link } = route.params
  const existing = where === EXISTING_SERVER
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const unread = useOtherServersUnread()
  const hostedServers = useHostedServers()
  const account = core.hostedAccount
  const [pending, setPending] = useState<string[]>([])
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [settingUp, setSettingUp] = useState<SettingUp | null>(null)
  const [gate] = useState(() => new PairingGate())

  // Again on coming back from Start a network, which may have added one.
  useEffect(() => navigation.addListener('focus', () => {
    void unread.checkIfDue()
    void core.pendingNetworks.list().then(setPending)
  }), [navigation, unread, core])

  const places = new Map(unread.places)
  const activeId = session.serverId
  const openNetworks = session.store.server?.networks ?? []
  places.set(activeId, { networks: openNetworks, computers: [...session.store.computers.values()] })
  const choices = newServerNetworkChoices(places, activeId, existing, pending)
  const chosen = choices.find((choice) => choice.key === (chosenKey ?? defaultNetworkChoiceKey(choices, openNetworks))) ?? null
  const action = existing ? NEW_SERVER_COPY.addExisting : 'Create'

  const ports: NewServerPorts = {
    newId: () => core.deps.ids.newId(),
    createHosted: async (name) => {
      if (!account) return { ok: false, why: NEW_SERVER_COPY.failed }
      const created = await hostedServers.api.createServer(account.token, { label: name })
      return created.ok ? { ok: true, id: created.value.id, label: created.value.label } : { ok: false, why: createFailureText(created.failure) }
    },
    createMachine: async (provider, name) => {
      const created = await session.api.createMachine({ provider, label: name })
      return created.ok ? { ok: true, id: created.value.id, label: created.value.label } : { ok: false, why: `${NEW_SERVER_COPY.failed} ${failureText(created.failure)}` }
    },
    keepPlan: (setupId, plan) => core.networkPlans.set(setupId, plan),
    forgetPlan: (setupId) => core.networkPlans.clear(setupId),
    // Pairing switches to the server, and with it the whole stack, these steps too.
    pair: async (target, setupId) => { await core.pairAndActivate(target.url, target.code, { setupId }) },
  }
  const create = async () => {
    if (chosen === null || busy) return
    setBusy(true)
    setFailure(null)
    await gate.run(async () => {
      const outcome = await createNewServer(ports, existing ? { kind: 'existing', typed: link ?? '', plan: chosen.plan } : { kind: 'make', where, label: label ?? '', plan: chosen.plan })
      switch (outcome.kind) {
        case 'paired': return
        case 'setting_up': return setSettingUp(outcome.setup)
        case 'failed':
          setBusy(false)
          return setFailure(outcome.why)
      }
    })
  }

  const backToServers = () => navigation.navigate('Servers')
  useLayoutEffect(() => {
    navigation.setOptions(settingUp
      ? { title: settingUp.label, headerBackVisible: false, headerRight: () => <HeaderButton title="Done" bold onPress={backToServers} /> }
      : { title: NEW_SERVER_COPY.button, headerRight: () => <HeaderButton title={busy ? `${action}…` : action} bold disabled={busy || chosen === null} onPress={() => { void create() }} /> })
  })

  if (settingUp?.kind === 'machine') {
    const { id } = settingUp
    return <MachineSetupView label={settingUp.label} read={async () => machineAsHosted(await session.api.machine(id))} onLeave={backToServers} />
  }
  if (settingUp?.kind === 'hosted' && account) return <HostedServerSetupView account={account} server={settingUp} onLeave={backToServers} />

  const group = (title: string | null, inGroup: NewServerNetworkChoice[]) => inGroup.length === 0 ? null : (
    <View key={title ?? 'keep'}>
      {title !== null && <Text style={s.sectionTitle}>{title}</Text>}
      <Rows>
        {inGroup.map((choice) => (
          <Row key={choice.key} title={choice.title} detail={choice.detail} checked={chosen?.key === choice.key} onPress={() => setChosenKey(choice.key)} />
        ))}
      </Rows>
    </View>
  )
  return (
    <Step title={NEW_SERVER_COPY.networkTitle}>
      {group(null, choices.filter((choice) => choice.group === 'keep'))}
      {group(NETWORKS_COPY.privateSection, choices.filter((choice) => choice.group === 'private'))}
      {group(NETWORKS_COPY.sharedSection, choices.filter((choice) => choice.group === 'shared'))}
      <Pressable onPress={() => navigation.navigate('NewNetwork')} style={s.link}>
        <Text style={s.linkText}>{NETWORKS_COPY.start}</Text>
      </Pressable>
      {failure !== null && <Text style={s.error}>{failure}</Text>}
    </Step>
  )
}

// ---- Start a network: its name, and private or shared ----

export function NewNetworkScreen({ navigation }: ScreenProps<'NewNetwork'>) {
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const [typed, setTyped] = useState('')
  const [kind, setKind] = useState<'private' | 'shared'>('private')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const named = networkNameOf(typed)
  const name = named !== null && 'name' in named ? named.name : null
  const start = networkStartOf(kind, session.store.server?.networks ?? [])
  const ready = !busy && name !== null && start.kind !== 'refused'

  const create = async () => {
    if (!ready || name === null) return
    setBusy(true)
    setFailure(null)
    if (start.kind === 'pending') {
      await core.pendingNetworks.add(name)
      navigation.goBack()
      return
    }
    if (start.kind !== 'here') return
    const made = await session.command('create_network', { name, kind, role: start.role })
    if (!made.ok) {
      setBusy(false)
      setFailure(NETWORKS_COPY.failed(failureText(made.failure)))
      return
    }
    // Computers this server trusted only to message don't go into its first network: the person decides about them.
    if (made.value.leftOut.length > 0) Alert.alert(name, NETWORKS_COPY.leftOut(made.value.leftOut))
    navigation.goBack()
  }

  useLayoutEffect(() => {
    navigation.setOptions({ title: NETWORKS_COPY.startTitle, headerRight: () => <HeaderButton title={busy ? 'Starting…' : 'Start'} bold disabled={!ready} onPress={() => { void create() }} /> })
  })

  return (
    <Step title="Name">
      <TextInput style={s.input} value={typed} onChangeText={setTyped} autoFocus autoCapitalize="none" autoCorrect={false} placeholder={NETWORKS_COPY.namePlaceholder} />
      {named !== null && 'error' in named && <Text style={s.error}>{named.error}</Text>}
      <Text style={s.sectionTitle}>Kind</Text>
      <Rows>
        <Row title={NETWORKS_COPY.privateKind} detail={NETWORKS_COPY.privateKindDetail} checked={kind === 'private'} onPress={() => setKind('private')} />
        <Row title={NETWORKS_COPY.sharedKind} detail={NETWORKS_COPY.sharedKindDetail} checked={kind === 'shared'} onPress={() => setKind('shared')} />
      </Rows>
      {start.kind === 'pending' && <Text style={[s.hint, { marginTop: 12 }]}>{NETWORKS_COPY.pendingNote}.</Text>}
      {start.kind === 'refused' && <Text style={s.error}>{start.why}</Text>}
      {failure !== null && <Text style={s.error}>{failure}</Text>}
    </Step>
  )
}

// ---- Drawing ----

function Step({ title, hint = null, children }: { title: string; hint?: string | null; children: ReactNode }) {
  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>{title}</Text>
      {hint !== null && <Text style={s.hint}>{hint}</Text>}
      {children}
    </ScrollView>
  )
}

const Rows = ({ children }: { children: ReactNode }) => <View style={s.rows}>{children}</View>

/** `disabled`: grayed out, its detail saying why. */
function Row({ title, detail, onPress, chevron, checked, disabled }: { title: string; detail: string | null; onPress: () => void; chevron?: boolean; checked?: boolean; disabled?: boolean }) {
  return (
    <Pressable style={({ pressed }) => [s.row, { backgroundColor: pressed && !disabled ? C.pressed : C.secondaryBackground }]} onPress={onPress} disabled={disabled}>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowTitle, disabled && { color: C.tertiary }]}>{title}</Text>
        {detail !== null && <Text style={s.rowDetail}>{detail}</Text>}
      </View>
      {checked && <Symbol name="checkmark" size={16} color="blue" />}
      {chevron && <Symbol name="chevron.right" size={12} color="secondary" />}
    </Pressable>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.groupedBackground },
  title: { fontSize: 28, fontWeight: '700', color: C.label, marginHorizontal: 20, marginTop: 20, marginBottom: 8 },
  hint: { fontSize: 15, color: C.secondary, marginHorizontal: 20, marginBottom: 12 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: C.label, marginHorizontal: 20, marginTop: 24, marginBottom: 8 },
  rows: { marginHorizontal: 16, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  rowTitle: { fontSize: 17, color: C.label },
  rowDetail: { fontSize: 13, color: C.secondary, marginTop: 2 },
  input: { marginHorizontal: 16, marginTop: 8, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 17, color: C.label, backgroundColor: C.secondaryBackground },
  link: { marginHorizontal: 20, marginTop: 16 },
  linkText: { color: accent, fontSize: 17 },
  error: { color: C.red, marginHorizontal: 20, marginTop: 12 },
})
