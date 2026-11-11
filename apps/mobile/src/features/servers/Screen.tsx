// Every server in one list: choose, add, rename or remove one, with unread on the others, and how each is linked to the
// open one as one of its computers: online, its agents, its trust, or Link. Then the computers the open server is linked
// to that this phone isn't paired with. Removing a server forgets it on this phone, and can unlink it too. With a hosted
// account, also the account's servers not paired here yet. For the open server's owner, New server makes one on a cloud
// account the open server is connected to (AWS, Sprites), or on the hosted account, and Destroy deletes the machine it
// made for a server. Renders servers/model.ts.
import { useCallback, useLayoutEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { MachineList } from '@ouro/contract'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import type { HostedServersView } from '../../core/hub/hostedServers.ts'
import { C } from '../../design/colors.ts'
import { HeaderButton } from '../../design/form.tsx'
import { actionSheet, confirm } from '../../design/menus.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { accent } from '../../design/theme.ts'
import { failureText } from '../../core/session/serverApi.ts'
import { useCore, useHostedServers, useOtherServersUnread, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { HostedServerSetupView, MachineSetupView } from '../onboarding/SetupScreen.tsx'
import { checkingNote, createFailureText, hostedRows, machineAsHosted, machineOfServer, machineRows, NEW_SERVER_COPY, newServerChoices, NEW_SERVER_LABEL_MAX, newServerLabelOf, renamedLabel, SERVERS_COPY, serverRows, unpairedComputerRows } from './model.ts'
import type { HostedRow, MachineRow, NewServerChoice, ServerRow } from './model.ts'

export function ServersScreen({ navigation }: ScreenProps<'Servers'>) {
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const activeId = session.serverId
  const computers = session.store.computers
  const isOwner = session.store.viewer?.isOwner ?? false
  const [linking, setLinking] = useState<string | null>(null)
  const [servers, setServers] = useState<SavedServer[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)
  const hostedServers = useHostedServers()
  const account = core.hostedAccount
  const [hosted, setHosted] = useState<HostedServersView>({ available: false, servers: [] })
  /** Where the open server can make servers, and those it made that aren't paired here; null when it can't say. */
  const [machines, setMachines] = useState<MachineList | null>(null)
  /** The New server menu, while it's open. */
  const [choosing, setChoosing] = useState(false)
  /** The New server form, while it's open: on the hosted account, or on one of the open server's providers. */
  const [naming, setNaming] = useState<{ text: string; creating: boolean; error: string | null; provider: { id: string; name: string } | null } | null>(null)
  const [settingUp, setSettingUp] = useState<{ id: string; label: string; machine: boolean } | null>(null)

  const reload = useCallback(async () => {
    try {
      setServers(await core.servers.list())
      setFailure(null)
    } catch {
      setFailure(SERVERS_COPY.storageError)
    }
  }, [core])
  const reloadHosted = useCallback(() => {
    let stopped = false
    if (account) void hostedServers.load(account).then((view) => { if (!stopped) setHosted(view) })
    return () => { stopped = true }
  }, [account, hostedServers])
  const reloadMachines = useCallback(() => {
    let stopped = false
    // An older server has no such route: then no providers are offered.
    if (isOwner) void session.api.machines().then((result) => { if (!stopped) setMachines(result.ok ? result.value : null) })
    return () => { stopped = true }
  }, [isOwner, session])
  const unread = useOtherServersUnread()
  useFocusEffect(useCallback(() => {
    void reload()
    void unread.checkIfDue()
    const stopMachines = reloadMachines()
    const stopHosted = reloadHosted()
    return () => { stopMachines(); stopHosted() }
  }, [reload, unread, reloadHosted, reloadMachines]))

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Servers', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const switchTo = async (row: ServerRow) => {
    const server = servers.find((candidate) => candidate.id === row.id)
    if (!server || row.isActive) return
    try {
      // Switching replaces the whole stack, this sheet with it.
      if (!(await core.switchTo(server))) setFailure(SERVERS_COPY.noCredentials)
    } catch {
      setFailure(SERVERS_COPY.storageError)
    }
  }

  const forget = (row: ServerRow) => { core.removeServer(row.id).then(reload, () => setFailure(SERVERS_COPY.storageError)) }
  const unlinkComputer = async (computerId: string) => {
    const removed = await session.command('remove_computer', { computerId })
    if (!removed.ok) setFailure(removed.failure.kind === 'refused' ? failureText(removed.failure) : SERVERS_COPY.unlinkFailed)
    return removed.ok
  }
  const remove = (row: ServerRow) => {
    if (row.link?.kind !== 'linked' || !isOwner) return confirm(SERVERS_COPY.removeTitle(row.label), SERVERS_COPY.removeMessage, 'Remove', () => forget(row))
    const computerId = row.link.computerId
    actionSheet(SERVERS_COPY.removeTitle(row.label), [
      { title: SERVERS_COPY.removeFromPhone, onPress: () => forget(row) },
      { title: SERVERS_COPY.removeAndUnlink, destructive: true, onPress: () => { void unlinkComputer(computerId).then((ok) => { if (ok) forget(row) }) } },
    ])
  }
  const unlink = (computerId: string, name: string) => confirm(SERVERS_COPY.unlinkTitle(name), SERVERS_COPY.unlinkMessage(computers.get(computerId)?.agentsRunning ?? null), SERVERS_COPY.unlink, () => {
    void unlinkComputer(computerId)
  })
  const setTrust = async (computerId: string, full: boolean) => {
    const set = await session.command('set_computer_trust', { computerId, trust: full ? 'full' : 'limited' })
    if (!set.ok) setFailure(set.failure.kind === 'refused' ? failureText(set.failure) : SERVERS_COPY.trustFailed)
  }
  /** The other server joins the open one, so it shows linked here as soon as sync says so. */
  const link = async (row: ServerRow) => {
    const other = servers.find((server) => server.id === row.id)
    const open = servers.find((server) => server.id === activeId)
    if (!other || !open) return
    setLinking(row.id)
    const why = await core.linkServers(other, open).catch(() => SERVERS_COPY.storageError)
    setLinking(null)
    setFailure(why === null ? null : SERVERS_COPY.linkFailed(row.label, why))
  }

  const commitRename = async () => {
    if (!renaming) return
    const row = servers.find((server) => server.id === renaming.id)
    const label = row ? renamedLabel(renaming.text, row.label) : null
    setRenaming(null)
    if (label === null) return
    try {
      await core.servers.rename(renaming.id, label)
      await reload()
    } catch {
      setFailure(SERVERS_COPY.storageError)
    }
  }

  const createServer = async () => {
    if (!naming) return
    const typed = newServerLabelOf(naming.text)
    if (typed === null) return
    if ('error' in typed) return setNaming({ ...naming, error: typed.error })
    setNaming({ ...naming, creating: true, error: null })
    if (naming.provider !== null) {
      const made = await session.api.createMachine({ provider: naming.provider.id, label: typed.label })
      if (!made.ok) return setNaming({ ...naming, creating: false, error: `${NEW_SERVER_COPY.failed} ${failureText(made.failure)}` })
      setNaming(null)
      return setSettingUp({ id: made.value.id, label: made.value.label, machine: true })
    }
    if (!account) return
    const created = await hostedServers.api.createServer(account.token, { label: typed.label })
    if (!created.ok) return setNaming({ ...naming, creating: false, error: createFailureText(created.failure) })
    setNaming(null)
    setSettingUp({ id: created.value.id, label: created.value.label, machine: false })
  }

  const choose = (choice: NewServerChoice) => {
    setChoosing(false)
    switch (choice.kind) {
      case 'hosted': return setNaming({ text: '', creating: false, error: null, provider: null })
      case 'machine': return setNaming({ text: '', creating: false, error: null, provider: { id: choice.provider, name: choice.title } })
      case 'set_up': if (choice.route) navigation.navigate(choice.route)
    }
  }

  const removeMachine = (row: MachineRow) => confirm(NEW_SERVER_COPY.removeTitle(row.label), NEW_SERVER_COPY.removeMessage, 'Remove', () => {
    void session.api.deleteMachine(row.id).then((result) => {
      setFailure(result.ok ? null : NEW_SERVER_COPY.removeFailed(failureText(result.failure)))
      reloadMachines()
    })
  })
  /** Deletes the machine the open server made for this server, then unlinks it (best effort) and forgets it here. */
  const destroyMachine = (row: ServerRow, machineId: string) => confirm(NEW_SERVER_COPY.destroyTitle(row.label), NEW_SERVER_COPY.destroyMessage, NEW_SERVER_COPY.destroyConfirm, () => {
    void (async () => {
      const result = await session.api.deleteMachine(machineId)
      reloadMachines()
      if (!result.ok) return setFailure(NEW_SERVER_COPY.destroyFailed(failureText(result.failure)))
      setFailure(null)
      if (row.link?.kind === 'linked') await unlinkComputer(row.link.computerId).catch(() => false)
      forget(row)
    })()
  })

  const leaveSetup = () => {
    setSettingUp(null)
    void reload()
    reloadHosted()
    reloadMachines()
  }

  if (settingUp?.machine) {
    const { id } = settingUp
    return <MachineSetupView label={settingUp.label} read={async () => machineAsHosted(await session.api.machine(id))} onLeave={leaveSetup} />
  }
  if (settingUp && account) return <HostedServerSetupView account={account} server={settingUp} onLeave={leaveSetup} />

  const rows = serverRows(servers, activeId, unread, computers.values())
  const unpairedComputers = unpairedComputerRows(computers.values(), servers)
  const someOffline = [...computers.values()].some((computer) => computer.status === 'offline')
  const note = checkingNote(rows, unread.checking)
  const unpaired: HostedRow[] = account ? hostedRows(hosted.servers, servers) : []
  const canCreate = naming !== null && !naming.creating && newServerLabelOf(naming.text) !== null
  /** The machine the open server made for this server, which its owner can destroy. */
  const destroyable = (row: ServerRow) => (isOwner && row.canRemove && machines ? machineOfServer(row.url, machines.machines) : null)
  const madeHere: MachineRow[] = machines ? machineRows(machines.machines, machines.providers, servers) : []
  const hostedAvailable = hosted.available && account !== null
  const choices = newServerChoices(machines?.providers ?? [], hostedAvailable)

  return (
    <ScrollView style={s.wrap} keyboardShouldPersistTaps="handled">
      {failure !== null && <Text style={s.error}>{failure}</Text>}
      {rows.map((row) => (
        <View key={row.id}>
          <Pressable style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]} onPress={() => { void switchTo(row) }}>
            <View style={{ flex: 1 }}>
              {renaming?.id === row.id ? (
                <TextInput style={s.renameInput} value={renaming.text} onChangeText={(text) => setRenaming({ id: row.id, text })}
                  autoFocus onSubmitEditing={() => { void commitRename() }} onBlur={() => { void commitRename() }} returnKeyType="done" />
              ) : (
                <View style={s.line}>
                  <Text style={s.name} numberOfLines={1}>{row.label}</Text>
                  {row.isActive && <Text style={s.active}>active</Text>}
                </View>
              )}
              <Text style={s.url} numberOfLines={1}>{row.url}</Text>
              {row.link?.kind === 'linked' && <Text style={s.person}>{row.link.stateText}</Text>}
              {row.link?.kind === 'linked' && row.link.incompatibility !== null && <Text style={s.warning}>{row.link.incompatibility}</Text>}
              {row.link?.kind === 'not_linked' && isOwner && <Text style={s.person}>{SERVERS_COPY.notLinked}</Text>}
              {row.personText !== null && <Text style={s.person}>{row.personText}</Text>}
            </View>
            {row.unreadBadge !== null ? (
              <View style={s.badge}><Text style={s.badgeText}>{row.unreadBadge}</Text></View>
            ) : row.checking ? <ActivityIndicator size="small" /> : null}
            <Symbol name="chevron.right" size={12} color="secondary" />
          </Pressable>
          <View style={s.actions}>
            <Pressable onPress={() => setRenaming({ id: row.id, text: row.label })} style={s.actionButton}><Text style={s.actionText}>Rename</Text></Pressable>
            {row.link?.kind === 'linked' && isOwner && <TrustButton full={row.link.fullTrust} onPress={((linked) => () => { void setTrust(linked.computerId, !linked.fullTrust) })(row.link)} />}
            {row.link?.kind === 'not_linked' && isOwner && (linking === row.id
              ? <Text style={[s.actionText, s.actionButton, { color: C.secondary }]}>{SERVERS_COPY.linking}</Text>
              : <Pressable onPress={() => { void link(row) }} style={s.actionButton} disabled={linking !== null}><Text style={s.actionText}>{SERVERS_COPY.link}</Text></Pressable>)}
            {row.canRemove && <Pressable onPress={() => remove(row)} style={s.actionButton}><Text style={[s.actionText, { color: C.red }]}>Remove</Text></Pressable>}
            {destroyable(row) && <Pressable onPress={() => destroyMachine(row, destroyable(row)!.id)} style={s.actionButton}><Text style={[s.actionText, { color: C.red }]}>{NEW_SERVER_COPY.destroy}</Text></Pressable>}
          </View>
        </View>
      ))}
      {unpairedComputers.map((row) => (
        <View key={row.computerId}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{row.name}</Text>
              <Text style={s.url} numberOfLines={1}>{SERVERS_COPY.notOnPhone}</Text>
              <Text style={s.person}>{row.stateText}</Text>
              {row.incompatibility !== null && <Text style={s.warning}>{row.incompatibility}</Text>}
            </View>
          </View>
          {isOwner && (
            <View style={s.actions}>
              <TrustButton full={row.fullTrust} onPress={() => { void setTrust(row.computerId, !row.fullTrust) }} />
              <Pressable onPress={() => unlink(row.computerId, row.name)} style={s.actionButton}><Text style={[s.actionText, { color: C.red }]}>{SERVERS_COPY.unlink}</Text></Pressable>
            </View>
          )}
        </View>
      ))}
      {note !== null && <Text style={s.note}>{note}</Text>}
      {computers.size > 0 && <Text style={s.footer}>{SERVERS_COPY.footer}</Text>}
      {someOffline && <Text style={s.footer}>{SERVERS_COPY.offlineNote}</Text>}
      {unpaired.map((row) => (
        <Pressable key={row.id} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]} onPress={() => setSettingUp({ ...row, machine: false })}>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>{row.label}</Text>
            <Text style={s.url} numberOfLines={1}>{row.detail}</Text>
          </View>
          <Symbol name="chevron.right" size={12} color="secondary" />
        </Pressable>
      ))}
      {madeHere.map((row) => (
        <View key={row.id}>
          <Pressable style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]} onPress={() => setSettingUp({ id: row.id, label: row.label, machine: true })}>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{row.label}</Text>
              <Text style={s.url} numberOfLines={2}>{row.detail}</Text>
            </View>
            <Symbol name="chevron.right" size={12} color="secondary" />
          </Pressable>
          {row.canRemove && (
            <View style={s.actions}>
              <Pressable onPress={() => removeMachine(row)} style={s.actionButton}><Text style={[s.actionText, { color: C.red }]}>Remove</Text></Pressable>
            </View>
          )}
        </View>
      ))}
      <View style={{ height: 24 }} />
      {choosing && naming === null ? (
        <View style={s.newForm}>
          <Text style={s.newLabel}>{NEW_SERVER_COPY.chooseTitle}</Text>
          {choices.map((choice) => (
            <Pressable key={choice.kind === 'hosted' ? 'hosted' : choice.provider} onPress={() => choose(choice)}
              disabled={choice.kind === 'set_up' && choice.route === null}
              style={({ pressed }) => [s.choice, { backgroundColor: pressed ? C.pressed : C.background }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.choiceTitle, choice.kind === 'set_up' ? { color: accent } : null]}>{choice.title}</Text>
                {choice.kind !== 'hosted' && <Text style={s.url}>{choice.detail}</Text>}
              </View>
              {(choice.kind !== 'set_up' || choice.route !== null) && <Symbol name="chevron.right" size={12} color="secondary" />}
            </Pressable>
          ))}
          <Pressable style={{ alignItems: 'center', padding: 8 }} onPress={() => setChoosing(false)}>
            <Text style={{ color: accent, fontSize: 15 }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {naming !== null ? (
        <View style={s.newForm}>
          <Text style={s.newLabel}>{naming.provider ? NEW_SERVER_COPY.titleOn(naming.provider.name) : NEW_SERVER_COPY.title}</Text>
          <TextInput style={s.newInput} placeholder={NEW_SERVER_COPY.placeholder} value={naming.text} onChangeText={(text) => setNaming({ ...naming, text })}
            autoFocus autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => { void createServer() }}
            placeholderTextColor={C.tertiary} maxLength={NEW_SERVER_LABEL_MAX} />
          <Pressable style={[s.newButton, { backgroundColor: accent, opacity: canCreate ? 1 : 0.4 }]} onPress={() => { void createServer() }} disabled={!canCreate}>
            {naming.creating ? <ActivityIndicator color="white" /> : <Text style={s.addText}>Create</Text>}
          </Pressable>
          {naming.error !== null && <Text style={s.createError}>{naming.error}</Text>}
          <Pressable style={{ alignItems: 'center', padding: 8 }} onPress={() => setNaming(null)}>
            <Text style={{ color: accent, fontSize: 15 }}>Cancel</Text>
          </Pressable>
          <Text style={s.hint}>{naming.provider ? NEW_SERVER_COPY.hintFor(naming.provider.id) : NEW_SERVER_COPY.hint}</Text>
        </View>
      ) : !choosing && choices.length > 0 ? (
        <Pressable style={[s.addButton, { backgroundColor: accent, marginBottom: 12 }]}
          onPress={() => (choices.length === 1 && choices[0]!.kind === 'hosted' ? choose(choices[0]!) : setChoosing(true))}>
          <Text style={s.addText}>{NEW_SERVER_COPY.button}</Text>
        </Pressable>
      ) : null}
      <Pressable style={[s.addButton, { backgroundColor: accent }]} onPress={() => navigation.navigate('Pair')}>
        <Text style={s.addText}>Add a server</Text>
      </Pressable>
      {isOwner && (
        <Pressable style={{ alignItems: 'center', padding: 14 }} onPress={() => navigation.navigate('Computers')}>
          <Text style={{ color: accent, fontSize: 15 }}>{SERVERS_COPY.linkByCommand}</Text>
        </Pressable>
      )}
    </ScrollView>
  )
}

/** Full or limited trust: a tap switches it. */
function TrustButton({ full, onPress }: { full: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.actionButton, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
      <Symbol name={full ? 'checkmark.shield' : 'shield'} size={12} color="blue" />
      <Text style={s.actionText}>{full ? SERVERS_COPY.fullTrust : SERVERS_COPY.limitedTrust}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.background },
  error: { color: C.red, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 17, fontWeight: '600', color: C.label, flexShrink: 1 },
  active: { fontSize: 11, fontWeight: '700', color: 'white', backgroundColor: C.blue, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  url: { fontSize: 13, color: C.secondary, marginTop: 2 },
  person: { fontSize: 12, color: C.tertiary, marginTop: 2 },
  warning: { fontSize: 12, color: C.orange, marginTop: 2 },
  footer: { color: C.secondary, fontSize: 12, marginHorizontal: 16, marginTop: 12 },
  badge: { backgroundColor: C.blue, borderRadius: 11, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  badgeText: { color: 'white', fontWeight: '700', fontSize: 12 },
  note: { color: C.secondary, fontSize: 12, textAlign: 'center', marginTop: 12 },
  addButton: { marginHorizontal: 16, borderRadius: 12, padding: 14, alignItems: 'center' },
  addText: { color: 'white', fontWeight: '600', fontSize: 16 },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  actionButton: { paddingVertical: 4 },
  actionText: { fontSize: 13, color: C.blue },
  newForm: { marginHorizontal: 16, marginBottom: 12 },
  newLabel: { fontSize: 13, color: C.secondary, marginBottom: 6 },
  newInput: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.opaqueSeparator, borderRadius: 10, padding: 12, fontSize: 16, color: C.label, backgroundColor: C.background },
  newButton: { borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 12 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  choiceTitle: { fontSize: 16, fontWeight: '600', color: C.label },
  hint: { fontSize: 12, color: C.tertiary, textAlign: 'center', marginTop: 8 },
  createError: { color: C.red, fontSize: 13, marginTop: 6, textAlign: 'center' },
  renameInput: { fontSize: 17, fontWeight: '600', color: C.label, borderBottomWidth: 1, borderBottomColor: C.blue, paddingVertical: 2 },
})
