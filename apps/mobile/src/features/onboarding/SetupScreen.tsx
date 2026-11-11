// The hub makes a server, then this phone pairs itself with it: no code shown. Full screen on first run, for the server
// made at sign-up; inside Servers for one made there. Renders onboarding/model.ts over core/hub/setupFlow.ts.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { HostedServer } from '@ouro/contract'
import type { HostedAccount } from '../../core/accounts/hostedAccount.ts'
import { firstServerSetup, hostedServerSetup, machineServerSetup } from '../../core/hub/hostedSetup.ts'
import type { HubResult } from '../../core/hub/hubApi.ts'
import type { SetupFlow } from '../../core/hub/setupFlow.ts'
import { C } from '../../design/colors.ts'
import { Page, pageStyles as s, Primary, Secondary } from '../../design/onboardingPage.tsx'
import { accent } from '../../design/theme.ts'
import { useCore, useHub, useNow } from '../../navigation/coreContext.tsx'
import { elapsedText, SETUP_SCREEN_COPY, setupProgress } from './model.ts'

/** Runs a flow while the screen is shown; Try again restarts it. */
function useSetupFlow(create: (onChange: () => void) => SetupFlow) {
  const [watched] = useState(() => {
    let notify = () => {}
    const flow = create(() => notify())
    return { flow, subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {} } } }
  })
  const state = useSyncExternalStore(watched.subscribe, () => watched.flow.state)
  useEffect(() => {
    watched.flow.start()
    return () => watched.flow.stop()
  }, [watched])
  return { flow: watched.flow, state }
}

function SetupContent({ flow, title, inline, failureMessage, tryAgain, failureActions, progressActions }: {
  flow: { flow: SetupFlow; state: SetupFlow['state'] }
  title: string
  inline: boolean
  /** Overrides the flow's own message, for a failure of the screen's own actions. */
  failureMessage: string | null
  tryAgain: () => void
  failureActions: ReactNode
  progressActions: ReactNode
}) {
  const [startedAt] = useState(() => Date.now())
  const now = useNow(1000)
  const { state } = flow
  const progress = setupProgress(state)
  if (state.stage === 'failed' || progress === null) {
    return (
      <>
        <Text style={inline ? s.titleInline : s.title}>{SETUP_SCREEN_COPY.failedTitle}</Text>
        <Text style={s.body}>{failureMessage ?? (state.stage === 'failed' ? state.message : '')}</Text>
        <Primary title="Try again" onPress={tryAgain} />
        {failureActions}
      </>
    )
  }
  return (
    <>
      <Text style={inline ? s.titleInline : s.title}>{title}</Text>
      <Text style={s.body}>{SETUP_SCREEN_COPY.body}</Text>
      <View style={bar.track}><View style={[bar.fill, { width: `${Math.round(progress.fraction * 100)}%` }]} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <ActivityIndicator />
        <Text style={[s.body, { flex: 1 }]}>{progress.text}…</Text>
        <Text style={s.small}>{elapsedText(now - startedAt)}</Text>
      </View>
      {progressActions}
    </>
  )
}

/** First run: the only way back is to start over with another invite. */
export function SetupScreen({ account }: { account: HostedAccount }) {
  const core = useCore()
  const hub = useHub()
  const flow = useSetupFlow((onChange) => firstServerSetup(core, hub, account, onChange))
  const [resetFailed, setResetFailed] = useState(false)
  const startOver = async () => {
    setResetFailed(false)
    await core.signOut().catch(() => setResetFailed(true))
  }
  return (
    <Page>
      <SetupContent flow={flow} title={SETUP_SCREEN_COPY.title(account.name)} inline={false}
        failureMessage={resetFailed ? SETUP_SCREEN_COPY.resetFailed : null}
        tryAgain={() => { setResetFailed(false); flow.flow.start() }}
        failureActions={<Secondary title="Start over" onPress={() => { void startOver() }} />}
        progressActions={null} />
    </Page>
  )
}

/** Inside Servers. Leaving stops watching; the hub carries on, and the server stays listed there to come back to. */
export function HostedServerSetupView({ account, server, onLeave }: { account: HostedAccount; server: { id: string; label: string }; onLeave: () => void }) {
  const core = useCore()
  const hub = useHub()
  const flow = useSetupFlow((onChange) => hostedServerSetup(core, hub, account, server.id, onChange))
  const leave = <Secondary title="Leave" onPress={onLeave} />
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: C.background }}>
      <SetupContent flow={flow} title={SETUP_SCREEN_COPY.serverTitle(server.label)} inline failureMessage={null}
        tryAgain={() => flow.flow.start()} failureActions={leave} progressActions={leave} />
    </View>
  )
}

/** Inside Servers, for a server the open one makes on a cloud account. Leaving stops watching; the open server carries on. */
export function MachineSetupView({ label, read, onLeave }: { label: string; read: () => Promise<HubResult<HostedServer>>; onLeave: () => void }) {
  const core = useCore()
  const flow = useSetupFlow((onChange) => machineServerSetup(core, read, onChange))
  const leave = <Secondary title="Leave" onPress={onLeave} />
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: C.background }}>
      <SetupContent flow={flow} title={SETUP_SCREEN_COPY.serverTitle(label)} inline failureMessage={null}
        tryAgain={() => flow.flow.start()} failureActions={leave} progressActions={leave} />
    </View>
  )
}

const bar = StyleSheet.create({
  track: { height: 6, borderRadius: 3, backgroundColor: C.fill, overflow: 'hidden', marginVertical: 8 },
  fill: { height: 6, borderRadius: 3, backgroundColor: accent },
})
