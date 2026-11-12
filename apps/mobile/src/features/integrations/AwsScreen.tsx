// Settings → AWS: give the server an IAM user's access key so agents can use the AWS CLI and SDKs, as its default
// profile. Not a synced entity (see the contract), so the screen asks the server each time it opens. Renders model.ts.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Linking } from 'react-native'
import { Button, Form, Host, Section, Text } from '@expo/ui/swift-ui'
import { font, foregroundStyle } from '@expo/ui/swift-ui/modifiers'
import type { AwsIntegrationState } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { HeaderButton, KV, Note } from '../../design/form.tsx'
import { confirm } from '../../design/menus.tsx'
import { toast } from '../../design/Toast.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { AWS_DEFAULT_REGION, AWS_IAM_USERS_PAGE, awsCredentialsOf, awsIdentityText, awsName, awsOutcome, CHECKING_TEXT } from './model.ts'
import { PlainKeyField, SecretField } from './parts.tsx'

const Label = ({ text }: { text: string }) => <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{text}</Text>

export function AwsScreen({ navigation }: ScreenProps<'AWS'>) {
  const session = useSession()
  const { api } = session
  // Disconnecting removes the machine's default AWS key, which the owner may have put there by hand: it is theirs alone.
  const isOwner = session.store.viewer?.isOwner ?? false
  const [aws, setAws] = useState<AwsIntegrationState | null>(null)
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [region, setRegion] = useState(AWS_DEFAULT_REGION)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await api.awsStatus()
    if (!result.ok) return setError(failureText(result.failure))
    setError(null)
    setAws(result.value)
    if (result.value.status === 'connected' && result.value.region) setRegion(result.value.region)
  }, [api])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    if (busy) return
    const credentials = awsCredentialsOf(accessKeyId, secretAccessKey, region)
    if (credentials === null) return setError('Fill in the access key ID, the secret access key, and the region.')
    setBusy(true); setError(null)
    const outcome = awsOutcome(await api.awsSetCredentials(credentials), 'AWS did not accept that key.')
    setBusy(false)
    if (outcome.kind === 'failed') return setError(outcome.text)
    setAws(outcome.state)
    setAccessKeyId(''); setSecretAccessKey('')
    setConnecting(false)
    toast(`Connected to ${awsName(outcome.state)}`)
  }
  const disconnect = () => {
    const name = aws ? awsName(aws) : 'AWS'
    confirm(`Disconnect ${name}?`, "The key is removed from this server's default AWS profile. Agents will no longer be able to use AWS. The key itself stays valid until you delete it in AWS.", 'Disconnect', () => {
      void api.awsDisconnect().then((result) => {
        const outcome = awsOutcome(result, 'Could not disconnect.')
        if (outcome.kind === 'failed') return setError(outcome.text)
        setAws(outcome.state)
        toast(`${name} disconnected.`)
      })
    })
  }

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'AWS', headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} /> })
  }, [navigation])

  const connected = aws?.status === 'connected' ? aws : null
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        {connected ? (
          <Section title="Connected" footer={<Text>Agents use this key through the AWS CLI and SDKs, as the default profile on your server. What they may do is what its IAM policy allows.</Text>}>
            <KV k="Account" v={connected.accountId} mono />
            <KV k="Identity" v={awsIdentityText(connected.arn)} />
            <KV k="Access key" v={connected.accessKeyId} mono />
            <KV k="Region" v={connected.region} mono />
            {connected.problem !== null ? <Note text={connected.problem} /> : null}
          </Section>
        ) : null}
        {error !== null ? <Section><Note text={error} /></Section> : null}
        {!aws && error === null ? <Section title="AWS"><KV k="Status" v={CHECKING_TEXT} /></Section> : null}
        {!aws && error !== null ? <Section><Button label="Try again" onPress={() => { void load() }} /></Section> : null}
        {aws?.status === 'not_connected' && !connecting ? (
          <Section title="AWS" footer={<Text>Give Ouro an AWS access key so agents can run the AWS CLI, for example to start EC2 machines. Use an IAM user made for Ouro, with only the permissions agents need. The server stores the key and never shares it with your phone.</Text>}>
            <Button label="Connect AWS" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {connected && !connecting ? (
          <Section>
            <Button label="Replace this key" onPress={() => setConnecting(true)} />
          </Section>
        ) : null}
        {aws && connecting ? (
          <Section title="Connect AWS" footer={<Text>In the AWS console, open IAM, make a user for Ouro (for example with AmazonEC2FullAccess), then under Security credentials create an access key for "Command Line Interface". Paste its ID and secret here. AWS checks the key before Ouro saves it.</Text>}>
            <Button label="Open IAM in the AWS console" onPress={() => { void Linking.openURL(AWS_IAM_USERS_PAGE) }} />
            <Label text="Access key ID" />
            <PlainKeyField placeholder="AKIA…" value={accessKeyId} onChange={setAccessKeyId} onSubmit={() => { void send() }} />
            <Label text="Secret access key" />
            <SecretField placeholder="Secret access key" value={secretAccessKey} onChange={setSecretAccessKey} onSubmit={() => { void send() }} />
            <Label text="Default region" />
            <PlainKeyField placeholder={AWS_DEFAULT_REGION} value={region} onChange={setRegion} onSubmit={() => { void send() }} />
            <Button label={busy ? 'Connecting…' : 'Connect'} onPress={() => { void send() }} />
          </Section>
        ) : null}
        {connected && isOwner ? <Section><Button label={`Disconnect ${awsName(connected)}`} role="destructive" onPress={disconnect} /></Section> : null}
      </Form>
    </Host>
  )
}
