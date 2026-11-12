// Start an agent that reports to you, here or on another of your computers. A sheet.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Button, Form, HStack, Host, Image, Picker, Section, Spacer, Text } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle, disabled, foregroundStyle, lineLimit, pickerStyle, tag, truncationMode } from '@expo/ui/swift-ui/modifiers'
import { Field, HeaderButton, Note, useBlurFields } from '../../design/form.tsx'
import { pickAttachments, type ComposerFile } from '../../design/composerFiles.ts'
import { attachOptions, type PickSource } from '../../design/composerText.ts'
import { formatSize } from '../../design/format.ts'
import { actionSheet } from '../../design/menus.tsx'
import { failureText } from '../../core/session/serverApi.ts'
import { uploadFailureText } from '../../core/session/outbox.ts'
import { useCore, useCoreVersion, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import { serverShortName } from '../settings/model.ts'
import type { ScreenProps } from '../../navigation/routes.ts'
import type { PromptCacheLifetime } from '@ouro/contract'
import { canStartAgent, FILES_COPY, hasPromptCache, machineFooter, machineOptions, modelGroups, newAgentInput, newRemoteAgentInput, PROMPT_CACHE_OPTIONS, typedAgentName, uploadFilesOnce } from './model.ts'

export function NewAgentScreen({ navigation }: ScreenProps<'New'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const server = session.store.server
  const [task, setTask] = useState('')
  const [name, setName] = useState('')
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const [machineKey, setMachineKey] = useState('here')
  const [promptCache, setPromptCache] = useState<PromptCacheLifetime>('5m')
  const [files, setFiles] = useState<ComposerFile[]>([])
  /** Each picked file's upload, by its local id: a Start tried again after a refusal doesn't upload it again. */
  const uploadedIds = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { field, blurFields } = useBlurFields()
  const model = chosenModel ?? server?.defaultModel ?? null
  const groups = useMemo(() => modelGroups(server?.models ?? [], model), [version, model])
  const core = useCore()
  const coreVersion = useCoreVersion(core)
  const [savedServers, setSavedServers] = useState<SavedServer[]>([])
  useEffect(() => { core.servers.list().then(setSavedServers, () => {}) }, [core, coreVersion])
  const hereLabel = serverShortName(savedServers, session.serverId, server?.machineName ?? null)
  const machines = useMemo(() => machineOptions(session.store.computers.values(), savedServers, hereLabel), [version, savedServers, hereLabel])
  const machine = machines.find((option) => option.key === machineKey) ?? null
  const remoteComputerId = machine?.computerId ?? null
  const cacheShown = hasPromptCache(server?.models ?? [], model)
  const cacheChoice = cacheShown ? promptCache : null

  const failed = (text: string) => {
    setBusy(false)
    setError(text)
  }
  const start = async () => {
    await blurFields()
    setBusy(true)
    setError(null)
    if (remoteComputerId !== null) {
      const made = await session.command('create_remote_agent', newRemoteAgentInput(remoteComputerId, task, name, chosenModel, cacheChoice))
      if (!made.ok) return failed(failureText(made.failure))
      navigation.goBack()
      navigation.navigate('RemoteChat', { remoteAgentId: made.value.remoteAgent.id })
      return
    }
    // Uploaded here, before the agent is made: a file that doesn't upload stops the start, and nothing is made.
    const uploaded = await uploadFilesOnce(files, uploadedIds.current, (file) => session.api.uploadAttachment(file))
    if (!uploaded.ok) return failed(uploadFailureText(uploaded.fileName, uploaded.failure))
    const made = await session.command('create_agent', newAgentInput(task, name, model, cacheChoice, uploaded.attachmentIds))
    if (!made.ok) return failed(failureText(made.failure))
    navigation.goBack()
    navigation.navigate('Chat', { agentRef: made.value.agent.id })
  }

  const add = async (source: PickSource) => {
    const picked = await pickAttachments(source)
    if (picked.kind === 'failed') setError(picked.reason)
    else if (picked.files.length) setFiles((f) => [...f, ...picked.files])
  }
  const attach = async () => {
    await blurFields()
    const hasImage = await Clipboard.hasImageAsync().catch(() => false)
    actionSheet(undefined, attachOptions(hasImage).map(({ source, title }) => ({ title, onPress: () => { void add(source) } })))
  }

  const remote = remoteComputerId !== null
  const canStart = canStartAgent(task, busy, { count: files.length, toAnotherComputer: remote })
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'New agent',
      headerLeft: () => <HeaderButton title="Cancel" onPress={() => { void blurFields().then(() => navigation.goBack()) }} />,
      headerRight: () => <HeaderButton title={busy ? 'Starting…' : 'Start'} bold disabled={!canStart} onPress={() => { void start() }} />,
    })
  })

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section>
          <Field ref={field} multiline placeholder="task" value={task} onChange={setTask} />
          {/* Trimmed when sent, not while typed: rewriting a focused field's text is another change under the cursor. */}
          <Field ref={field} plain placeholder="name (optional — auto-generated if blank)" value={name} onChange={(typed) => setName(typedAgentName(typed))} />
        </Section>
        <Section footer={remote && files.length ? <Text>{FILES_COPY.remoteRefused}</Text> : undefined}>
          {files.map((file) => (
            <HStack key={file.localId} spacing={10}>
              <Image systemName={file.isImage ? 'photo' : 'doc'} modifiers={[foregroundStyle('secondary')]} />
              <Text modifiers={[lineLimit(1), truncationMode('middle')]}>{file.fileName}</Text>
              <Spacer />
              {file.byteLength > 0 ? <Text modifiers={[foregroundStyle('secondary')]}>{formatSize(file.byteLength)}</Text> : null}
              <Button modifiers={[buttonStyle('borderless'), disabled(busy), accessibilityLabel(`Remove ${file.fileName}`)]}
                onPress={() => setFiles((f) => f.filter((x) => x.localId !== file.localId))}>
                <Image systemName="xmark.circle.fill" modifiers={[foregroundStyle('secondary')]} />
              </Button>
            </HStack>
          ))}
          {/* Not while starting: the files being uploaded are the ones picked when Start was tapped. */}
          <Button label={FILES_COPY.add} systemImage="paperclip" modifiers={[disabled(busy)]} onPress={() => { void attach() }} />
        </Section>
        <Section>
          <Picker label="Model" selection={model ?? ''} modifiers={[pickerStyle('menu')]} onSelectionChange={(value) => setChosenModel(String(value))}>
            {groups.map((group) => (
              <Section key={group.title} title={group.title}>
                {group.models.map((option) => <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>)}
              </Section>
            ))}
          </Picker>
          {cacheShown ? (
            <Picker label="Prompt cache" selection={promptCache} modifiers={[pickerStyle('menu')]}
              onSelectionChange={(value) => setPromptCache(PROMPT_CACHE_OPTIONS.find((option) => option.lifetime === value)?.lifetime ?? '5m')}>
              {PROMPT_CACHE_OPTIONS.map((option) => <Text key={option.lifetime} modifiers={[tag(option.lifetime)]}>{option.label}</Text>)}
            </Picker>
          ) : null}
        </Section>
        {machines.length ? (
          <Section footer={remoteComputerId !== null && machine ? <Text>{machineFooter(machine.label)}</Text> : undefined}>
            <Picker label="Machine" selection={machine?.key ?? 'here'} modifiers={[pickerStyle('menu')]} onSelectionChange={(value) => setMachineKey(String(value))}>
              {machines.map((option) => <Text key={option.key} modifiers={[tag(option.key)]}>{option.label}</Text>)}
            </Picker>
          </Section>
        ) : null}
        {error ? <Section><Note text={error} color="red" /></Section> : null}
      </Form>
    </Host>
  )
}
