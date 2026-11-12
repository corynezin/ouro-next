// Server settings against the real server: choices the owner saves (with `ouro`, say) come back through sync.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Settings: the owner turns auto-archive on and off, and the choice comes back through sync', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const shown = () => session.store.server?.limits.autoArchiveAfterHours
    await waitFor('auto-archive off by default', () => shown() === null)
    const saved = await session.command('set_auto_archive', { afterHours: 24 })
    assert.ok(saved.ok, saved.ok ? '' : JSON.stringify(saved.failure))
    await waitFor('after 1 day, through sync', () => shown() === 24)
    const off = await session.command('set_auto_archive', { afterHours: null })
    assert.ok(off.ok, off.ok ? '' : JSON.stringify(off.failure))
    await waitFor('off again, through sync', () => shown() === null)
  } finally {
    phone.activeSession?.dispose()
  }
})

test('Settings: the owner turns reply reminders off and on, and the switch comes back through sync', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const shown = () => session.store.server?.limits.replyReminders
    await waitFor('on by default', () => shown() === true)
    const off = await session.command('set_reply_reminders', { on: false })
    assert.ok(off.ok, off.ok ? '' : JSON.stringify(off.failure))
    await waitFor('off, through sync', () => shown() === false)
    const on = await session.command('set_reply_reminders', { on: true })
    assert.ok(on.ok, on.ok ? '' : JSON.stringify(on.failure))
    await waitFor('on again, through sync', () => shown() === true)
  } finally {
    phone.activeSession?.dispose()
  }
})
