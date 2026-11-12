// Settings → Claude Code: the sign-in on the server, a way to sign in again, and sharing the sign-in with the person's
// other computers. Renders model.ts.
import { useEffect, useLayoutEffect, useState } from 'react'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import type { ClaudeShareComputer } from '@ouro/contract'
import { HeaderButton, KV } from '../../design/form.tsx'
import { toast } from '../../design/Toast.tsx'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import { useCore, useCoreVersion, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { ConnectClaude, ShareClaude } from './ConnectClaude.tsx'
import { claudeButtonLabel, claudeStatusText, SHARE_COPY, shareComputerName, shareLineText, shareOutcome, shareToast } from './model.ts'
import { useIntegration } from './parts.tsx'

export function ClaudeScreen({ navigation }: ScreenProps<'Claude'>) {
  const session = useSession()
  useSessionVersion(session)
  const core = useCore()
  const coreVersion = useCoreVersion(core)
  const [savedServers, setSavedServers] = useState<SavedServer[]>([])
  useEffect(() => { core.servers.list().then(setSavedServers, () => {}) }, [core, coreVersion])
  const claude = useIntegration('claude')?.state ?? null
  // Only the owner shares a sign-in: the server refuses anyone else.
  const canShare = (session.store.viewer?.isOwner ?? false) && session.store.computers.size > 0
  const longLived = claude?.status === 'signed_in' && claude.account.method === 'plan' && claude.account.longLived === true
  const [connecting, setConnecting] = useState<'none' | 'sign_in' | 'share'>('none')
  const [sending, setSending] = useState(false)
  const [shared, setShared] = useState<ClaudeShareComputer[] | null>(null)
  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Claude Code', headerRight: () => <HeaderButton title="Done" onPress={() => navigation.goBack()} /> })
  }, [navigation])
  const nameOf = (name: string) => shareComputerName(name, session.store.computers.values(), savedServers)
  const showShared = (computers: ClaudeShareComputer[]) => {
    toast(shareToast(computers, nameOf))
    setShared(computers)
    setConnecting('none')
  }
  const sendAgain = async () => {
    setSending(true)
    const outcome = shareOutcome(await session.api.claudeShareAgain(), 'Claude Code here has no year-long token to send')
    setSending(false)
    if (outcome.kind === 'failed') return toast(outcome.text)
    showShared(outcome.computers)
  }
  if (connecting === 'sign_in') return <ConnectClaude onDone={() => { toast('Claude Code is signed in'); navigation.goBack() }} />
  if (connecting === 'share') return <ShareClaude onShared={showShared} />
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Claude Code" footer={<Text>Claude Code runs on your computer using your Claude plan or Anthropic API key.</Text>}>
          <KV k="Status" v={claudeStatusText(claude)} />
        </Section>
        {claude ? <Section><Button label={claudeButtonLabel(claude)} onPress={() => setConnecting('sign_in')} /></Section> : null}
        {claude && canShare ? (
          <Section title={SHARE_COPY.sectionTitle} footer={<Text>{SHARE_COPY.footer}</Text>}>
            <Button label={SHARE_COPY.start} onPress={() => setConnecting('share')} />
            {longLived ? <Button label={sending ? 'Sending…' : SHARE_COPY.again} onPress={() => { if (!sending) void sendAgain() }} /> : null}
            {(shared ?? []).map((computer) => <KV key={computer.name} k={nameOf(computer.name)} v={shareLineText(computer)} />)}
          </Section>
        ) : null}
      </Form>
    </Host>
  )
}
