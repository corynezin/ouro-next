// Settings: integrations (connected or not, Tailscale among them), servers by short name (each linked one is a computer the
// others can run agents on), people and an invite page (the owner's),
// notifications (on or off, and urgent), updates (Ouro, backup and the app), archived agents, and signing out or
// unpairing. Notifications are in NotificationsSection. Renders settings/model.ts.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import { Button, Form, Host, HStack, Menu, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui'
import { foregroundStyle, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { failureText } from '../../core/session/serverApi.ts'
import { checkOutcomeText, runningCodeText } from '../../core/updates/updateFlow.ts'
import type { CheckOutcome } from '../../core/updates/updateFlow.ts'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { runningCode } from '../../native/updates.ts'
import { useCore, useCoreVersion, useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { useUpdateFlow } from '../../navigation/UpdateBanner.tsx'
import { NotificationsSection } from './NotificationsSection.tsx'
import { StatusRow } from './StatusRow.tsx'
import { useRouteStatus } from './useRouteStatus.ts'
import {
  BACKUP_MADE_TOAST, backupSection, BASE_UPDATE_STARTED, baseSection, awsStatusText, spritesStatusText, tailscaleStatusText, integrationRows, leaveAction, peopleRows, serverShortName,
  updateHomeIndex, updateHomeOptions,
} from './model.ts'
import type { BaseSection, PersonRow } from './model.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import type { SpritesIntegrationState } from '@ouro/contract'

export function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const updates = useUpdateFlow()
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const preferences = core.preferences.current
  const { viewer, server } = session.store
  const isOwner = viewer?.isOwner ?? false
  const now = useNow(60_000)
  const [check, setCheck] = useState<CheckOutcome | 'checking' | null>(null)
  const [removeFailure, setRemoveFailure] = useState<string | null>(null)
  const [backupFailure, setBackupFailure] = useState<string | null>(null)
  const [baseTakeOutcome, setBaseTakeOutcome] = useState<{ text: string; color: 'orange' | 'red' } | null>(null)
  const personRows = peopleRows(session.store.people.values(), session.store.devices.values())
  const [savedServers, setSavedServers] = useState<SavedServer[]>([])
  const coreVersion = useCoreVersion(core)
  /** Signed up through the hub; someone running their own server has none. */
  const account = core.hostedAccount
  useEffect(() => { core.servers.list().then(setSavedServers, () => {}) }, [core, coreVersion])
  // AWS, Sprites and Tailscale aren't synced: each is asked of its own route. Only the owner makes servers with Sprites; an
  // older server has no such route, and then there is no row.
  const aws = useRouteStatus(navigation, useCallback(() => session.api.awsStatus(), [session]))
  const loadSprites = useCallback(() => session.api.spritesStatus(), [session])
  const sprites = useRouteStatus<SpritesIntegrationState>(navigation, isOwner ? loadSprites : null)
  const loadTailscale = useCallback(async () => {
    const result = await session.api.tailscale('GET')
    return result.ok ? { ok: true as const, value: result.value.tailscale } : result
  }, [session])
  const tailscale = useRouteStatus(navigation, isOwner ? loadTailscale : null)

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Settings', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const checkForUpdate = async () => {
    setCheck('checking')
    setCheck(await updates.checkNow())
  }

  const removePerson = (row: PersonRow) => confirm(row.removeTitle, row.removeMessage, 'Remove', async () => {
    setRemoveFailure(null)
    const removed = await session.command('remove_person', { personId: row.personId })
    if (!removed.ok) setRemoveFailure(failureText(removed.failure))
  })

  const takeBase = async (n: number) => {
    setBaseTakeOutcome(null)
    const taken = await session.command('take_base_update', { n })
    setBaseTakeOutcome(taken.ok ? { text: BASE_UPDATE_STARTED, color: 'orange' } : { text: failureText(taken.failure), color: 'red' })
  }

  const resolveBase = async () => {
    setBaseTakeOutcome(null)
    const started = await session.command('resolve_base_update', {})
    if (!started.ok) setBaseTakeOutcome({ text: failureText(started.failure), color: 'red' })
  }

  const dropBase = (conflict: NonNullable<BaseSection['conflict']>) => confirm(conflict.dropTitle, conflict.dropMessage, conflict.dropConfirmLabel, async () => {
    setBaseTakeOutcome(null)
    const dropped = await session.command('drop_base_update', {})
    if (!dropped.ok) setBaseTakeOutcome({ text: failureText(dropped.failure), color: 'red' })
  })

  const startBackup = async (action: 'connect_github' | 'make_private_copy') => {
    setBackupFailure(null)
    if (action === 'connect_github') return navigation.navigate('GitHub', { thenMakePrivateCopy: true })
    const made = await session.command('create_source_backup', {})
    if (made.ok) toast(BACKUP_MADE_TOAST)
    else setBackupFailure(failureText(made.failure))
  }

  const hasHostedAccount = account !== null
  const leave = leaveAction(hasHostedAccount)
  // Signing out also refuses while the saved server list is damaged, so nothing recovery needs is deleted.
  const confirmLeave = () => confirm(leave.confirmTitle, leave.confirmMessage, leave.confirmLabel, () => {
    const leaving = hasHostedAccount ? core.signOut() : core.removeServer(session.serverId)
    leaving.catch(() => toast(leave.failedText, 'exclamationmark.triangle'))
  })

  const homeOptions = updateHomeOptions(savedServers)
  const integrations = integrationRows({
    claude: session.store.integration('claude')?.state ?? null,
    chatgpt: session.store.integration('chatgpt')?.state ?? null,
    openrouter: session.store.integration('openrouter')?.state ?? null,
    github: session.store.integration('github')?.state ?? null,
  })
  const base = server ? baseSection(server.release, isOwner) : null
  const backup = server ? backupSection(server.sourceBackup, isOwner, now) : null

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Integrations">
          {integrations.map((row) => <StatusRow key={row.key} title={row.title} status={row.status} onPress={() => navigation.navigate(row.route)} />)}
          <StatusRow title="AWS" status={awsStatusText(aws)} onPress={() => navigation.navigate('AWS')} />
          {isOwner && sprites.kind !== 'failed' ? <StatusRow title="Sprites" status={spritesStatusText(sprites)} onPress={() => navigation.navigate('Sprites')} /> : null}
          {isOwner ? <StatusRow title="Tailscale" status={tailscaleStatusText(tailscale)} onPress={() => navigation.navigate('Tailscale')} /> : null}
        </Section>

        <Section title="Servers">
          <StatusRow title={serverShortName(savedServers, session.serverId, server?.machineName ?? null)}
            status={savedServers.length > 1 ? `${savedServers.length} servers` : 'Switch or add'} onPress={() => navigation.navigate('Servers')} />
        </Section>

        {isOwner ? (
          <Section title="People">
            {personRows.map((row) => (
              <Menu key={row.personId} label={(
                <HStack>
                  <Text modifiers={[foregroundStyle('primary')]}>{row.name}</Text>
                  <Spacer />
                  <Text modifiers={[foregroundStyle('secondary')]}>{row.devicesText}</Text>
                </HStack>
              )}>
                <Button label={`${row.name}'s chats`} systemImage="bubble.left.and.bubble.right" onPress={() => { navigation.goBack(); navigation.navigate('Person', { address: row.address }) }} />
                <Button label="Remove" systemImage="person.badge.minus" role="destructive" onPress={() => removePerson(row)} />
              </Menu>
            ))}
            {removeFailure !== null ? <Note text={removeFailure} color="red" /> : null}
            <StatusRow title="Invite someone" onPress={() => navigation.navigate('Invite')} />
          </Section>
        ) : null}

        <NotificationsSection />

        <Section title="Updates" footer={base?.footer ? <Text>{base.footer}</Text> : undefined}>
          {base ? <KV k="Ouro" v={base.updatingText ?? base.versionText} /> : null}
          {base?.note ? <Note text={base.note.text} color={base.note.color} /> : null}
          {base?.take ? <Button label={base.take.label} onPress={() => { void takeBase(base.take!.n) }} /> : null}
          {base?.conflict ? <Button label={base.conflict.resolveLabel} onPress={() => { void resolveBase() }} /> : null}
          {base?.conflict ? <Button label={base.conflict.dropLabel} onPress={() => dropBase(base.conflict!)} /> : null}
          {baseTakeOutcome !== null && (baseTakeOutcome.color === 'red' || base?.updatingText) ? <Note text={baseTakeOutcome.text} color={baseTakeOutcome.color} /> : null}
          {backup ? (
            <>
              {backup.warning !== null ? <Note text={backup.warning} color="orange" /> : null}
              {backup.failure !== null ? <Note text={backup.failure} color="red" /> : null}
              {backup.working !== null ? <Note text={backup.working} color="orange" /> : null}
              {backup.copy !== null ? (backup.copy.url !== null
                ? <Button label={backup.copy.headline} onPress={() => { void Linking.openURL(backup.copy!.url!) }} />
                : <KV k="Backup" v={backup.copy.headline} />) : null}
              {backup.copy?.lastPushedText != null ? <KV k="Last pushed" v={backup.copy.lastPushedText} /> : null}
              {backup.copy?.pendingText != null ? <Note text={backup.copy.pendingText} color="orange" /> : null}
              {backup.action !== null ? <Button label={backup.action.label} onPress={() => { void startBackup(backup.action!.kind) }} /> : null}
              {backupFailure !== null ? <Note text={backupFailure} color="red" /> : null}
            </>
          ) : null}
          <KV k="App" v={runningCodeText(runningCode())} />
          <Picker label="App updates from" selection={updateHomeIndex(homeOptions, preferences.updateHomeServerId)} modifiers={[pickerStyle('menu')]}
            onSelectionChange={(index) => {
              const chosen = homeOptions[Number(index)]
              if (chosen) core.setUpdateHome(chosen.serverId)
            }}>
            {homeOptions.map((option, index) => <Text key={option.serverId ?? 'none'} modifiers={[tag(index)]}>{option.label}</Text>)}
          </Picker>
          <Button label="Check for an app update" onPress={() => { void checkForUpdate() }} />
          {check !== null ? <Note text={checkOutcomeText(check)} color="secondary" /> : null}
        </Section>

        <Section>
          {/* Face ID is no longer offered; a phone that has it on can still turn it off here. */}
          {preferences.requireFaceId ? <Toggle label="Require Face ID to open" isOn onIsOnChange={(on) => { if (!on) core.preferences.set('requireFaceId', false) }} /> : null}
          <StatusRow title="Archived agents" onPress={() => { navigation.goBack(); navigation.navigate('Archived') }} />
          <Button label={leave.label} role="destructive" onPress={confirmLeave} />
        </Section>
      </Form>
    </Host>
  )
}
