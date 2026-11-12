// Settings → Sprites: give the server a Sprites API token, so it can make new servers as Sprites (Servers → New server).
// Not a synced entity, like AWS: the screen asks the server each time it opens. Renders model.ts.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import type { SpritesIntegrationState } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { CHECKING_TEXT, SPRITES_TOKENS_PAGE, spritesOutcome, spritesTokenOf } from './model.ts'
import { SecretField } from './parts.tsx'

export function SpritesScreen({ navigation }: ScreenProps<'Sprites'>) {
  const { api } = useSession()
  const [sprites, setSprites] = useState<SpritesIntegrationState | null>(null)
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await api.spritesStatus()
    if (!result.ok) return setError(failureText(result.failure))
    setError(null)
    setSprites(result.value)
  }, [api])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    const typed = spritesTokenOf(token)
    if (typed === null) return setError('Paste a Sprites API token.')
    setBusy(true); setError(null)
    const outcome = spritesOutcome(await api.spritesSetToken(typed), 'Sprites did not accept that token.')
    setBusy(false)
    if (outcome.kind === 'failed') return setError(outcome.text)
    setSprites(outcome.state)
    setToken('')
    setConnecting(false)
    toast('Connected to Sprites')
  }
  const disconnect = () => {
    confirm('Disconnect Sprites?', 'The token is removed from this server, so it can no longer make Sprites. Sprites it made keep running. The token stays valid until you delete it on Fly.io.', 'Disconnect', () => {
      void api.spritesDisconnect().then((result) => {
        const outcome = spritesOutcome(result, 'Could not disconnect.')
        if (outcome.kind === 'failed') return setError(outcome.text)
        setSprites(outcome.state)
        toast('Sprites disconnected.')
      })
    })
  }

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Sprites', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const connected = sprites?.status === 'connected' ? sprites : null
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {connected ? (
          <Section title="Connected" footer={<Text>This server makes new servers as Sprites with this token: Settings → Servers → New server.</Text>}>
            <KV k="Token" v={connected.token} mono />
            {connected.problem !== null ? <Note text={connected.problem} /> : null}
          </Section>
        ) : null}
        {error !== null ? <Section><Note text={error} /></Section> : null}
        {!sprites && error === null ? <Section title="Sprites"><KV k="Status" v={CHECKING_TEXT} /></Section> : null}
        {!sprites && error !== null ? <Section><Button label="Try again" onPress={() => { void load() }} /></Section> : null}
        {sprites?.status === 'not_connected' && !connecting ? (
          <Section title="Sprites" footer={<Text>Give Ouro a Sprites API token so it can make new servers as Sprites. The server stores the token and never shares it with your phone.</Text>}>
            <Button label="Connect Sprites" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {connected && !connecting ? (
          <Section>
            <Button label="Replace this token" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {sprites && connecting ? (
          <Section title="Connect Sprites" footer={<Text>Sign in to Fly.io, open Sprites → Tokens in your dashboard, create a token, then copy it and paste it here. Sprites checks the token before Ouro saves it.</Text>}>
            <Button label="Open Fly.io" onPress={() => { void Linking.openURL(SPRITES_TOKENS_PAGE) }} />
            <SecretField placeholder="Sprites API token" value={token} onChange={setToken} onSubmit={() => { void send() }} />
            <Button label={busy ? 'Connecting…' : 'Connect'} onPress={() => { void send() }} />
          </Section>
        ) : null}
        {connected ? <Section><Button label="Disconnect Sprites" role="destructive" onPress={disconnect} /></Section> : null}
      </Form>
    </Host>
  )
}
