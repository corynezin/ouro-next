// What core needs from the phone. Native adapters live outside core; tests use ./fakes.ts.
import type { PushTokenRegistration } from '@ouro/contract'

export interface Clock {
  now(): number
  /** Returns a function that cancels the timer. */
  setTimer(delayMs: number, fire: () => void): () => void
}

/** The keychain: tokens, the server list, preferences, the hosted account. A read that rejects means "unknown", never "absent". */
export interface SecureStorage {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/** Larger local records that must survive the app being killed: the outbox and drafts. Holds no secrets. */
export interface DurableStore {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  readKeysWithPrefix(prefix: string): Promise<{ key: string; value: string }[]>
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  body: string | null
  signal: AbortSignal
}
export interface HttpResponse { status: number; text: string }
export interface HttpStream { status: number; chunks: AsyncIterable<string> }
export interface FileUploadRequest extends Omit<HttpRequest, 'body' | 'method'> {
  /** A local file URI. Its bytes are the request body. */
  fileUri: string
}

/** All of these reject when the request didn't complete, including on abort. A status is a completed request. */
export interface Network {
  request(request: HttpRequest): Promise<HttpResponse>
  openStream(request: HttpRequest): Promise<HttpStream>
  uploadFile(request: FileUploadRequest): Promise<HttpResponse>
}

export interface AppLifecycle {
  /** The app came back from the background; not from a system prompt or a glance away. Returns an unsubscribe function. */
  onForeground(listener: () => void): () => void
  /** The app went to the background. Returns an unsubscribe function. */
  onBackground(listener: () => void): () => void
  /**
   * The app stopped being the active one: switching apps, pulling down Notification Centre, a system prompt, or on the
   * way to the background. iOS takes the app-switcher snapshot at this moment. Returns an unsubscribe function.
   */
  onSwitchingAway(listener: () => void): () => void
  /** Active again after switching away, from the background or not. Returns an unsubscribe function. */
  onActiveAgain(listener: () => void): () => void
  /** On screen now, as opposed to in the background or switching away. */
  isActive(): boolean
}

export interface IdSource {
  /** Unique and at least 8 characters: usable as an idempotency key. */
  newId(): string
}

/** Permission to show notifications. `denied` includes "can't ask again": only iOS Settings can change it. */
export type NotificationPermission = 'granted' | 'denied' | 'not_asked'

/** The phone's notification system. What arrives and what the person does with it come in through PushCenter. */
export interface PushPlatform {
  permission(): Promise<NotificationPermission>
  /** Shows the system prompt if it still may, then says where things stand. */
  requestPermission(): Promise<NotificationPermission>
  /** This phone's APNs registration. Rejects if iOS gives no token. */
  registration(): Promise<PushTokenRegistration>
  setBadge(count: number): Promise<void>
}
