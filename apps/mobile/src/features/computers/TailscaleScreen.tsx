// Settings → Integrations → Tailscale: puts this server on the person's Tailscale network, so its agents can reach their
// other devices there, and a Sprite can reach a computer linked with a command. Where computers need it (a Sprite) it is
// the way in; elsewhere (an EC2 instance) it is optional, and can be taken off whenever. Renders computers/model.ts.
import { useEffect, useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import type { TailscaleStatus } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { isTailscaleChanging, offersTailscaleRemove, TAILSCALE_COPY, TAILSCALE_POLL_MS, tailscaleConnectedFooter, tailscaleGateOf, tailscalePlacementOf } from './model.ts'

export function TailscaleScreen({ navigation }: ScreenProps<'Tailscale'>) {
  const session = useSession()
  useSessionVersion(session)
  const linkedComputers = session.store.computers.size
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ask = async (method: 'GET' | 'POST' | 'DELETE') => {
    const answered = await session.api.tailscale(method)
    if (answered.ok) setTailscale(answered.value)
    else setError(answered.failure.kind === 'refused' ? failureText(answered.failure) : TAILSCALE_COPY.requestFailed)
  }
  useEffect(() => { void ask('GET') }, [session])
  const changing = tailscale !== null && isTailscaleChanging(tailscale.tailscale)
  useEffect(() => {
    if (!changing) return undefined
    const timer = setInterval(() => { void ask('GET') }, TAILSCALE_POLL_MS)
    return () => clearInterval(timer)
  }, [session, changing])

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Tailscale', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const state = tailscale?.tailscale ?? null
  const gate = state === null ? null : tailscaleGateOf(state)
  const failure = tailscale?.lastFailure?.message ?? null
  const optional = tailscale !== null && tailscalePlacementOf(tailscale) === 'after_add'
  const remove = () => confirm(TAILSCALE_COPY.removeTitle, TAILSCALE_COPY.removeMessage, 'Remove', () => { void ask('DELETE') })

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {error ? <Section><Note text={error} /></Section> : null}
        {gate !== null ? (
          <Section
            title={optional ? TAILSCALE_COPY.optionalTitle : TAILSCALE_COPY.gateTitle}
            footer={<Text>{optional ? TAILSCALE_COPY.optionalFooter : TAILSCALE_COPY.gateFooter}</Text>}
          >
            {failure !== null ? <Note text={failure} /> : null}
            {gate.kind === 'connect' ? <Button label={TAILSCALE_COPY.connect} onPress={() => { void ask('POST') }} /> : null}
            {gate.kind === 'working' ? <Text>{gate.text}</Text> : null}
            {gate.kind === 'approve' ? <Button label={TAILSCALE_COPY.approve} onPress={() => { void Linking.openURL(gate.loginUrl) }} /> : null}
          </Section>
        ) : null}
        {state?.state === 'connected' ? (
          <Section title={TAILSCALE_COPY.connectedTitle} footer={<Text>{tailscaleConnectedFooter(state.ip)}</Text>}>
            {failure !== null ? <Note text={failure} /> : null}
            {tailscale !== null && offersTailscaleRemove(tailscale, linkedComputers)
              ? <Button label={TAILSCALE_COPY.remove} role="destructive" onPress={remove} /> : null}
          </Section>
        ) : null}
        {state?.state === 'not_needed' ? <Section><Text>{TAILSCALE_COPY.notNeeded}</Text></Section> : null}
      </Form>
    </Host>
  )
}
