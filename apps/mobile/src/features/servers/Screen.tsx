// Every server in one list, grouped by the network it lives in: tap one to open it; its … menu renames, removes, adds it
// to a network, links it or sets its trust (before networks), or destroys the machine the open server made for it. Each
// network offers Invite, and one the open server only visits offers Leave. Then the servers being set up, and two
// buttons: New server (NewServerScreen.tsx) and Network…, to start a network or join one with an invite. Names and
// invites are typed in native prompts, so the keyboard never covers them. Destroy also reaches a machine the open server
// made that is paired with another phone. Renders servers/model.ts; Remove and Destroy follow servers/actions.ts.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { MachineList, NetworkEntity } from '@ouro/contract'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import type { Placement } from '../../core/appCore.ts'
import type { HostedServersView } from '../../core/hub/hostedServers.ts'
import { C } from '../../design/colors.ts'
import { HeaderButton } from '../../design/form.tsx'
import { actionSheet, alertFailure, confirm, prompt } from '../../design/menus.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { accent } from '../../design/theme.ts'
import { failureText } from '../../core/session/serverApi.ts'
import { useCore, useHostedServers, useOtherServersUnread, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { HostedServerSetupView, MachineSetupView } from '../onboarding/SetupScreen.tsx'
import {
  checkingNote, hostedRows, inviteMessage, isNetworkSection, JOIN_KINDS, joinChoices, joinRoleOf, machineAsHosted, machineOfServer,
  machineRows, NETWORKS_COPY, networkSections, NEW_SERVER_COPY, parseInvite, placementText, readyMachineAt, renamedLabel, SERVERS_COPY, serverRows,
  unpairedComputerRows, withNetworkKeyNote,
} from './model.ts'
import type { HostedRow, MachineRow, NetworkSection, ServerRow, UnpairedComputerRow } from './model.ts'
import { destroyServerMachine, removeAndUnlink, removeChoiceOf } from './actions.ts'
import type { ServerActionPorts } from './actions.ts'

export function ServersScreen({ navigation }: ScreenProps<'Servers'>) {
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const activeId = session.serverId
  const computers = session.store.computers
  const isOwner = session.store.viewer?.isOwner ?? false
  const [servers, setServers] = useState<SavedServer[]>([])
  const [storageFailed, setStorageFailed] = useState(false)
  /** Something that goes to a server is running: a spinner on Network…, and nothing else starts. */
  const [busy, setBusy] = useState<string | null>(null)
  const hostedServers = useHostedServers()
  const account = core.hostedAccount
  const [hosted, setHosted] = useState<HostedServersView>({ available: false, servers: [] })
  /** Where the open server can make servers, and every server it made and hasn't destroyed; null when it can't say. */
  const [machines, setMachines] = useState<MachineList | null>(null)
  /** A server being set up here: one on the hosted account, or one the open server makes. */
  const [settingUp, setSettingUp] = useState<{ kind: 'hosted' | 'machine'; id: string; label: string } | null>(null)
  const networks = session.store.server?.networks ?? []
  /** Saved servers still to be put in the network picked for them, and how that went. */
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map())
  useEffect(() => {
    let stopped = false
    const load = () => { void core.placements().then((found) => { if (!stopped) setPlacements(found) }) }
    load()
    const unsubscribe = core.subscribe(load)
    return () => { stopped = true; unsubscribe() }
  }, [core])

  const reload = useCallback(async () => {
    try {
      setServers(await core.servers.list())
      setStorageFailed(false)
    } catch {
      setStorageFailed(true)
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
  /** What each saved server says about networks: the open one as it is now, the others from their last check. */
  const places = new Map(unread.places)
  if (activeId !== null) places.set(activeId, { networks, computers: [...computers.values()] })
  /** Private networks started that no server is in yet. */
  const [pending, setPending] = useState<string[]>([])
  useFocusEffect(useCallback(() => {
    void reload()
    void core.pendingNetworks.list().then(setPending)
    void unread.checkIfDue()
    const stopMachines = reloadMachines()
    const stopHosted = reloadHosted()
    return () => { stopMachines(); stopHosted() }
  }, [reload, unread, reloadHosted, reloadMachines, core]))

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Servers', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  /** Runs something that goes to a server, one at a time; its failure, in words or null, is shown as an alert. */
  const run = async (what: string, body: () => Promise<string | null>) => {
    if (busy !== null) return
    setBusy(what)
    const why = await body().catch(() => SERVERS_COPY.storageError)
    setBusy(null)
    if (why !== null) alertFailure(why)
  }
  const savedOf = (id: string | null) => servers.find((server) => server.id === id)

  const switchTo = async (row: ServerRow) => {
    const server = savedOf(row.id)
    if (!server || row.isActive) return
    try {
      // Switching replaces the whole stack, this sheet with it.
      if (!(await core.switchTo(server))) alertFailure(SERVERS_COPY.noCredentials)
    } catch {
      alertFailure(SERVERS_COPY.storageError)
    }
  }

  const rename = (row: ServerRow) => prompt('Rename', undefined, 'Save', (typed) => {
    const label = renamedLabel(typed, row.label)
    if (label === null) return
    core.servers.rename(row.id, label).then(reload, () => alertFailure(SERVERS_COPY.storageError))
  }, row.label)
  const unlinkComputer = async (computerId: string): Promise<string | null> => {
    const removed = await session.command('remove_computer', { computerId })
    return removed.ok ? null : removed.failure.kind === 'refused' ? failureText(removed.failure) : SERVERS_COPY.unlinkFailed
  }
  const ports: ServerActionPorts = {
    deleteMachine: async (machineId) => {
      const result = await session.api.deleteMachine(machineId)
      reloadMachines()
      if (result.ok) await core.machineDestroyed(machineId)
      return result.ok ? null : failureText(result.failure)
    },
    unlinkComputer: async (computerId) => {
      const why = await unlinkComputer(computerId)
      if (why !== null) alertFailure(why)
      return why === null
    },
    forget: async (serverId) => { await core.removeServer(serverId).then(reload, () => alertFailure(SERVERS_COPY.storageError)) },
  }
  const forget = (row: ServerRow) => { void ports.forget(row.id) }
  /** `inNetwork`: listed under a network, so the server keeps its key once unlinked (see withNetworkKeyNote). */
  const remove = (row: ServerRow, inNetwork: boolean) => {
    const choice = removeChoiceOf(row, isOwner)
    switch (choice.kind) {
      case 'forget_only': return confirm(SERVERS_COPY.removeTitle(row.label), SERVERS_COPY.removeMessage, 'Remove', () => forget(row))
      case 'forget_or_unlink': return actionSheet(SERVERS_COPY.removeTitle(row.label), [
        { title: SERVERS_COPY.removeFromPhone, onPress: () => forget(row) },
        { title: SERVERS_COPY.removeAndUnlink, destructive: true, onPress: () => {
          const unlinkIt = () => { void run('unlink', async () => { await removeAndUnlink(ports, row, choice.computerId); return null }) }
          if (inNetwork) confirm(SERVERS_COPY.removeTitle(row.label), SERVERS_COPY.networkKeyNote, SERVERS_COPY.removeAndUnlink, unlinkIt)
          else unlinkIt()
        } },
      ])
    }
  }
  const unlink = (computerId: string, name: string, inNetwork: boolean) => confirm(SERVERS_COPY.unlinkTitle(name), withNetworkKeyNote(SERVERS_COPY.unlinkMessage(computers.get(computerId)?.agentsRunning ?? null), inNetwork), SERVERS_COPY.unlink, () => {
    void run('unlink', () => unlinkComputer(computerId))
  })
  const setTrust = (computerId: string, full: boolean) => run('trust', async () => {
    const set = await session.command('set_computer_trust', { computerId, trust: full ? 'full' : 'limited' })
    return set.ok ? null : set.failure.kind === 'refused' ? failureText(set.failure) : SERVERS_COPY.trustFailed
  })
  /** The other server joins the open one, so it shows linked here as soon as sync says so. */
  const link = (row: ServerRow) => run('link', async () => {
    const other = savedOf(row.id)
    const open = savedOf(activeId)
    if (!other || !open) return null
    const why = await core.linkServers(other, open)
    return why === null ? null : SERVERS_COPY.linkFailed(row.label, why)
  })

  // Networks: only the owner, from this phone, changes them.
  /** The invite, then what kind of network the person takes it to be: the server refuses an invite of another kind. */
  const join = () => prompt(NETWORKS_COPY.joinTitle, NETWORKS_COPY.joinMessage, 'Join', (typed) => {
    const invite = parseInvite(typed)
    if (!invite) return alertFailure(NETWORKS_COPY.joinUnreadable)
    actionSheet(NETWORKS_COPY.joinKindTitle, JOIN_KINDS.map(({ kind, title }) => ({
      title,
      onPress: () => {
        const joining = joinRoleOf(kind, networks)
        if (joining.kind === 'refused') return alertFailure(joining.why)
        void run('network', async () => {
          const joined = await session.command('join_network', { ...invite, role: joining.role, kind })
          if (!joined.ok) return NETWORKS_COPY.failed(failureText(joined.failure))
          // Computers this server trusted only to message don't go into its first network: the person decides about them.
          if (joined.value.leftOut.length > 0) Alert.alert(joined.value.network.name, NETWORKS_COPY.leftOut(joined.value.leftOut))
          return null
        })
      },
    })))
  })
  /** The open server lets go of a network it only visits: its key, and the servers it reached through it. */
  const leave = (network: NetworkEntity) => confirm(NETWORKS_COPY.leaveTitle(network.name), NETWORKS_COPY.leaveMessage, NETWORKS_COPY.leave, () => {
    void run('network', async () => {
      const left = await session.command('remove_network', { networkId: network.id })
      return left.ok ? null : NETWORKS_COPY.failed(failureText(left.failure))
    })
  })
  /** Made by the server holding the network's key: the open one when it does, else another of the person's. */
  const invite = (via: { serverId: string; network: NetworkEntity }) => run('invite', async () => {
    const holder = savedOf(via.serverId)
    if (!holder) return NETWORKS_COPY.failed('that server is no longer on this phone')
    const made = await core.networkInviteOn(holder, via.network.id)
    if (!made.ok) return NETWORKS_COPY.failed(made.why)
    await Share.share({ message: inviteMessage(via.network, made.value, core.deps.clock.now()) }).catch(() => {})
    return null
  })
  const addToNetwork = (row: ServerRow) => {
    const joiner = savedOf(row.id)
    const open = savedOf(activeId)
    if (!joiner || !open) return
    actionSheet(NETWORKS_COPY.addTo, joinChoices(networks).map((choice) => ({
      title: choice.title,
      onPress: () => {
        void run('network', async () => {
          const why = await core.addToNetwork(joiner, open, choice)
          return why === null ? null : NETWORKS_COPY.joinFailed(row.label, why)
        })
      },
    })))
  }

  /** A machine not saved here: being made or failed (Remove), or paired with another phone (Destroy). */
  const removeMachine = (row: MachineRow) => {
    const [title, message, button, failed] = row.kind === 'paired_elsewhere'
      ? [NEW_SERVER_COPY.destroyTitle(row.label), NEW_SERVER_COPY.destroyElsewhereMessage, NEW_SERVER_COPY.destroyConfirm, NEW_SERVER_COPY.destroyFailed]
      : [NEW_SERVER_COPY.removeTitle(row.label), NEW_SERVER_COPY.removeMessage, 'Remove', NEW_SERVER_COPY.removeFailed]
    confirm(title, message, button, () => {
      void run('remove', async () => {
        const why = await ports.deleteMachine(row.id)
        return why === null ? null : failed(why)
      })
    })
  }
  const destroyMachine = (row: ServerRow, machineId: string) => confirm(NEW_SERVER_COPY.destroyTitle(row.label), NEW_SERVER_COPY.destroyMessage, NEW_SERVER_COPY.destroyConfirm, () => {
    void run('destroy', async () => {
      const outcome = await destroyServerMachine(ports, row, machineId)
      return outcome.kind === 'failed' ? NEW_SERVER_COPY.destroyFailed(outcome.why) : null
    })
  })
  const leaveSetup = () => {
    setSettingUp(null)
    void reload()
    reloadHosted()
    reloadMachines()
  }

  if (settingUp?.kind === 'machine') {
    const { id } = settingUp
    return <MachineSetupView label={settingUp.label} read={async () => machineAsHosted(await session.api.machine(id))} onLeave={leaveSetup} />
  }
  if (settingUp?.kind === 'hosted' && account) return <HostedServerSetupView account={account} server={settingUp} onLeave={leaveSetup} />

  const rows = serverRows(servers, activeId, unread, computers.values())
  const unpairedComputers = unpairedComputerRows(computers.values(), servers)
  const sections = networkSections(rows, unpairedComputers, places, pending)
  const note = checkingNote(rows, unread.checking)
  const unpairedHosted: HostedRow[] = account ? hostedRows(hosted.servers, servers) : []
  const madeHere: MachineRow[] = machines ? machineRows(machines.machines, machines.providers, servers, computers.values()) : []

  const retryPlacement = (serverId: string) => { void core.retryPlacement(serverId) }
  const rowMenu = (row: ServerRow, section: NetworkSection) => {
    const outsideNetworks = section.key === 'outside'
    const placement = placements.get(row.id)
    const linked = row.link?.kind === 'linked' ? row.link : null
    const machine = isOwner && row.canRemove && machines ? machineOfServer(row.url, machines.machines) : null
    actionSheet(row.label, [
      ...(!row.isActive ? [{ title: 'Open', onPress: () => { void switchTo(row) } }] : []),
      { title: 'Rename', onPress: () => rename(row) },
      ...(isOwner && networks.length > 0 && outsideNetworks && !row.isActive ? [{ title: `${NETWORKS_COPY.addTo}…`, onPress: () => addToNetwork(row) }] : []),
      ...(isOwner && networks.length === 0 && row.link?.kind === 'not_linked' ? [{ title: SERVERS_COPY.link, onPress: () => { void link(row) } }] : []),
      ...(isOwner && networks.length === 0 && linked ? [{ title: linked.fullTrust ? 'Trust only to message' : 'Trust fully', onPress: () => { void setTrust(linked.computerId, !linked.fullTrust) } }] : []),
      ...(placement?.kind === 'failed' ? [{ title: NETWORKS_COPY.retry, onPress: () => retryPlacement(row.id) }] : []),
      ...(row.canRemove ? [{ title: 'Remove…', destructive: true, onPress: () => remove(row, isNetworkSection(section)) }] : []),
      ...(machine ? [{ title: NEW_SERVER_COPY.destroy, destructive: true, onPress: () => destroyMachine(row, machine.id) }] : []),
    ])
  }
  const unpairedMenu = (row: UnpairedComputerRow, section: NetworkSection) => actionSheet(row.name, [
    ...(networks.length === 0 ? [{ title: row.fullTrust ? 'Trust only to message' : 'Trust fully', onPress: () => { void setTrust(row.computerId, !row.fullTrust) } }] : []),
    { title: SERVERS_COPY.unlink, destructive: true, onPress: () => unlink(row.computerId, row.name, isNetworkSection(section)) },
  ])
  /** Networks: start one (its own page), or join one from an invite on the open server. New servers pick theirs on the
   * New server steps. */
  const networkMenu = () => actionSheet(undefined, [
    { title: NETWORKS_COPY.start, onPress: () => navigation.navigate('NewNetwork') },
    { title: NETWORKS_COPY.join, onPress: join },
    ...(networks.length === 0 ? [{ title: SERVERS_COPY.linkByCommand, onPress: () => navigation.navigate('Computers') }] : []),
  ])

  const statusLine = (row: ServerRow): string | null => {
    if (row.link?.kind !== 'linked') return row.isActive ? null : networks.length === 0 && isOwner ? SERVERS_COPY.notLinked : null
    return `${row.link.stateText}${computers.get(row.link.computerId)?.visiting ? ` · ${NETWORKS_COPY.visiting}` : ''}`
  }

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      {storageFailed && <Text style={s.error}>{SERVERS_COPY.storageError}</Text>}
      {sections.map((section) => (
        <View key={section.key}>
          {section.title !== null && (
            <View style={s.sectionHeader}>
              <View style={{ flex: 1 }}>
                <Text style={s.sectionTitle}>{section.title}</Text>
                {section.detail !== null && <Text style={s.sectionDetail}>{section.detail}</Text>}
              </View>
              {section.leave !== null && isOwner && (
                <Pressable onPress={() => leave(section.leave!)} disabled={busy !== null} hitSlop={8} style={s.invite}>
                  <Text style={[s.inviteText, { color: C.red }]}>{NETWORKS_COPY.leave}</Text>
                </Pressable>
              )}
              {section.inviteVia !== null && isOwner && (
                <Pressable onPress={() => { void invite(section.inviteVia!) }} disabled={busy !== null} hitSlop={8} style={s.invite}>
                  <Symbol name="person.badge.plus" size={14} color="blue" />
                  <Text style={s.inviteText}>{NETWORKS_COPY.invite}</Text>
                </Pressable>
              )}
            </View>
          )}
          {section.rows.map((row) => {
            const status = statusLine(row)
            return (
              <Pressable key={row.id} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]}
                onPress={() => { if (row.isActive) rowMenu(row, section); else void switchTo(row) }}
                onLongPress={() => rowMenu(row, section)}>
                <View style={{ flex: 1 }}>
                  <View style={s.line}>
                    <Text style={s.name} numberOfLines={1}>{row.label}</Text>
                    {row.isActive && <Text style={s.active}>open</Text>}
                  </View>
                  {status !== null && <Text style={s.status} numberOfLines={1}>{status}</Text>}
                  {row.link?.kind === 'linked' && row.link.incompatibility !== null && <Text style={s.warning}>{row.link.incompatibility}</Text>}
                  {row.personText !== null && <Text style={s.status}>{row.personText}</Text>}
                  {placements.has(row.id) && (
                    <View style={s.line}>
                      <Text style={[s.warning, { flexShrink: 1 }]}>{placementText(placements.get(row.id)!)}</Text>
                      {placements.get(row.id)!.kind === 'failed' && (
                        <Pressable onPress={() => retryPlacement(row.id)} hitSlop={8}><Text style={s.inviteText}>{NETWORKS_COPY.retry}</Text></Pressable>
                      )}
                    </View>
                  )}
                </View>
                {row.unreadBadge !== null ? (
                  <View style={s.badge}><Text style={s.badgeText}>{row.unreadBadge}</Text></View>
                ) : row.checking ? <ActivityIndicator size="small" /> : null}
                <Pressable onPress={() => rowMenu(row, section)} hitSlop={10} style={s.more}>
                  <Symbol name="ellipsis.circle" size={20} color="blue" />
                </Pressable>
              </Pressable>
            )
          })}
          {section.unpaired.map((row) => {
            const pairable = readyMachineAt(computers.get(row.computerId)?.address ?? null, machines?.machines ?? [])
            return (
              <Pressable key={row.computerId} style={({ pressed }) => [s.row, { backgroundColor: pressed && pairable ? C.pressed : C.background }]}
                disabled={pairable === null} onPress={() => { if (pairable) setSettingUp({ kind: 'machine', id: pairable.id, label: row.name }) }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{row.name}</Text>
                  <Text style={s.status} numberOfLines={1}>{SERVERS_COPY.notOnPhone} · {row.stateText}{computers.get(row.computerId)?.visiting ? ` · ${NETWORKS_COPY.visiting}` : ''}{pairable ? ` · ${NETWORKS_COPY.addHere}` : ''}</Text>
                  {row.incompatibility !== null && <Text style={s.warning}>{row.incompatibility}</Text>}
                </View>
                {isOwner && (
                  <Pressable onPress={() => unpairedMenu(row, section)} hitSlop={10} style={s.more}>
                    <Symbol name="ellipsis.circle" size={20} color="blue" />
                  </Pressable>
                )}
              </Pressable>
            )
          })}
          {section.emptyNote !== null && <Text style={s.empty}>{section.emptyNote}</Text>}
        </View>
      ))}

      {unpairedHosted.length + madeHere.length > 0 && (
        <View style={s.sectionHeader}><Text style={s.sectionTitle}>Being set up</Text></View>
      )}
      {unpairedHosted.map((row) => (
        <Pressable key={row.id} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]} onPress={() => setSettingUp({ kind: 'hosted', id: row.id, label: row.label })}>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>{row.label}</Text>
            <Text style={s.status} numberOfLines={1}>{row.detail}</Text>
          </View>
          <Symbol name="chevron.right" size={12} color="secondary" />
        </Pressable>
      ))}
      {madeHere.map((row) => {
        const removable = row.kind === 'paired_elsewhere' || row.canRemove
        return (
          <Pressable key={row.id} style={({ pressed }) => [s.row, { backgroundColor: pressed && row.kind === 'setting_up' ? C.pressed : C.background }]}
            disabled={row.kind !== 'setting_up' && !removable}
            onPress={() => { if (row.kind === 'setting_up') setSettingUp({ kind: 'machine', id: row.id, label: row.label }) }}
            onLongPress={removable ? () => removeMachine(row) : undefined}>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{row.label}</Text>
              <Text style={s.status} numberOfLines={2}>{row.detail}</Text>
            </View>
            {removable && (
              <Pressable onPress={() => removeMachine(row)} hitSlop={10} style={s.more}>
                <Symbol name="trash" size={16} color="red" />
              </Pressable>
            )}
            {row.kind === 'setting_up' && <Symbol name="chevron.right" size={12} color="secondary" />}
          </Pressable>
        )
      })}

      {note !== null && <Text style={s.note}>{note}</Text>}
      <View style={s.addRow}>
        <Pressable style={[s.addButton, { backgroundColor: accent, opacity: busy !== null ? 0.6 : 1 }]} onPress={() => navigation.navigate('NewServer')} disabled={busy !== null}>
          <Text style={s.addText}>{NEW_SERVER_COPY.button}</Text>
        </Pressable>
        {isOwner && (
          <Pressable style={[s.addButton, s.networkButton, { opacity: busy !== null ? 0.6 : 1 }]} onPress={networkMenu} disabled={busy !== null}>
            {busy !== null ? <ActivityIndicator /> : <Text style={[s.addText, { color: accent }]}>{NETWORKS_COPY.button}</Text>}
          </Pressable>
        )}
      </View>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.background },
  error: { color: C.red, padding: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: C.secondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  sectionDetail: { fontSize: 12, color: C.tertiary, marginTop: 2 },
  invite: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  inviteText: { fontSize: 14, color: C.blue, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.separator },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 17, fontWeight: '600', color: C.label, flexShrink: 1 },
  active: { fontSize: 11, fontWeight: '700', color: 'white', backgroundColor: C.blue, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  status: { fontSize: 13, color: C.secondary, marginTop: 2 },
  warning: { fontSize: 12, color: C.orange, marginTop: 2 },
  more: { paddingLeft: 4 },
  empty: { fontSize: 13, color: C.tertiary, paddingHorizontal: 16, paddingVertical: 12 },
  badge: { backgroundColor: C.blue, borderRadius: 11, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  badgeText: { color: 'white', fontWeight: '700', fontSize: 12 },
  note: { color: C.secondary, fontSize: 12, textAlign: 'center', marginTop: 12 },
  addRow: { flexDirection: 'row', gap: 12, marginHorizontal: 16, marginTop: 24 },
  addButton: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center' },
  networkButton: { backgroundColor: C.fill },
  addText: { color: 'white', fontWeight: '600', fontSize: 16 },
})
