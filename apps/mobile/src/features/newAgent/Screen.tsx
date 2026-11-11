// Start an agent that reports to you, here or on another of your computers. A sheet.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Form, Host, Picker, Section, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { Field, HeaderButton, Note, useBlurFields } from '../../design/form.tsx'
import { failureText } from '../../core/session/serverApi.ts'
import { useCore, useCoreVersion, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { SavedServer } from '../../core/accounts/savedServers.ts'
import { serverShortName } from '../settings/model.ts'
import type { ScreenProps } from '../../navigation/routes.ts'
import type { PromptCacheLifetime } from '@ouro/contract'
import { canStartAgent, hasPromptCache, machineFooter, machineOptions, modelGroups, newAgentInput, newRemoteAgentInput, PROMPT_CACHE_OPTIONS, typedAgentName } from './model.ts'

export function NewAgentScreen({ navigation }: ScreenProps<'New'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const server = session.store.server
  const [task, setTask] = useState('')
  const [name, setName] = useState('')
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const [machineKey, setMachineKey] = useState('here')
  const [promptCache, setPromptCache] = useState<PromptCacheLifetime>('5m')
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
    const made = await session.command('create_agent', newAgentInput(task, name, model, cacheChoice))
    if (!made.ok) return failed(failureText(made.failure))
    navigation.goBack()
    navigation.navigate('Chat', { agentRef: made.value.agent.id })
  }

  const canStart = canStartAgent(task, busy)
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
