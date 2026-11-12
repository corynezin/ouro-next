// The root of the app: startup, damaged-setup recovery, pairing, and then the active server's screens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, Button, Linking, LogBox, Text, View, useColorScheme } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native'
import type { InitialState, LinkingOptions } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { RECOVERY_FAILED_MESSAGE } from '../core/appCore.ts'
import type { AppCore } from '../core/appCore.ts'
import type { HostedServers } from '../core/hub/hostedServers.ts'
import type { Place, UpdateFlow } from '../core/updates/updateFlow.ts'
import type { LockGate } from '../core/lock/lockGate.ts'
import type { PushCenter } from '../core/push/pushCenter.ts'
import type { OtherServersUnread } from '../core/servers/otherServersUnread.ts'
import { LockCover } from './LockCover.tsx'
import { runningCode, useUpdatesDownloadedAtLaunch } from '../native/updates.ts'
import { updateMarkView } from '../core/updates/updateFlow.ts'
import { UpdateMarkProvider, type UpdateMarkReader } from '../design/UpdateMarks.tsx'
import { C } from '../design/colors.ts'
import { accent } from '../design/theme.ts'
import { toast, ToastHost } from '../design/Toast.tsx'
import { AgentsScreen } from '../features/agents/Screen.tsx'
import { ArchivedScreen } from '../features/archived/Screen.tsx'
import { ChatInfoScreen } from '../features/chatInfo/Screen.tsx'
import { ChatsScreen } from '../features/chats/Screen.tsx'
import { ChatRoomScreen } from '../features/room/Screen.tsx'
import { RemoteChatScreen } from '../features/remoteAgent/Screen.tsx'
import { DetailsScreen } from '../features/details/Screen.tsx'
import { GoalScreen } from '../features/goal/Screen.tsx'
import { ContextRequestScreen, ContextScreen } from '../features/context/Screen.tsx'
import { LogScreen, RemoteLogScreen } from '../features/log/Screen.tsx'
import { AllSummariesScreen } from '../features/summaries/AllSummariesScreen.tsx'
import { SummariesScreen } from '../features/summaries/Screen.tsx'
import { ChatScreen } from '../features/chat/Screen.tsx'
import { SetupScreen } from '../features/onboarding/SetupScreen.tsx'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen.tsx'
import { NewAgentScreen } from '../features/newAgent/Screen.tsx'
import { AddToChatScreen, NewGroupScreen } from '../features/newChat/Screen.tsx'
import { PairScreen } from '../features/pair/Screen.tsx'
import { PersonScreen } from '../features/person/Screen.tsx'
import { NewNetworkScreen, NewServerDetailsScreen, NewServerNetworkScreen, NewServerScreen } from '../features/servers/NewServerScreen.tsx'
import { ServersScreen } from '../features/servers/Screen.tsx'
import { SettingsScreen } from '../features/settings/Screen.tsx'
import { InviteScreen } from '../features/settings/InviteScreen.tsx'
import { ChatGptScreen } from '../features/integrations/ChatGptScreen.tsx'
import { ClaudeScreen } from '../features/integrations/ClaudeScreen.tsx'
import { AwsScreen } from '../features/integrations/AwsScreen.tsx'
import { SpritesScreen } from '../features/integrations/SpritesScreen.tsx'
import { GitHubScreen } from '../features/integrations/GitHubScreen.tsx'
import { OpenRouterScreen } from '../features/integrations/OpenRouterScreen.tsx'
import { ComputersScreen } from '../features/computers/Screen.tsx'
import { TailscaleScreen } from '../features/computers/TailscaleScreen.tsx'
import { SelectTextScreen } from '../features/selectText/Screen.tsx'
import { FileScreen } from '../features/file/Screen.tsx'
import { recoveryBanner, rootView } from '../features/shell/model.ts'
import { OpenedLinks, openedLinkAction } from './openedLinks.ts'
import { CoreProvider, HostedServersProvider, OtherServersUnreadProvider, PushProvider, SessionProvider, useCoreVersion } from './coreContext.tsx'
import { navigationRef } from './navigationRef.ts'
import { isShowingPushPlace, routeOfPushPlace } from './pushOpening.ts'
import { BannerHeightProvider, UpdateBanner, UpdateFlowProvider, useReadyToRestart } from './UpdateBanner.tsx'
import type { Routes } from './routes.ts'

const Stack = createNativeStackNavigator<Routes>()
LogBox.ignoreAllLogs() // dev warnings cover the composer in screenshots; errors still show

const linking: LinkingOptions<Routes> = {
  prefixes: ['ouronext://'],
  config: { screens: { Agents: 'agents', Chat: 'chat/:agentRef', Log: 'log/:agentRef', Agent: 'agent/:agentRef', Archived: 'archived', Chats: 'chats', ChatRoom: 'room/:chatId', New: 'new', Settings: 'settings', Servers: 'servers', AllSummaries: 'summaries' } },
}

/** What the version before an update restart left open, until it's been reopened or found not to apply. */
type SavedPlaceState = { stage: 'reading' } | { stage: 'read'; place: Place | null }

export function AppRoot({ core, hostedServers, updates, lock, push, otherServersUnread }: {
  core: AppCore; hostedServers: HostedServers; updates: UpdateFlow; lock: LockGate; push: PushCenter; otherServersUnread: OtherServersUnread
}) {
  useCoreVersion(core)
  useUpdatesDownloadedAtLaunch(updates)
  const dark = useColorScheme() === 'dark'
  const [recovering, setRecovering] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const [bannerHeight, setBannerHeight] = useState(0)
  const [savedPlace, setSavedPlace] = useState<SavedPlaceState>({ stage: 'reading' })
  const savedPlaceUsed = useRef(false)
  /** From Welcome: the person has a server of their own. A pair link opened on Welcome comes along. */
  const [pairChosen, setPairChosen] = useState<{ link: string | null } | null>(null)

  useEffect(() => {
    void core.start()
    void updates.takeSavedPlace().then((place) => setSavedPlace({ stage: 'read', place }))
    updates.start()
    return () => updates.stop()
  }, [core, updates])

  const startupReady = core.startup.stage === 'ready'
  useEffect(() => {
    if (!startupReady) return
    lock.start()
    return () => lock.stop()
  }, [lock, startupReady])

  // Links, each handled once, here. A pair link while paired pairs and switches to that server; with no server it opens
  // the Pair form with it. An invite link fills Welcome's code.
  const [invitedCode, setInvitedCode] = useState<string | null>(null)
  const [openedLinks] = useState(() => new OpenedLinks((link) => {
    const action = openedLinkAction(link, core.activeSession !== null)
    if (action?.kind === 'pair_and_switch') {
      core.pairAndActivate(action.url, action.code).catch((failure: unknown) => {
        toast(`Pairing failed: ${failure instanceof Error ? failure.message : String(failure)}`)
      })
    } else if (action?.kind === 'open_pair_form') setPairChosen({ link: action.link })
    else if (action?.kind === 'fill_invite_code') setInvitedCode(action.code)
  }))
  useEffect(() => {
    void Linking.getInitialURL().then((url) => { if (url) openedLinks.arrived(url) })
    const subscription = Linking.addEventListener('url', (event) => openedLinks.arrived(event.url))
    return () => subscription.remove()
  }, [openedLinks])
  // Startup has read the server list once it is anything but loading; a failed startup has no server to switch from.
  const startupSettled = core.startup.stage !== 'loading'
  useEffect(() => { if (startupSettled) openedLinks.startupFinished() }, [openedLinks, startupSettled])

  const recover = async (reset: () => Promise<void>) => {
    setRecovering(true)
    setRecoveryFailed(false)
    try {
      await reset()
    } catch {
      setRecoveryFailed(true)
    } finally {
      setRecovering(false)
    }
  }

  const session = core.activeSession
  const [navigationReadyFor, setNavigationReadyFor] = useState<string | null>(null)
  usePushOpenings(push, core, navigationReadyFor)
  const updateBannerShown = useReadyToRestart(updates)
  // What the app runs changes only with a restart, so it is read once; the banner's coming changes what a mark says.
  const running = useMemo(runningCode, [])
  const readUpdateMark = useCallback<UpdateMarkReader>((mark) => updateMarkView(mark, running, updateBannerShown), [running, updateBannerShown])
  const view = savedPlace.stage === 'reading' ? { kind: 'loading' as const } : rootView(core.startup, session?.serverId ?? null, core.hostedAccount !== null)
  // A Pair form chosen, or opened by a link, is done with once a server is active: kept, it would open again with its
  // old, spent link after the next unpair or removal.
  useEffect(() => { if (view.kind === 'server') setPairChosen(null) }, [view.kind])
  const initialState = view.kind === 'server' ? placeToReopen(savedPlace, view.serverId, savedPlaceUsed) : undefined
  const banner = recoveryBanner({ startup: core.startup, preferencesDamaged: core.preferences.needsRecovery, serverListDamaged: core.servers.needsRecovery })
  const baseTheme = dark ? DarkTheme : DefaultTheme
  const textColor = dark ? 'white' : 'black'
  const theme = { ...baseTheme, colors: { ...baseTheme.colors, primary: accent, background: dark ? '#000' : '#fff' } }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <CoreProvider value={core}>
          <HostedServersProvider value={hostedServers}>
          <UpdateFlowProvider value={updates}>
          <PushProvider value={push}>
          <OtherServersUnreadProvider value={otherServersUnread}>
          <UpdateMarkProvider value={readUpdateMark}>
            <UpdateBanner flow={updates} onHeight={setBannerHeight} />
            {banner && (
              <BelowStatusBar updateBannerShown={updateBannerShown}>
                <Text style={{ color: textColor }}>{banner.text}</Text>
                {banner.offerPreferencesReset && <Button disabled={recovering} title="Reset damaged preferences" onPress={() => { void recover(() => core.resetDamagedPreferences()) }} />}
                {banner.offerServerListReset && <Button disabled={recovering} title="Reset server list and pair again" onPress={() => { void recover(() => core.resetDamagedServerList()) }} />}
                {recoveryFailed && <Text style={{ color: textColor }}>{RECOVERY_FAILED_MESSAGE}</Text>}
              </BelowStatusBar>
            )}
            <StatusBar style="auto" />
            {view.kind === 'loading' && <NavigationlessBackground><ActivityIndicator /></NavigationlessBackground>}
            {view.kind === 'startup_failed' && (
              <NavigationlessBackground>
                <Text style={{ color: textColor, padding: 24 }}>{view.message}</Text>
                <Button title="Retry startup" onPress={() => { void core.start() }} />
              </NavigationlessBackground>
            )}
            {view.kind === 'welcome' && (pairChosen
              ? <PairScreen openedLink={pairChosen.link} onBack={() => setPairChosen(null)} />
              : <WelcomeScreen invitedCode={invitedCode} onChoosePair={() => setPairChosen({ link: null })} />)}
            {view.kind === 'setup' && core.hostedAccount && <SetupScreen account={core.hostedAccount} />}
            {view.kind === 'server' && session && (
              <SessionProvider value={session}>
                <BannerHeightProvider height={bannerHeight}>
                <NavigationContainer key={view.serverId} ref={navigationRef} theme={theme} linking={linking} initialState={initialState}
                  onReady={() => setNavigationReadyFor(view.serverId)}>
                  <Stack.Navigator screenOptions={{ headerTintColor: accent, headerTitleStyle: { color: textColor }, headerLargeTitleStyle: { color: textColor } }}>
                    <Stack.Screen name="Agents" component={AgentsScreen} options={{ title: 'Agents', headerTitle: '', headerTransparent: false }} />
                    <Stack.Screen name="Chat" component={ChatScreen} options={{ title: '' }} />
                    <Stack.Screen name="Log" component={LogScreen} />
                    <Stack.Screen name="RemoteLog" component={RemoteLogScreen} />
                    <Stack.Screen name="Context" component={ContextScreen} />
                    <Stack.Screen name="ContextRequest" component={ContextRequestScreen} />
                    <Stack.Screen name="Summaries" component={SummariesScreen} />
                    <Stack.Screen name="AllSummaries" component={AllSummariesScreen} options={{ title: 'Summaries' }} />
                    <Stack.Screen name="Agent" component={DetailsScreen} />
                    <Stack.Screen name="Goal" component={GoalScreen} />
                    <Stack.Screen name="Archived" component={ArchivedScreen} />
                    <Stack.Screen name="Chats" component={ChatsScreen} options={{ title: 'Chats' }} />
                    <Stack.Screen name="ChatRoom" component={ChatRoomScreen} options={{ title: '' }} />
                    <Stack.Screen name="RemoteChat" component={RemoteChatScreen} options={{ title: '' }} />
                    <Stack.Screen name="ChatInfo" component={ChatInfoScreen} options={{ title: 'Details' }} />
                    <Stack.Screen name="Person" component={PersonScreen} />
                    <Stack.Screen name="File" component={FileScreen} />
                    <Stack.Group screenOptions={{ presentation: 'modal' }}>
                      <Stack.Screen name="New" component={NewAgentScreen} />
                      <Stack.Screen name="NewGroup" component={NewGroupScreen} />
                      <Stack.Screen name="AddToChat" component={AddToChatScreen} />
                      <Stack.Screen name="SelectText" component={SelectTextScreen} options={{ title: 'Select text' }} />
                      <Stack.Screen name="Settings" component={SettingsScreen} />
                      <Stack.Screen name="Invite" component={InviteScreen} />
                      <Stack.Screen name="Computers" component={ComputersScreen} />
                      <Stack.Screen name="Tailscale" component={TailscaleScreen} options={{ title: 'Tailscale' }} />
                      <Stack.Screen name="Servers" component={ServersScreen} options={{ title: 'Servers' }} />
                      <Stack.Screen name="NewServer" component={NewServerScreen} options={{ title: 'New server' }} />
                      <Stack.Screen name="NewServerDetails" component={NewServerDetailsScreen} options={{ title: 'New server' }} />
                      <Stack.Screen name="NewServerNetwork" component={NewServerNetworkScreen} options={{ title: 'New server' }} />
                      <Stack.Screen name="NewNetwork" component={NewNetworkScreen} options={{ title: 'Start a network' }} />
                      <Stack.Screen name="Claude" component={ClaudeScreen} options={{ title: 'Claude Code' }} />
                      <Stack.Screen name="ChatGPT" component={ChatGptScreen} options={{ title: 'ChatGPT' }} />
                      <Stack.Screen name="OpenRouter" component={OpenRouterScreen} options={{ title: 'OpenRouter' }} />
                      <Stack.Screen name="GitHub" component={GitHubScreen} options={{ title: 'GitHub' }} />
                      <Stack.Screen name="AWS" component={AwsScreen} options={{ title: 'AWS' }} />
                      <Stack.Screen name="Sprites" component={SpritesScreen} options={{ title: 'Sprites' }} />
                    </Stack.Group>
                  </Stack.Navigator>
                </NavigationContainer>
                </BannerHeightProvider>
              </SessionProvider>
            )}
            <ToastHost />
            <LockCover gate={lock} />
          </UpdateMarkProvider>
          </OtherServersUnreadProvider>
          </PushProvider>
          </UpdateFlowProvider>
          </HostedServersProvider>
        </CoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** A tapped notification, once its server is on screen: the Agents list with that conversation on top. */
function usePushOpenings(push: PushCenter, core: AppCore, navigationReadyFor: string | null) {
  useEffect(() => {
    const open = () => {
      const session = core.activeSession
      const opening = push.opening
      if (!session || !opening || opening.serverId !== session.serverId || navigationReadyFor !== session.serverId || !navigationRef.isReady()) return
      push.takeOpening()
      if (isShowingPushPlace(navigationRef.getCurrentRoute(), opening.place, session.store)) return
      navigationRef.reset({ index: 1, routes: [{ name: 'Agents' }, routeOfPushPlace(opening.place)] })
    }
    open()
    const unsubscribePush = push.subscribe(open)
    const unsubscribeCore = core.subscribe(open)
    return () => { unsubscribePush(); unsubscribeCore() }
  }, [push, core, navigationReadyFor])
}

/** Banners are drawn above the navigation, so the first of them clears the status bar itself. */
function BelowStatusBar({ updateBannerShown, children }: { updateBannerShown: boolean; children: ReactNode }) {
  const top = useSafeAreaInsets().top
  return <View style={{ padding: 12, paddingTop: 12 + (updateBannerShown ? 0 : top) }}>{children}</View>
}

/** The saved navigation, for the first navigator of the server it was saved on, and never again. */
function placeToReopen(saved: SavedPlaceState, serverId: string, used: { current: boolean }): InitialState | undefined {
  if (saved.stage !== 'read' || saved.place === null || used.current || saved.place.serverId !== serverId) return undefined
  used.current = true
  try {
    return JSON.parse(saved.place.navigationState) as InitialState
  } catch {
    return undefined
  }
}

function NavigationlessBackground({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: C.background }}>{children}</View>
}
