// expo-notifications behind core's PushPlatform, and the wiring from iOS's notification events into PushCenter.
// Raw APNs pushes carry our `ouro` object beside `aps`, which expo-notifications gives as the trigger's payload.
import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import type { PushPayload } from '@ouro/contract'
import type { NotificationPermission, PushPlatform } from '../core/platform/ports.ts'
import { pushPayloadOf } from '../core/push/pushCenter.ts'
import { takeLaunchTap } from '../core/push/launchTap.ts'
import { pushTokenRegistrationOf } from '../core/push/registration.ts'
import type { PushCenter, PushResponse } from '../core/push/pushCenter.ts'

/** The server sends asks with `aps.category: "ask"`. */
const ASK_CATEGORY = 'ask'
const REPLY_ACTION = 'reply'
const SNOOZE_ACTION = 'snooze'
const BACKGROUND_PUSH_TASK = 'ouro-background-push'

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return 'granted'
  return status.canAskAgain ? 'not_asked' : 'denied'
}

export const nativePushPlatform: PushPlatform = {
  permission: async () => permissionOf(await Notifications.getPermissionsAsync()),
  requestPermission: async () => permissionOf(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } })),
  async registration() {
    const token = await Notifications.getDevicePushTokenAsync()
    return pushTokenRegistrationOf(String(token.data), { bundleId: Application.applicationId, productionApns: Updates.isEnabled && !__DEV__ })
  },
  setBadge: async (count) => { await Notifications.setBadgeCountAsync(count) },
}

function payloadOf(request: Notifications.NotificationRequest): PushPayload | null {
  const trigger = request.trigger
  if (trigger === null || !('type' in trigger) || trigger.type !== 'push' || !trigger.payload) return null
  return pushPayloadOf(trigger.payload)
}

function responseOf(response: Notifications.NotificationResponse): PushResponse | null {
  switch (response.actionIdentifier) {
    case Notifications.DEFAULT_ACTION_IDENTIFIER: return { kind: 'opened' }
    case REPLY_ACTION: return { kind: 'replied', text: response.userText ?? '' }
    case SNOOZE_ACTION: return { kind: 'snoozed' }
    default: return null // dismissed
  }
}

function respond(center: PushCenter, response: Notifications.NotificationResponse) {
  const payload = payloadOf(response.notification.request)
  const pushResponse = responseOf(response)
  if (payload && pushResponse) void center.responded(payload, pushResponse)
}

// Defined at the top level so iOS can run it with no UI: a silent push wakes the app in the background. The task's data
// is the push's userInfo less `aps`. Set by connectNativePush once the app's objects exist.
let backgroundCenter: PushCenter | null = null
TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_PUSH_TASK, async ({ data }) => {
  if ('actionIdentifier' in data) return
  const payload = pushPayloadOf(data.data)
  if (payload) backgroundCenter?.received(payload)
})

/** Connects iOS's notification events to the center, including the tap that launched the app, taken once. */
export function connectNativePush(center: PushCenter): () => void {
  backgroundCenter = center
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const payload = payloadOf(notification.request)
      const show = payload ? await center.shouldPresent(payload) : true
      return { shouldShowBanner: show, shouldShowList: true, shouldPlaySound: show, shouldSetBadge: true }
    },
  })
  Notifications.setNotificationCategoryAsync(ASK_CATEGORY, [
    { identifier: REPLY_ACTION, buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' }, options: { opensAppToForeground: false } },
    { identifier: SNOOZE_ACTION, buttonTitle: 'Snooze 1 hour', options: { opensAppToForeground: false } },
  ]).catch(() => {})
  Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK).catch(() => {})
  const received = Notifications.addNotificationReceivedListener((notification) => {
    const payload = payloadOf(notification.request)
    if (payload) center.received(payload)
  })
  const responded = Notifications.addNotificationResponseReceivedListener((response) => respond(center, response))
  const launchResponse = takeLaunchTap({ last: () => Notifications.getLastNotificationResponse(), clear: () => Notifications.clearLastNotificationResponse() })
  if (launchResponse) respond(center, launchResponse)
  return () => {
    received.remove()
    responded.remove()
    backgroundCenter = null
  }
}
