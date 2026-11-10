// Settings' notification sections: allow on this phone, what to notify about, quiet hours and muted agents. The settings
// are the person's, synced across their phones; each change saves them all. Renders settings/model.ts.
import { useState } from 'react'
import { Button, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { NotificationSettings } from '@ouro/contract'
import { allowOutcomeText } from '../../core/push/pushCenter.ts'
import { Note } from '../../design/form.tsx'
import { usePush, useSession } from '../../navigation/coreContext.tsx'
import { listedAgents } from '../shared/agentFacts.ts'
import { changedNotificationSettings, NOTIFICATIONS_COPY, notificationSettingsOf, NOTIFY_MODE_OPTIONS, QUIET_HOURS_TIMES } from './model.ts'
import type { NotificationChange } from './model.ts'

const phoneTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function NotificationSections() {
  const push = usePush()
  const session = useSession()
  const stored = session.store.notificationSettings
  // Shown from the tap until the server's answer, so quick changes build on each other instead of on the stored ones.
  const [saving, setSaving] = useState<NotificationSettings | null>(null)
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const settings = saving ?? (stored ? notificationSettingsOf(stored) : null)

  const allow = async () => {
    setNote(null)
    const outcome = await push.allowOnThisPhone()
    setNote({ text: allowOutcomeText(outcome), failed: outcome.kind === 'failed' })
  }

  const save = async (change: NotificationChange) => {
    if (!settings) return
    const next = changedNotificationSettings(settings, change, phoneTimeZone())
    setSaving(next)
    const result = await session.command('set_notification_settings', next)
    setSaving(null)
    setNote(result.ok ? null : { text: NOTIFICATIONS_COPY.savingFailed, failed: true })
  }

  const agents = listedAgents(session.store).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <>
      <Section title="Notifications" footer={<Text>{NOTIFICATIONS_COPY.footer}</Text>}>
        <Button label="Allow notifications on this phone" onPress={() => { void allow() }} />
        {settings ? (
          <>
            <Picker label="Notify me about" selection={settings.mode} modifiers={[pickerStyle('menu')]}
              onSelectionChange={(mode) => {
                const chosen = NOTIFY_MODE_OPTIONS.find((option) => option.mode === mode)
                if (chosen) void save({ kind: 'mode', mode: chosen.mode })
              }}>
              {NOTIFY_MODE_OPTIONS.map((option) => <Text key={option.mode} modifiers={[tag(option.mode)]}>{option.label}</Text>)}
            </Picker>
            <Toggle label="Urgent asks break through Focus" isOn={settings.urgentBreaksThrough} onIsOnChange={(on) => { void save({ kind: 'urgent_breaks_through', on }) }} />
            <Toggle label="One banner per agent burst" isOn={settings.burstSeconds > 0} onIsOnChange={(on) => { void save({ kind: 'one_banner_per_burst', on }) }} />
          </>
        ) : null}
        {note !== null ? <Note text={note.text} color={note.failed ? 'red' : 'secondary'} /> : null}
      </Section>
      {settings ? (
        <Section title="Quiet hours" footer={<Text>{NOTIFICATIONS_COPY.quietHoursFooter}</Text>}>
          <Toggle label="Quiet hours" isOn={settings.quietHours !== null} onIsOnChange={(on) => { void save({ kind: 'quiet_hours', on }) }} />
          {settings.quietHours ? (
            <>
              <TimePicker label="From" at={settings.quietHours.start} onChange={(at) => { void save({ kind: 'quiet_hours_start', at }) }} />
              <TimePicker label="Until" at={settings.quietHours.end} onChange={(at) => { void save({ kind: 'quiet_hours_end', at }) }} />
            </>
          ) : null}
        </Section>
      ) : null}
      {settings && agents.length > 0 ? (
        <Section title="Muted agents" footer={<Text>{NOTIFICATIONS_COPY.mutedFooter}</Text>}>
          {agents.map((agent) => (
            <Toggle key={agent.id} label={agent.name} isOn={settings.mutedAgentIds.includes(agent.id)}
              onIsOnChange={(muted) => { void save({ kind: 'agent_muted', agentId: agent.id, muted }) }} />
          ))}
        </Section>
      ) : null}
    </>
  )
}

function TimePicker({ label, at, onChange }: { label: string; at: string; onChange: (at: string) => void }) {
  // A time saved elsewhere off the half hour still shows as itself.
  const times = QUIET_HOURS_TIMES.includes(at) ? QUIET_HOURS_TIMES : [...QUIET_HOURS_TIMES, at].sort()
  return (
    <Picker label={label} selection={at} modifiers={[pickerStyle('menu')]}
      onSelectionChange={(chosen) => { if (times.includes(String(chosen))) onChange(String(chosen)) }}>
      {times.map((time) => <Text key={time} modifiers={[tag(time)]}>{time}</Text>)}
    </Picker>
  )
}
