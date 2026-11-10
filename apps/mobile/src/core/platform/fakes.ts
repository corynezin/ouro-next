// In-memory ports for tests. FakeClock only moves when told to, so backoffs test instantly.
import type {
  AppLifecycle, Clock, DurableStore, FileUploadRequest, HttpRequest, HttpResponse, HttpStream, IdSource, Network,
  NotificationPermission, PushPlatform, SecureStorage,
} from './ports.ts'

export class FakeClock implements Clock {
  private time: number
  private timers: { fireAt: number; fire: () => void }[] = []
  constructor(start = 1_000_000) { this.time = start }
  now() { return this.time }
  setTimer(delayMs: number, fire: () => void) {
    const timer = { fireAt: this.time + delayMs, fire }
    this.timers.push(timer)
    return () => { this.timers = this.timers.filter((t) => t !== timer) }
  }
  async advance(ms: number) {
    const target = this.time + ms
    for (;;) {
      const due = this.timers.filter((t) => t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t !== due)
      this.time = due.fireAt
      due.fire()
      await settle()
    }
    this.time = target
    await settle()
  }
  get pendingTimerCount() { return this.timers.length }
}

/** Lets promise chains started by the code under test run to their next real wait. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

export class FakeIds implements IdSource {
  private next = 0
  newId() { return `id-${String(++this.next).padStart(8, '0')}` }
}

export class FakeLifecycle implements AppLifecycle {
  private listeners = new Set<() => void>()
  onForeground(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private backgroundListeners = new Set<() => void>()
  onBackground(listener: () => void) {
    this.backgroundListeners.add(listener)
    return () => { this.backgroundListeners.delete(listener) }
  }
  private switchingAwayListeners = new Set<() => void>()
  onSwitchingAway(listener: () => void) {
    this.switchingAwayListeners.add(listener)
    return () => { this.switchingAwayListeners.delete(listener) }
  }
  private activeAgainListeners = new Set<() => void>()
  onActiveAgain(listener: () => void) {
    this.activeAgainListeners.add(listener)
    return () => { this.activeAgainListeners.delete(listener) }
  }
  private active = true
  isActive() { return this.active }
  /** Back from switching away without having been in the background, as when a system prompt closes. */
  returnFromSwitchingAway() {
    this.active = true
    for (const listener of this.activeAgainListeners) listener()
  }
  /** Inactive without going to the background, as when the app switcher or a system prompt is up. */
  switchAway() {
    this.active = false
    for (const listener of this.switchingAwayListeners) listener()
  }
  goToBackground() {
    this.switchAway()
    for (const listener of this.backgroundListeners) listener()
  }
  comeToForeground() {
    this.returnFromSwitchingAway()
    for (const listener of this.listeners) listener()
  }
}

export class MemorySecureStorage implements SecureStorage {
  readonly values = new Map<string, string>()
  failReads = false
  failWrites = false
  /** A key that fails its next write, to prove the steps after it don't run. */
  failNextWriteMatching: RegExp | null = null
  async read(key: string) {
    if (this.failReads) throw new Error('secure storage unavailable')
    return this.values.get(key) ?? null
  }
  async write(key: string, value: string) {
    if (this.failWrites) throw new Error('secure storage unavailable')
    if (this.failNextWriteMatching?.test(key)) {
      this.failNextWriteMatching = null
      throw new Error('secure storage unavailable')
    }
    this.values.set(key, value)
  }
  async remove(key: string) {
    if (this.failWrites) throw new Error('secure storage unavailable')
    this.values.delete(key)
  }
}

export class MemoryDurableStore implements DurableStore {
  readonly values = new Map<string, string>()
  failWrites = false
  async read(key: string) { return this.values.get(key) ?? null }
  async write(key: string, value: string) {
    if (this.failWrites) throw new Error('store write failed')
    this.values.set(key, value)
  }
  async remove(key: string) { this.values.delete(key) }
  async readKeysWithPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))
  }
}

export interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** Rejects when `signal` aborts, as real fetch does. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
    promise.then(resolve, reject)
  })
}

/** A pushable stream of text chunks. Reading rejects if the connection drops or the request aborts. */
export class FakeStream implements HttpStream {
  private queue: string[] = []
  private ended = false
  private failure: Error | null = null
  private wake: (() => void) | null = null
  readonly status: number
  readonly chunks: AsyncIterable<string>
  constructor(status: number, signal: AbortSignal) {
    this.status = status
    signal.addEventListener('abort', () => this.drop(abortError()), { once: true })
    this.chunks = { [Symbol.asyncIterator]: () => this.iterate() }
  }
  private async *iterate() {
    for (;;) {
      if (this.queue.length) { yield this.queue.shift()!; continue }
      if (this.failure) throw this.failure
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
  private poke() { this.wake?.(); this.wake = null }
  push(text: string) { this.queue.push(text); this.poke() }
  pushFrame(frame: unknown) { this.push(`data: ${JSON.stringify(frame)}\n\n`) }
  end() { this.ended = true; this.poke() }
  drop(error = new Error('connection lost')) { this.failure = error; this.poke() }
}

export type RequestHandler = (request: HttpRequest) => Promise<HttpResponse> | HttpResponse

/** A network whose answers tests decide. Unrouted requests reject like an unreachable host. */
export class FakeNetwork implements Network {
  readonly requests: HttpRequest[] = []
  readonly uploads: FileUploadRequest[] = []
  readonly streams: FakeStream[] = []
  routes: { method: HttpRequest['method']; pathContains: string; handle: RequestHandler }[] = []
  streamStatus = 200
  streamFailure: Error | null = null
  uploadHandler: (request: FileUploadRequest) => Promise<HttpResponse> | HttpResponse = () => { throw new Error('no upload route') }

  route(method: HttpRequest['method'], pathContains: string, handle: RequestHandler) {
    this.routes = [{ method, pathContains, handle }, ...this.routes]
  }
  routeJson(method: HttpRequest['method'], pathContains: string, json: unknown, status = 200) {
    this.route(method, pathContains, () => ({ status, text: JSON.stringify(json) }))
  }
  async request(request: HttpRequest) {
    this.requests.push(request)
    const route = this.routes.find((r) => r.method === request.method && request.url.includes(r.pathContains))
    if (!route) throw new Error(`unreachable: ${request.method} ${request.url}`)
    return untilAborted(Promise.resolve().then(() => route.handle(request)), request.signal)
  }
  async openStream(request: HttpRequest): Promise<HttpStream> {
    this.requests.push(request)
    if (this.streamFailure) throw this.streamFailure
    const stream = new FakeStream(this.streamStatus, request.signal)
    this.streams.push(stream)
    return stream
  }
  async uploadFile(request: FileUploadRequest) {
    this.uploads.push(request)
    return untilAborted(Promise.resolve().then(() => this.uploadHandler(request)), request.signal)
  }
  get lastStream() {
    const stream = this.streams.at(-1)
    if (!stream) throw new Error('no stream was opened')
    return stream
  }
  bodiesTo(pathContains: string): unknown[] {
    return this.requests.filter((r) => r.url.includes(pathContains) && r.body !== null).map((r) => JSON.parse(r.body!))
  }
}

/** Notifications as a test decides. `permissionAfterPrompt` is what the person answers to the system prompt. */
export class FakePushPlatform implements PushPlatform {
  currentPermission: NotificationPermission = 'not_asked'
  permissionAfterPrompt: NotificationPermission = 'granted'
  prompts = 0
  readonly badges: number[] = []
  async permission() { return this.currentPermission }
  async requestPermission() {
    if (this.currentPermission === 'not_asked') {
      this.prompts++
      this.currentPermission = this.permissionAfterPrompt
    }
    return this.currentPermission
  }
  /** False: iOS never hands over a token, as a simulator without APNs may do. */
  tokenArrives = true
  registration() {
    if (!this.tokenArrives) return new Promise<never>(() => {})
    return Promise.resolve({ token: 'ab'.repeat(32), environment: 'sandbox' as const, bundleId: 'dev.test.ouro' })
  }
  async setBadge(count: number) { this.badges.push(count) }
}
