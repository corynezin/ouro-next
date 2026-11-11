// Settings → Computers: the person's other computers, how far each is trusted, adding one with a one-time command, and
// removing one. On a Sprite, Tailscale comes first: it is how that server reaches the computers. A server with its own
// public address (an EC2 instance) can connect Tailscale too, but adding a computer doesn't wait for it. The list comes
// from sync, so a computer that joins or goes offline shows here by itself. Renders computers/model.ts.
import { useEffect, useLayoutEffect, useState } from 'react'
import { Linking, Share } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, Host, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { font, foregroundStyle, textSelection } from '@expo/ui/swift-ui/modifiers'
import type { ComputerInvite, TailscaleStatus } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import {
  computerRows, COMPUTERS_COPY, inviteFooter, isTailscaleChanging, removeConfirm, someOffline, TAILSCALE_COPY, TAILSCALE_POLL_MS, tailscaleBlocksComputers,
  tailscaleConnectedFooter, tailscaleGateOf,
} from './model.ts'
import type { ComputerRow } from './model.ts'

export function ComputersScreen({ navigation }: ScreenProps<'Computers'>) {
  const session = useSession()
  useSessionVersion(session)
  const computers = session.store.computers
  const rows = computerRows(computers.values())
  const [invite, setInvite] = useState<ComputerInvite | null>(null)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)

  const askTailscale = async (method: 'GET' | 'POST' | 'DELETE') => {
    const answered = await session.api.tailscale(method)
    if (answered.ok) setTailscale(answered.value)
    else setError(answered.failure.kind === 'refused' ? failureText(answered.failure) : TAILSCALE_COPY.requestFailed)
  }
  useEffect(() => { void askTailscale('GET') }, [session])
  const changing = tailscale !== null && isTailscaleChanging(tailscale.tailscale)
  useEffect(() => {
    if (!changing) return undefined
    const timer = setInterval(() => { void askTailscale('GET') }, TAILSCALE_POLL_MS)
    return () => clearInterval(timer)
  }, [session, changing])
  // Unknown until the first answer: neither the Tailscale section nor an invite shows yet.
  const gate = tailscale === null ? null : tailscaleGateOf(tailscale.tailscale)
  const canAdd = tailscale !== null && !tailscaleBlocksComputers(tailscale)
  // Where Tailscale is optional, connecting it comes after adding a computer rather than before.
  const optional = tailscale?.neededForComputers === false
  const tailscaleFailure = tailscale?.lastFailure?.message ?? null
  const removeTailscale = () => confirm(TAILSCALE_COPY.removeTitle, TAILSCALE_COPY.removeMessage, 'Remove', () => { void askTailscale('DELETE') })

  const tailscaleGate = gate === null ? null : (
    <Section
      title={optional ? TAILSCALE_COPY.optionalTitle : TAILSCALE_COPY.gateTitle}
      footer={<Text>{optional ? TAILSCALE_COPY.optionalFooter : TAILSCALE_COPY.gateFooter}</Text>}
    >
      {tailscaleFailure !== null ? <Note text={tailscaleFailure} /> : null}
      {gate.kind === 'connect' ? <Button label={TAILSCALE_COPY.connect} onPress={() => { void askTailscale('POST') }} /> : null}
      {gate.kind === 'working' ? <Text>{gate.text}</Text> : null}
      {gate.kind === 'approve' ? <Button label={TAILSCALE_COPY.approve} onPress={() => { void Linking.openURL(gate.loginUrl) }} /> : null}
    </Section>
  )

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Computers', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const add = async () => {
    setMaking(true)
    const made = await session.command('create_computer_invite', {})
    setMaking(false)
    if (made.ok) {
      setInvite(made.value)
      setError(null)
    } else setError(made.failure.kind === 'refused' ? failureText(made.failure) : COMPUTERS_COPY.inviteFailed)
  }

  const setTrust = async (row: ComputerRow, full: boolean) => {
    const set = await session.command('set_computer_trust', { computerId: row.id, trust: full ? 'full' : 'limited' })
    if (!set.ok) setError(failureText(set.failure))
  }

  const remove = (row: ComputerRow) => {
    const computer = computers.get(row.id)
    if (!computer) return
    const { title, message } = removeConfirm(computer)
    confirm(title, message, 'Remove', async () => {
      const removed = await session.command('remove_computer', { computerId: row.id })
      if (removed.ok) toast(`${row.name} removed`)
      else setError(removed.failure.kind === 'refused' ? failureText(removed.failure) : COMPUTERS_COPY.removeFailed)
    })
  }

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {rows.length ? (
          <Section title={COMPUTERS_COPY.listTitle} footer={<Text>{COMPUTERS_COPY.listFooter}</Text>}>
            {rows.map((row) => <KV key={row.id} k={row.name} v={row.stateText} />)}
            {rows.flatMap((row) => row.incompatibility ? [<Note key={`${row.id}-incompatible`} text={`${row.name}: ${row.incompatibility}`} />] : [])}
          </Section>
        ) : null}
        {error ? <Section><Note text={error} /></Section> : null}
        {optional ? null : tailscaleGate}
        {!canAdd ? null : invite ? (
          <Section title={COMPUTERS_COPY.inviteTitle} footer={<Text>{inviteFooter(invite.expiresAt, Date.now())}</Text>}>
            <Text modifiers={[font({ design: 'monospaced', textStyle: 'footnote' }), textSelection(true)]}>{invite.command}</Text>
            <Button label="Copy" onPress={async () => { await Clipboard.setStringAsync(invite.command); toast('Copied') }} />
            <Button label="Share" onPress={() => { Share.share({ message: invite.command }).catch(() => {}) }} />
            <Button label="I've run it" onPress={() => setInvite(null)} />
          </Section>
        ) : (
          <Section title={COMPUTERS_COPY.addTitle} footer={<Text>{COMPUTERS_COPY.addFooter}</Text>}>
            <Button label={making ? COMPUTERS_COPY.making : COMPUTERS_COPY.addTitle} onPress={making ? () => {} : () => { void add() }} />
          </Section>
        )}
        {optional ? tailscaleGate : null}
        {rows.length ? (
          <Section title={COMPUTERS_COPY.trustTitle} footer={<Text>{COMPUTERS_COPY.trustFooter}</Text>}>
            {rows.map((row) => <Toggle key={row.id} label={row.name} isOn={row.trust === 'full'} onIsOnChange={(on) => { void setTrust(row, on) }} />)}
          </Section>
        ) : null}
        {rows.length ? (
          <Section title="Remove">
            {rows.map((row) => <Button key={row.id} label={`Remove ${row.name}`} role="destructive" onPress={() => remove(row)} />)}
          </Section>
        ) : null}
        {tailscale?.tailscale.state === 'connected' && (optional || !rows.length) ? (
          <Section title={TAILSCALE_COPY.connectedTitle} footer={<Text>{tailscaleConnectedFooter(tailscale.tailscale.ip)}</Text>}>
            {tailscaleFailure !== null ? <Note text={tailscaleFailure} /> : null}
            <Button label={TAILSCALE_COPY.remove} role="destructive" onPress={removeTailscale} />
          </Section>
        ) : null}
        {someOffline(computers.values())
          ? <Section><Text modifiers={[foregroundStyle('secondary')]}>{COMPUTERS_COPY.offlineNote}</Text></Section> : null}
      </Form>
    </Host>
  )
}
