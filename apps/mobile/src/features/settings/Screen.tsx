// Settings: this server, servers, people, computers and invites, privacy, the list, avatars, the app, archived agents, and
// signing out or unpairing. Notifications are in NotificationSections. Plan usage from the server's readings. Renders settings/model.ts.
import { Fragment, useEffect, useLayoutEffect, useState } from 'react'
import { Linking, Share } from 'react-native'
import { Button, Form, Host, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { disabled, font, foregroundStyle, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import * as Application from 'expo-application'
import * as LocalAuthentication from 'expo-local-authentication'
import * as Updates from 'expo-updates'
import { failureText } from '../../core/session/serverApi.ts'
import { checkOutcomeText, runningCodeText } from '../../core/updates/updateFlow.ts'
import type { CheckOutcome } from '../../core/updates/updateFlow.ts'
import { timeOfDay } from '../../design/format.ts'
import { Field, HeaderButton, KV, Note, useBlurFields } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { runningCode } from '../../native/updates.ts'
import { useCore, useCoreVersion, useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { COMPUTERS_COPY } from '../computers/model.ts'
import { useUpdateFlow } from '../../navigation/UpdateBanner.tsx'
import { AutoArchiveSection, ReplyRemindersSection } from './AutoArchiveSection.tsx'
import { claudePlanRows, isClaudeOnPlan, planUsageFooter } from '../shared/planUsage.ts'
import { NotificationSections } from './NotificationSections.tsx'
import { OPENROUTER_CREDITS_FOOTER, openRouterCreditsText } from '../integrations/model.ts'
import { BACKUP_MADE_TOAST, backupSection, BASE_UPDATE_STARTED, baseSection, binaryVersionText, channelText, connectedText, faceIdNote, foldKey, foldOptions, leaveAction, peopleRows, SETTINGS_COPY, unpairFooter, updateHomeIndex, updateHomeOptions } from './model.ts'
import type { FaceIdCheck, PersonRow } from './model.ts'
import type { SavedServer } from '../../core/accounts/savedServers.ts'

export function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const updates = useUpdateFlow()
  const core = useCore()
  const session = useSession()
  useSessionVersion(session)
  const now = useNow(60_000)
  const preferences = core.preferences.current
  const { viewer, server } = session.store
  const [faceIdText, setFaceIdText] = useState<string | null>(null)
  const [check, setCheck] = useState<CheckOutcome | 'checking' | null>(null)
  const [inviteName, setInviteName] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: number; link: string } | null>(null)
  const [inviteFailure, setInviteFailure] = useState<string | null>(null)
  const [removeFailure, setRemoveFailure] = useState<string | null>(null)
  const [backupFailure, setBackupFailure] = useState<string | null>(null)
  const [baseTakeOutcome, setBaseTakeOutcome] = useState<{ text: string; color: 'orange' | 'red' } | null>(null)
  const personRows = peopleRows(session.store.people.values(), session.store.devices.values())
  const { field, blurFields } = useBlurFields()
  const [savedServers, setSavedServers] = useState<SavedServer[]>([])
  const coreVersion = useCoreVersion(core)
  /** Signed up through the hub; someone running their own server has none. */
  const account = core.hostedAccount
  useEffect(() => { core.servers.list().then(setSavedServers, () => {}) }, [core, coreVersion])

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Settings', headerRight: () => <HeaderButton title="Done" bold onPress={() => { void blurFields().then(() => navigation.goBack()) }} /> })
  }, [navigation])

  const setRequireFaceId = async (on: boolean) => {
    setFaceIdText(null)
    if (!on) return core.preferences.set('requireFaceId', false)
    const result = await confirmFaceId()
    setFaceIdText(faceIdNote(result))
    if (result.kind === 'confirmed') core.preferences.set('requireFaceId', true)
  }

  const checkForUpdate = async () => {
    setCheck('checking')
    setCheck(await updates.checkNow())
  }

  const sendInvite = async () => {
    await blurFields()
    setInviteFailure(null)
    const started = await session.command('start_pairing', { inviteePersonName: inviteName.trim() })
    if (started.ok) setInvite(started.value)
    else setInviteFailure(failureText(started.failure))
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

  const startBackup = async (action: 'connect_github' | 'make_private_copy') => {
    setBackupFailure(null)
    if (action === 'connect_github') return navigation.navigate('GitHub', { thenMakePrivateCopy: true })
    const made = await session.command('create_source_backup', {})
    if (made.ok) toast(BACKUP_MADE_TOAST)
    else setBackupFailure(failureText(made.failure))
  }

  const hasHostedAccount = core.hostedAccount !== null
  const leave = leaveAction(hasHostedAccount)
  // Signing out also refuses while the saved server list is damaged, so nothing recovery needs is deleted.
  const confirmLeave = () => confirm(leave.confirmTitle, leave.confirmMessage, leave.confirmLabel, () => {
    const leaving = hasHostedAccount ? core.signOut() : core.removeServer(session.serverId)
    leaving.catch(() => toast(leave.failedText, 'exclamationmark.triangle'))
  })

  const serverUrl = session.api.endpoint.url
  const options = foldOptions(server?.limits.idleFoldMinutes)
  const homeOptions = updateHomeOptions(savedServers)
  const creditsText = openRouterCreditsText(session.store.integration('openrouter')?.state ?? null)
  const base = server ? baseSection(server.release, viewer?.isOwner ?? false) : null
  const backup = server ? backupSection(server.sourceBackup, viewer?.isOwner ?? false, now) : null
  const planRows = server ? claudePlanRows(server.planUsage.claude, isClaudeOnPlan(session.store.integration('claude')?.state ?? null), now) : null

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Integrations">
          <Button label="Claude Code" onPress={() => navigation.navigate('Claude')} />
          <Button label="ChatGPT" onPress={() => navigation.navigate('ChatGPT')} />
          <Button label="OpenRouter" onPress={() => navigation.navigate('OpenRouter')} />
          <Button label="GitHub" onPress={() => navigation.navigate('GitHub')} />
        </Section>
        {account ? (
          <Section title="Account">
            <KV k="Name" v={account.name} />
            <KV k="User" v={account.accountId} mono />
          </Section>
        ) : null}
        <Section title="Server">
          <KV k="Address" v={serverUrl} mono />
          <KV k="This device" v={viewer?.deviceName} />
          <KV k="You" v={viewer?.personName} />
          <KV k="Machine" v={server?.machineName} />
          {server ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{connectedText(server.release)}</Text> : null}
        </Section>
        <Section title="Servers" footer={<Text>{SETTINGS_COPY.serversFooter}</Text>}>
          <Button label="Manage servers" onPress={() => navigation.navigate('Servers')} />
        </Section>
        {viewer?.isOwner && personRows.length > 0 ? (
          <Section title="People" footer={<Text>{SETTINGS_COPY.peopleFooter}</Text>}>
            {personRows.map((row) => (
              <Fragment key={row.personId}>
                <KV k={row.name} v={row.devicesText} />
                <Button label={`${row.name}'s chats`} onPress={() => { navigation.goBack(); navigation.navigate('Person', { address: row.address }) }} />
                <Button label="Remove" role="destructive" onPress={() => removePerson(row)} />
              </Fragment>
            ))}
            {removeFailure !== null ? <Note text={removeFailure} color="red" /> : null}
          </Section>
        ) : null}
        {viewer?.isOwner ? (
          <Section footer={<Text>{COMPUTERS_COPY.settingsFooter}</Text>}>
            <Button label="Computers" onPress={() => navigation.navigate('Computers')} />
          </Section>
        ) : null}
        {viewer?.isOwner ? (
          <Section title="Invite a friend" footer={<Text>{SETTINGS_COPY.inviteFooter}</Text>}>
            {invite ? (
              <>
                <KV k="Code" v={invite.code} mono />
                <KV k="Expires" v={timeOfDay(invite.expiresAt)} />
                <KV k="Server" v={serverUrl} mono />
                <Button label="Share link" onPress={() => { Share.share({ message: invite.link }).catch(() => {}) }} />
                <Button label="Done" onPress={() => { setInvite(null); setInviteName('') }} />
              </>
            ) : (
              <>
                <Field ref={field} placeholder="Their name" value={inviteName} onChange={setInviteName} />
                <Button label="Invite a friend" modifiers={[disabled(!inviteName.trim())]} onPress={() => { void sendInvite() }} />
                {inviteFailure !== null ? <Note text={inviteFailure} color="red" /> : null}
              </>
            )}
          </Section>
        ) : null}
        {backup ? (
          <Section title="Backup" footer={<Text>{backup.detail}</Text>}>
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
          </Section>
        ) : null}
        {base ? (
          <Section title="Ouro" footer={<Text>{base.footer}</Text>}>
            <KV k="Version" v={base.versionText} />
            {base.updatingText !== null ? <KV k="Update" v={base.updatingText} /> : null}
            {base.note !== null ? <Note text={base.note.text} color={base.note.color} /> : null}
            {base.take !== null ? <Button label={base.take.label} onPress={() => { void takeBase(base.take!.n) }} /> : null}
            {baseTakeOutcome !== null ? <Note text={baseTakeOutcome.text} color={baseTakeOutcome.color} /> : null}
          </Section>
        ) : null}
        {planRows !== null && server ? (
          <Section title="Plan usage" footer={<Text>{planUsageFooter(server.machineName)}</Text>}>
            {planRows.map((row) => <KV key={row.key} k={row.label} v={row.valueText} />)}
          </Section>
        ) : null}
        {creditsText !== null ? (
          <Section title="OpenRouter credits" footer={<Text>{OPENROUTER_CREDITS_FOOTER}</Text>}>
            <KV k="Spent" v={creditsText} />
          </Section>
        ) : null}
        <NotificationSections />
        <Section title="Privacy">
          {faceIdText !== null ? <Note text={faceIdText} /> : null}
          <Toggle label="Require Face ID to open" isOn={preferences.requireFaceId} onIsOnChange={(on) => { void setRequireFaceId(on) }} />
        </Section>
        <Section title="Agents list" footer={<Text>{SETTINGS_COPY.foldFooter}</Text>}>
          <Picker label="Fold idle agents" selection={foldKey(preferences.idleFold)} modifiers={[pickerStyle('menu')]}
            onSelectionChange={(key) => {
              const chosen = options.find((option) => option.key === String(key))
              if (chosen) core.preferences.set('idleFold', chosen.fold)
            }}>
            {options.map((option) => <Text key={option.key} modifiers={[tag(option.key)]}>{option.label}</Text>)}
          </Picker>
        </Section>
        {viewer?.isOwner ? <AutoArchiveSection /> : null}
        {viewer?.isOwner ? <ReplyRemindersSection /> : null}
        <Section title="Avatars" footer={<Text>{SETTINGS_COPY.avatarsFooter}</Text>}>
          <Toggle label="Model avatars" isOn={preferences.modelAvatars} onIsOnChange={(on) => core.preferences.set('modelAvatars', on)} />
        </Section>
        <Section title="App" footer={<Text>{`${SETTINGS_COPY.appFooter} ${SETTINGS_COPY.updatesFromFooter}`}</Text>}>
          <KV k="Running" v={runningCodeText(runningCode())} />
          <KV k="Version" v={binaryVersionText(Application.nativeApplicationVersion, Application.nativeBuildVersion)} />
          <KV k="Runtime" v={Updates.runtimeVersion} />
          <KV k="Channel" v={channelText(Updates.channel)} />
          <Picker label="Updates from" selection={updateHomeIndex(homeOptions, preferences.updateHomeServerId)} modifiers={[pickerStyle('menu')]}
            onSelectionChange={(index) => {
              const chosen = homeOptions[Number(index)]
              if (chosen) core.setUpdateHome(chosen.serverId)
            }}>
            {homeOptions.map((option, index) => <Text key={option.serverId ?? 'none'} modifiers={[tag(index)]}>{option.label}</Text>)}
          </Picker>
          <Button label="Check for an update" onPress={() => { void checkForUpdate() }} />
          {check !== null ? <Note text={checkOutcomeText(check)} color="secondary" /> : null}
        </Section>
        <Section footer={hasHostedAccount ? undefined : <Text>{unpairFooter(viewer?.deviceName)}</Text>}>
          <Button label="Archived agents" onPress={() => { navigation.goBack(); navigation.navigate('Archived') }} />
          <Button label={leave.label} role="destructive" onPress={confirmLeave} />
        </Section>
      </Form>
    </Host>
  )
}

async function confirmFaceId(): Promise<FaceIdCheck> {
  const usable = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync())
  if (!usable) return { kind: 'unavailable' }
  const prompt = await LocalAuthentication.authenticateAsync({ promptMessage: 'Lock Ouro with Face ID' })
  return prompt.success ? { kind: 'confirmed' } : { kind: 'refused' }
}
