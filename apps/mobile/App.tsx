import * as LocalAuthentication from 'expo-local-authentication'
import { LogBox } from 'react-native'
import { AppCore } from './src/core/appCore.ts'
import { HubApi } from './src/core/hub/hubApi.ts'
import { HostedServers } from './src/core/hub/hostedServers.ts'
import { checkManifest, updateEndpointOf } from './src/core/updates/manifest.ts'
import { LockGate } from './src/core/lock/lockGate.ts'
import { UpdateFlow } from './src/core/updates/updateFlow.ts'
import * as Updates from 'expo-updates'
import { AppRoot } from './src/navigation/AppRoot.tsx'
import { navigationRef } from './src/navigation/navigationRef.ts'
import { nativeDeps } from './src/native/adapters.ts'
import { HUB_URL } from './src/native/hubAddress.ts'
import { nativeUpdateSource } from './src/native/updates.ts'
import { PushCenter } from './src/core/push/pushCenter.ts'
import { OtherServersUnread } from './src/core/servers/otherServersUnread.ts'
import { agentUnreadTotal } from './src/features/shared/agentFacts.ts'
import { connectNativePush, nativePushPlatform } from './src/native/push.ts'

// Development warnings would cover the composer; errors still show.
LogBox.ignoreAllLogs()

const core = new AppCore(nativeDeps)
const hostedServers = new HostedServers(new HubApi(nativeDeps, HUB_URL), nativeDeps.clock)
const updates = new UpdateFlow({
  source: nativeUpdateSource,
  clock: nativeDeps.clock,
  lifecycle: nativeDeps.lifecycle,
  store: nativeDeps.durableStore,
  checkManifest: (endpoint) => checkManifest(nativeDeps.network, endpoint, { runtimeVersion: Updates.runtimeVersion ?? '', platform: 'ios' }),
  currentPlace: () => {
    const session = core.activeSession
    if (!session || !navigationRef.isReady()) return null
    return { serverId: session.serverId, navigationState: JSON.stringify(navigationRef.getRootState()) }
  },
})

// Updates follow the home server, whatever server is on screen.
const followUpdateHome = () => { void core.updateHome().then((home) => updates.setHome(home ? updateEndpointOf(home.url) : null)) }
core.subscribe(followUpdateHome)
core.preferences.subscribe(followUpdateHome)
followUpdateHome()

const lock = new LockGate({
  lifecycle: nativeDeps.lifecycle,
  required: () => core.preferences.current.requireFaceId,
  authenticate: async () => (await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Ouro' })).success,
})

const push = new PushCenter({
  core,
  platform: nativePushPlatform,
  badgeCountOf: agentUnreadTotal,
  checkForUpdate: () => { void updates.checkNow() },
})
push.start()
connectNativePush(push)

const otherServersUnread = new OtherServersUnread({ core, unreadOf: agentUnreadTotal })
otherServersUnread.start()

export default function App() {
  return <AppRoot core={core} hostedServers={hostedServers} updates={updates} lock={lock} push={push} otherServersUnread={otherServersUnread} />
}
