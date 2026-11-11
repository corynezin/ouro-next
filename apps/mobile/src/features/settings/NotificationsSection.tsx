// Settings' notifications: on or off, and whether urgent asks break through Focus. The rest (what to notify about, quiet
// hours, bursts, muted agents) is still in the settings the server keeps, just not offered here. The settings are the
// person's, synced across their phones; each change saves them all. Renders settings/model.ts.
import { useState } from 'react'
import { Section, Toggle } from '@expo/ui/swift-ui'
import type { NotificationSettings } from '@ouro/contract'
import { allowOutcomeText } from '../../core/push/pushCenter.ts'
import { Note } from '../../design/form.tsx'
import { usePush, useSession } from '../../navigation/coreContext.tsx'
import { changedNotificationSettings, NOTIFICATIONS_COPY, notificationSettingsOf } from './model.ts'
import type { NotificationChange } from './model.ts'

const phoneTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function NotificationsSection() {
  const push = usePush()
  const session = useSession()
  const stored = session.store.notificationSettings
  // Shown from the tap until the server's answer, so quick changes build on each other instead of on the stored ones.
  const [saving, setSaving] = useState<NotificationSettings | null>(null)
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const settings = saving ?? (stored ? notificationSettingsOf(stored) : null)

  const save = async (change: NotificationChange) => {
    if (!settings) return
    const next = changedNotificationSettings(settings, change, phoneTimeZone())
    setSaving(next)
    const result = await session.command('set_notification_settings', next)
    setSaving(null)
    if (!result.ok) setNote({ text: NOTIFICATIONS_COPY.savingFailed, failed: true })
  }

  // On asks this phone for permission too, so one switch is all it takes; off keeps the phone's registration.
  const turn = async (on: boolean) => {
    setNote(null)
    if (!on) return save({ kind: 'mode', mode: 'nothing' })
    void save({ kind: 'mode', mode: settings?.mode === 'nothing' || !settings ? 'needs_me' : settings.mode })
    const outcome = await push.allowOnThisPhone()
    if (outcome.kind !== 'on') setNote({ text: allowOutcomeText(outcome), failed: outcome.kind === 'failed' })
  }

  const on = settings !== null && settings.mode !== 'nothing'
  return (
    <Section title="Notifications">
      {settings ? <Toggle label="Notifications" isOn={on} onIsOnChange={(next) => { void turn(next) }} /> : null}
      {on ? <Toggle label="Urgent asks break through Focus" isOn={settings.urgentBreaksThrough} onIsOnChange={(next) => { void save({ kind: 'urgent_breaks_through', on: next }) }} /> : null}
      {note !== null ? <Note text={note.text} color={note.failed ? 'red' : 'secondary'} /> : null}
    </Section>
  )
}
