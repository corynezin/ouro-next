// Choose, add, rename or remove a server, with unread on the others. Removing one only forgets it on this phone. With a hosted
// account, also New server and the account's servers not paired here yet. Renders servers/model.ts.
import { useCallback, useLayoutEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import type { HostedServersView } from '../../core/hub/hostedServers.ts'
import { C } from '../../design/colors.ts'
import { HeaderButton } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { Symbol } from '../../design/Symbol.tsx'
import { accent } from '../../design/theme.ts'
import { useCore, useHostedServers, useOtherServersUnread, useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { HostedServerSetupView } from '../onboarding/SetupScreen.tsx'
import { checkingNote, createFailureText, hostedRows, NEW_SERVER_COPY, NEW_SERVER_LABEL_MAX, newServerLabelOf, renamedLabel, SERVERS_COPY, serverRows } from './model.ts'
import type { HostedRow, ServerRow } from './model.ts'

export function ServersScreen({ navigation }: ScreenProps<'Servers'>) {
  const core = useCore()
  const activeId = useSession().serverId
  const [servers, setServers] = useState<SavedServer[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)
  const hostedServers = useHostedServers()
  const account = core.hostedAccount
  const [hosted, setHosted] = useState<HostedServersView>({ available: false, servers: [] })
  /** The New server form, while it's open. */
  const [naming, setNaming] = useState<{ text: string; creating: boolean; error: string | null } | null>(null)
  const [settingUp, setSettingUp] = useState<{ id: string; label: string } | null>(null)

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
  const unread = useOtherServersUnread()
  useFocusEffect(useCallback(() => {
    void reload()
    void unread.checkIfDue()
    return reloadHosted()
  }, [reload, unread, reloadHosted]))

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

  const remove = (row: ServerRow) => confirm(SERVERS_COPY.removeTitle(row.label), SERVERS_COPY.removeMessage, 'Remove', () => {
    core.removeServer(row.id).then(reload, () => setFailure(SERVERS_COPY.storageError))
  })

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
    if (!naming || !account) return
    const typed = newServerLabelOf(naming.text)
    if (typed === null) return
    if ('error' in typed) return setNaming({ ...naming, error: typed.error })
    setNaming({ ...naming, creating: true, error: null })
    const created = await hostedServers.api.createServer(account.token, { label: typed.label })
    if (!created.ok) return setNaming({ ...naming, creating: false, error: createFailureText(created.failure) })
    setNaming(null)
    setSettingUp({ id: created.value.id, label: created.value.label })
  }

  const leaveSetup = () => {
    setSettingUp(null)
    void reload()
    reloadHosted()
  }

  if (settingUp && account) return <HostedServerSetupView account={account} server={settingUp} onLeave={leaveSetup} />

  const rows = serverRows(servers, activeId, unread)
  const note = checkingNote(rows, unread.checking)
  const unpaired: HostedRow[] = account ? hostedRows(hosted.servers, servers) : []
  const canCreate = naming !== null && !naming.creating && newServerLabelOf(naming.text) !== null

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
              {row.personText !== null && <Text style={s.person}>{row.personText}</Text>}
            </View>
            {row.unreadBadge !== null ? (
              <View style={s.badge}><Text style={s.badgeText}>{row.unreadBadge}</Text></View>
            ) : row.checking ? <ActivityIndicator size="small" /> : null}
            <Symbol name="chevron.right" size={12} color="secondary" />
          </Pressable>
          <View style={s.actions}>
            <Pressable onPress={() => setRenaming({ id: row.id, text: row.label })} style={s.actionButton}><Text style={s.actionText}>Rename</Text></Pressable>
            {row.canRemove && <Pressable onPress={() => remove(row)} style={s.actionButton}><Text style={[s.actionText, { color: C.red }]}>Remove</Text></Pressable>}
          </View>
        </View>
      ))}
      {note !== null && <Text style={s.note}>{note}</Text>}
      {unpaired.map((row) => (
        <Pressable key={row.id} style={({ pressed }) => [s.row, { backgroundColor: pressed ? C.pressed : C.background }]} onPress={() => setSettingUp(row)}>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>{row.label}</Text>
            <Text style={s.url} numberOfLines={1}>{row.detail}</Text>
          </View>
          <Symbol name="chevron.right" size={12} color="secondary" />
        </Pressable>
      ))}
      <View style={{ height: 24 }} />
      {naming !== null ? (
        <View style={s.newForm}>
          <Text style={s.newLabel}>{NEW_SERVER_COPY.title}</Text>
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
          <Text style={s.hint}>{NEW_SERVER_COPY.hint}</Text>
        </View>
      ) : hosted.available && account ? (
        <Pressable style={[s.addButton, { backgroundColor: accent, marginBottom: 12 }]} onPress={() => setNaming({ text: '', creating: false, error: null })}>
          <Text style={s.addText}>{NEW_SERVER_COPY.button}</Text>
        </Pressable>
      ) : null}
      <Pressable style={[s.addButton, { backgroundColor: accent }]} onPress={() => navigation.navigate('Pair')}>
        <Text style={s.addText}>Add a server</Text>
      </Pressable>
    </ScrollView>
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
  hint: { fontSize: 12, color: C.tertiary, textAlign: 'center', marginTop: 8 },
  createError: { color: C.red, fontSize: 13, marginTop: 6, textAlign: 'center' },
  renameInput: { fontSize: 17, fontWeight: '600', color: C.label, borderBottomWidth: 1, borderBottomColor: C.blue, paddingVertical: 2 },
})
