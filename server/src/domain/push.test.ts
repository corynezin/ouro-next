import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import type { NotificationSettings } from '@ouro/contract'
import { askRenotifyDue, decidePush, isInQuietHours, quietHoursEndAfter } from './push.ts'
import type { PushEvent } from './push.ts'

const NOW = Date.UTC(2026, 10, 9, 23, 30)
const settings = (changes: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...DEFAULT_NOTIFICATION_SETTINGS, ...changes })
const direct: PushEvent = { kind: 'message', agentId: 'a1', chat: 'direct', mentionsPerson: false, at: NOW }
const ask = (level: 'waiting' | 'blocked' | 'urgent'): PushEvent => ({ kind: 'ask', agentId: 'a1', level })
const loud = { kind: 'alert', audible: true, timeSensitive: false }
const quiet = { kind: 'alert', audible: false, timeSensitive: false }

test('modes: every message, what needs me (asks and mentions), nothing; muted agents push nothing', () => {
  assert.deepEqual(decidePush(settings(), direct, NOW, null, false), loud)
  assert.deepEqual(decidePush(settings({ mode: 'needs_me' }), direct, NOW, null, false), { kind: 'none' })
  assert.deepEqual(decidePush(settings({ mode: 'needs_me' }), ask('waiting'), NOW, null, false), loud)
  assert.deepEqual(decidePush(settings({ mode: 'needs_me' }), { ...direct, chat: 'group', agentId: null, mentionsPerson: true }, NOW, null, false), loud)
  assert.deepEqual(decidePush(settings({ mode: 'nothing' }), ask('urgent'), NOW, null, false), { kind: 'none' })
  assert.deepEqual(decidePush(settings({ mutedAgentIds: ['a1'] }), ask('blocked'), NOW, null, false), { kind: 'none' })
})

test('groups push only mentions, and never old news', () => {
  const group: PushEvent = { kind: 'message', agentId: null, chat: 'group', mentionsPerson: false, at: NOW }
  assert.deepEqual(decidePush(settings(), group, NOW, null, false), { kind: 'none' })
  assert.deepEqual(decidePush(settings(), { ...group, mentionsPerson: true }, NOW, null, false), loud)
  assert.deepEqual(decidePush(settings(), { ...group, mentionsPerson: true, at: NOW - 25 * 3_600_000 }, NOW, null, false), { kind: 'none' })
})

test('a burst is one banner, but a blocking question is never swallowed by one', () => {
  const lastAlert = NOW - 30_000
  assert.deepEqual(decidePush(settings(), direct, NOW, lastAlert, false), quiet)
  assert.deepEqual(decidePush(settings(), ask('waiting'), NOW, lastAlert, false), quiet)
  assert.deepEqual(decidePush(settings(), ask('blocked'), NOW, lastAlert, false), loud)
  assert.deepEqual(decidePush(settings(), direct, NOW, NOW - 61_000, false), loud)
  assert.deepEqual(decidePush(settings({ burstSeconds: 0 }), direct, NOW, lastAlert, false), loud)
})

test('quiet hours are silent, and an urgent ask breaks through when allowed', () => {
  assert.deepEqual(decidePush(settings(), ask('blocked'), NOW, null, true), quiet)
  assert.deepEqual(decidePush(settings(), ask('urgent'), NOW, null, true), { kind: 'alert', audible: true, timeSensitive: true })
  assert.deepEqual(decidePush(settings({ urgentBreaksThrough: false }), ask('urgent'), NOW, null, true), quiet)
})

test("quiet hours are in the person's zone and can cross midnight", () => {
  // 23:30 UTC is 18:30 in New York and 08:30 in Tokyo.
  assert.equal(isInQuietHours({ start: '22:00', end: '07:00', timeZone: 'UTC' }, NOW), true)
  assert.equal(isInQuietHours({ start: '22:00', end: '07:00', timeZone: 'America/New_York' }, NOW), false)
  assert.equal(isInQuietHours({ start: '08:00', end: '09:00', timeZone: 'Asia/Tokyo' }, NOW), true)
  assert.equal(isInQuietHours({ start: '09:00', end: '09:00', timeZone: 'UTC' }, NOW), false)
  assert.equal(isInQuietHours(null, NOW), false)
})

test('asks are repeated after 120, 30 and 5 minutes by level', () => {
  assert.equal(askRenotifyDue('waiting', NOW - 119 * 60_000, NOW), false)
  assert.equal(askRenotifyDue('waiting', NOW - 120 * 60_000, NOW), true)
  assert.equal(askRenotifyDue('blocked', NOW - 30 * 60_000, NOW), true)
  assert.equal(askRenotifyDue('urgent', NOW - 4 * 60_000, NOW), false)
  assert.equal(askRenotifyDue('urgent', NOW - 5 * 60_000, NOW), true)
})

test('quiet hours end next at their end time in the person\'s zone, today or tomorrow', () => {
  const at = (iso: string) => Date.parse(iso)
  assert.equal(quietHoursEndAfter({ start: '22:00', end: '07:00', timeZone: 'UTC' }, at('2026-11-10T23:30:00Z')), at('2026-11-11T07:00:00Z'))
  assert.equal(quietHoursEndAfter({ start: '22:00', end: '07:00', timeZone: 'UTC' }, at('2026-11-10T05:00:00Z')), at('2026-11-10T07:00:00Z'))
  assert.equal(quietHoursEndAfter({ start: '22:00', end: '07:00', timeZone: 'UTC' }, at('2026-11-10T07:00:00Z')), at('2026-11-11T07:00:00Z'), 'just ended: the next')
  assert.equal(quietHoursEndAfter({ start: '22:00', end: '07:00', timeZone: 'America/New_York' }, at('2026-11-10T23:30:00Z')), at('2026-11-11T12:00:00Z'))
  // Clocks go back in New York on 2026-11-01 at 02:00: 07:00 that morning is 12:00 UTC, not 11:00.
  assert.equal(quietHoursEndAfter({ start: '22:00', end: '07:00', timeZone: 'America/New_York' }, at('2026-11-01T03:00:00Z')), at('2026-11-01T12:00:00Z'))
})
