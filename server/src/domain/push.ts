// Which events become a notification on a person's phones, and how loud. Pure: the caller supplies the settings, the
// event and what was last pushed.
import type { AskLevel, NotificationSettings } from '@ouro/contract'

export type PushEvent =
  /** A message to the person: in their direct chat with an agent, or in a group. */
  | { kind: 'message'; agentId: string | null; chat: 'direct' | 'group'; mentionsPerson: boolean; at: number }
  /** An ask to the person, when it opens or comes due to be repeated. `agentId`: null for an agent on another computer,
   * which can't be muted here. */
  | { kind: 'ask'; agentId: string | null; level: AskLevel }

export type PushDecision =
  | { kind: 'none' }
  /**
   * - `audible`: banner and sound. A silent one still lands in Notification Centre.
   * - `timeSensitive`: breaks through Focus and quiet hours: urgent asks, when allowed.
   */
  | { kind: 'alert'; audible: boolean; timeSensitive: boolean }

/** A group message older than this is history, not news. */
const GROUP_PUSH_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * `lastAlertFromSourceAt`: when this person was last alerted about the same agent (or room), for collapsing bursts.
 * `inQuietHours`: whether it is quiet hours for them now.
 */
export function decidePush(settings: NotificationSettings, event: PushEvent, now: number, lastAlertFromSourceAt: number | null, inQuietHours: boolean): PushDecision {
  if (settings.mode === 'nothing') return { kind: 'none' }
  if (event.agentId !== null && settings.mutedAgentIds.includes(event.agentId)) return { kind: 'none' }

  if (event.kind === 'message') {
    if (event.chat === 'group' && (!event.mentionsPerson || now - event.at > GROUP_PUSH_MAX_AGE_MS)) return { kind: 'none' }
    // "What needs me" is asks, and being called by name in a group: not every direct message.
    if (settings.mode === 'needs_me' && event.chat === 'direct') return { kind: 'none' }
  }

  if (event.kind === 'ask' && event.level === 'urgent' && settings.urgentBreaksThrough) return { kind: 'alert', audible: true, timeSensitive: true }
  const inBurst = settings.burstSeconds > 0 && lastAlertFromSourceAt !== null && now - lastAlertFromSourceAt < settings.burstSeconds * 1000
  // A question that blocks the agent is never swallowed by a burst.
  const neverQuietened = event.kind === 'ask' && event.level !== 'waiting'
  const audible = !inQuietHours && (!inBurst || neverQuietened)
  return { kind: 'alert', audible, timeSensitive: false }
}

/** How long before an unanswered ask is pushed again. */
export const ASK_RENOTIFY_MS: Record<AskLevel, number> = {
  waiting: 120 * 60_000,
  blocked: 30 * 60_000,
  urgent: 5 * 60_000,
}

/** Whether an open, unsnoozed ask should be pushed again now. Its last push is stored, so a restart can't cause a burst. */
export function askRenotifyDue(level: AskLevel, lastNotifiedAt: number, now: number): boolean {
  return now - lastNotifiedAt >= ASK_RENOTIFY_MS[level]
}

/** How far the zone's clock is ahead of UTC at that moment, to the minute. */
function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)!.value)
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'))
  return wall - (at - (at % 60_000))
}

/** When these quiet hours next end after `now`, in the person's own zone: a snooze until quiet hours end is a snooze
 * until then. */
export function quietHoursEndAfter(quietHours: NonNullable<NotificationSettings['quietHours']>, now: number): number {
  const local = new Date(now + zoneOffsetMs(quietHours.timeZone, now))
  const [hour, minute] = [Number(quietHours.end.slice(0, 2)), Number(quietHours.end.slice(3, 5))]
  for (let days = 0; ; days++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute)
    // The offset at the end itself, which a change of clocks overnight can make differ from now's.
    const at = wall - zoneOffsetMs(quietHours.timeZone, wall - zoneOffsetMs(quietHours.timeZone, wall))
    if (at > now) return at
  }
}

/** Quiet hours in the person's own zone. Start equal to end means none; a window can cross midnight. */
export function isInQuietHours(quietHours: NotificationSettings['quietHours'], now: number): boolean {
  if (quietHours === null) return false
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quietHours.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
  const minuteOfDay = Number(parts.find((part) => part.type === 'hour')!.value) * 60 + Number(parts.find((part) => part.type === 'minute')!.value)
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
  const start = toMinutes(quietHours.start)
  const end = toMinutes(quietHours.end)
  if (start === end) return false
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end
}
