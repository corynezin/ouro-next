// Settings → GitHub: give the server a GitHub token so agents can push, open pull requests and read repositories.
// Renders model.ts.
import { useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { font, foregroundStyle } from '@expo/ui/swift-ui/modifiers'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { failureText } from '../../core/session/serverApi.ts'
import { backupSection, BACKUP_MADE_TOAST } from '../settings/model.ts'
import { useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { actionOutcome, CHECKING_TEXT, GITHUB_TOKEN_PAGE, gitHubConnectedToast, gitHubMissingScopesNote, gitHubName, pasted } from './model.ts'
import { SecretField, useIntegration } from './parts.tsx'

export function GitHubScreen({ navigation }: ScreenProps<'GitHub'>) {
  const session = useSession()
  useSessionVersion(session)
  const { api } = session
  const github = useIntegration('github')?.state ?? null
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [makingCopy, setMakingCopy] = useState(false)

  const sendToken = async (text = token) => {
    const value = pasted(text)
    if (value === null) return
    setBusy(true); setError(null)
    const outcome = actionOutcome(await api.githubSetToken(value), 'GitHub did not accept that token.')
    setBusy(false)
    if (outcome.kind === 'failed') return setError(outcome.text)
    setToken('')
    setConnecting(false)
    if (outcome.integration.provider === 'github') toast(gitHubConnectedToast(outcome.integration.state))
  }
  const disconnect = () => {
    const name = github ? gitHubName(github) : 'GitHub'
    confirm(`Disconnect ${name}?`, 'Agents will no longer be able to push code, open PRs, or read repos on your behalf.', 'Disconnect', () => {
      void api.githubDisconnect().then((result) => {
        const outcome = actionOutcome(result, 'Could not disconnect.')
        if (outcome.kind === 'failed') return setError(outcome.text)
        toast(`${name} disconnected.`)
      })
    })
  }

  const makePrivateCopy = async () => {
    setMakingCopy(true); setError(null)
    const made = await session.command('create_source_backup', {})
    setMakingCopy(false)
    if (made.ok) toast(BACKUP_MADE_TOAST)
    else setError(failureText(made.failure))
  }

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'GitHub', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const backup = session.store.server ? backupSection(session.store.server.sourceBackup, session.store.viewer?.isOwner ?? false) : null
  const missingScopes = github ? gitHubMissingScopesNote(github) : null
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {github?.status === 'connected' ? (
          <Section title="Connected">
            <KV k="Account" v={github.user} />
            <KV k="Scopes" v={github.scopes.join(', ')} />
            {missingScopes !== null ? <Note text={missingScopes} /> : null}
          </Section>
        ) : null}
        {github?.status === 'connected' && backup?.action?.kind === 'make_private_copy' ? (
          <Section title="Back up your changes" footer={<Text>{backup.detail}</Text>}>
            <Note text={backup.warning} color="orange" />
            <Button label={makingCopy ? 'Making a private copy…' : backup.action.label} onPress={() => { void makePrivateCopy() }} />
          </Section>
        ) : null}
        {error !== null ? <Section><Note text={error} /></Section> : null}
        {!github ? <Section title="GitHub"><KV k="Status" v={CHECKING_TEXT} /></Section> : null}
        {github?.status === 'connected' && !connecting ? (
          <Section footer={<Text>A classic personal access token with repo, workflow, read:org, and gist scopes. Create a new one and replace this token.</Text>}>
            <Button label="Replace this token" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {github && connecting ? (
          <Section title="Connect GitHub" footer={<Text>Create a classic personal access token on GitHub with repo, workflow, read:org, and gist scopes, then paste it here. Ouro stores it only on your server.</Text>}>
            <Button label="Open GitHub to create a token" onPress={() => { void Linking.openURL(GITHUB_TOKEN_PAGE) }} />
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>Personal access token</Text>
            <SecretField placeholder="ghp_… or github_pat_…" value={token} onChange={setToken} onSubmit={() => { void sendToken() }} />
            <Button label="Paste from clipboard" onPress={() => { void Clipboard.getStringAsync().then((text) => { setToken(text.trim()); void sendToken(text) }) }} />
            <Button label={busy ? 'Connecting…' : 'Connect'} onPress={() => { void sendToken() }} />
          </Section>
        ) : null}
        {github?.status === 'not_connected' && !connecting ? (
          <Section title="GitHub" footer={<Text>Give Ouro access to GitHub so agents can push code, open pull requests, read repositories, and more. The server stores your token and never shares it with your phone.</Text>}>
            <Button label="Connect GitHub" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {github?.status === 'connected' ? <Section><Button label={`Disconnect ${gitHubName(github)}`} role="destructive" onPress={disconnect} /></Section> : null}
      </Form>
    </Host>
  )
}
