// Notifications: a person's settings, synced across their phones, and what a push carries. The server decides what to
// push (server/src/domain/push.ts); the app registers its token and acts on taps.
import { z } from 'zod'

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export const NotificationSettings = z.object({
  /**
   * - `needs_me`: asks to the person (and their reminders), and group messages that @-mention them.
   * - `every_message`: everything addressed to them, unless muted.
   * - `nothing`: no pushes; the badge still updates.
   */
  mode: z.enum(['needs_me', 'every_message', 'nothing']),
  mutedAgentIds: z.array(z.string()).max(500),
  /** Pushes from one agent within this many seconds share one banner, and only the first makes a sound. 0: off. */
  burstSeconds: z.number().int().min(0).max(600),
  /** Pushes arrive silently in this window, in the phone's zone as of the last save. */
  quietHours: z.object({ start: ClockTime, end: ClockTime, timeZone: z.string().refine(isTimeZone, 'not a time zone') }).nullable(),
  /** Urgent asks break through Focus and quiet hours. */
  urgentBreaksThrough: z.boolean(),
})
export type NotificationSettings = z.infer<typeof NotificationSettings>

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mode: 'every_message',
  mutedAgentIds: [],
  burstSeconds: 60,
  quietHours: null,
  urgentBreaksThrough: true,
}

/** The viewer's own settings. One per person, so the id is the person's. */
export const NotificationSettingsEntity = NotificationSettings.extend({ id: z.string() })
export type NotificationSettingsEntity = z.infer<typeof NotificationSettingsEntity>

export const PushTokenRegistration = z.object({
  /** The APNs device token, hex. */
  token: z.string().regex(/^[0-9a-f]{32,200}$/i),
  /** Which APNs gateway: a development build gets sandbox tokens. */
  environment: z.enum(['sandbox', 'production']),
  bundleId: z.string().min(1),
})
export type PushTokenRegistration = z.infer<typeof PushTokenRegistration>

/** What a push is about. */
export const PushSubject = z.discriminatedUnion('kind', [
  /** In a group, `agentId` is null: the app routes by chat. */
  z.object({ kind: z.literal('message'), chatId: z.string(), messageId: z.string(), agentId: z.string().nullable() }),
  /** Category `ask`, for the Reply and Snooze actions. `agentAddress`, so Reply can send without that server's data loaded. */
  z.object({ kind: z.literal('ask'), askId: z.string(), chatId: z.string(), agentId: z.string(), agentAddress: z.string() }),
  /** Silent: a new phone update to fetch in the background. */
  z.object({ kind: z.literal('update_available'), updateNumber: z.number().int().positive() }),
])
export type PushSubject = z.infer<typeof PushSubject>

/**
 * The `ouro` object in a push's payload, beside `aps`. `deviceId` is the receiving device's id on the server that sent
 * it: a phone paired with several servers tells by it which one a push came from.
 */
export const PushPayload = z.object({ deviceId: z.string(), subject: PushSubject })
export type PushPayload = z.infer<typeof PushPayload>
