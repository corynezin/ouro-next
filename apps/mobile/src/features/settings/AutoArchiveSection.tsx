// Settings' auto-archive choice and reply reminders: the server's, so the owner's alone to change. Renders settings/model.ts.
import { useState } from 'react'
import { Picker, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { failureText } from '../../core/session/serverApi.ts'
import { Note } from '../../design/form.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import { autoArchiveKey, autoArchiveOptions, SETTINGS_COPY } from './model.ts'

export function AutoArchiveSection() {
  const session = useSession()
  const [failure, setFailure] = useState<string | null>(null)
  const afterHours = session.store.server?.limits.autoArchiveAfterHours ?? null
  const options = autoArchiveOptions(afterHours)

  const choose = async (key: string) => {
    const chosen = options.find((option) => option.key === key)
    if (!chosen || chosen.afterHours === afterHours) return
    setFailure(null)
    const saved = await session.command('set_auto_archive', { afterHours: chosen.afterHours })
    if (!saved.ok) setFailure(failureText(saved.failure))
  }

  return (
    <Section title="Archiving" footer={<Text>{SETTINGS_COPY.autoArchiveFooter}</Text>}>
      <Picker label="Archive finished agents" selection={autoArchiveKey(afterHours)} modifiers={[pickerStyle('menu')]}
        onSelectionChange={(key) => { void choose(String(key)) }}>
        {options.map((option) => <Text key={option.key} modifiers={[tag(option.key)]}>{option.label}</Text>)}
      </Picker>
      {failure !== null ? <Note text={failure} color="red" /> : null}
    </Section>
  )
}

export function ReplyRemindersSection() {
  const session = useSession()
  const [failure, setFailure] = useState<string | null>(null)
  const on = session.store.server?.limits.replyReminders ?? true

  const turn = async (next: boolean) => {
    setFailure(null)
    const saved = await session.command('set_reply_reminders', { on: next })
    if (!saved.ok) setFailure(failureText(saved.failure))
  }

  return (
    <Section title="Reply reminders" footer={<Text>{SETTINGS_COPY.replyRemindersFooter}</Text>}>
      <Toggle label="Remind agents to reply" isOn={on} onIsOnChange={(next) => { void turn(next) }} />
      {failure !== null ? <Note text={failure} color="red" /> : null}
    </Section>
  )
}
