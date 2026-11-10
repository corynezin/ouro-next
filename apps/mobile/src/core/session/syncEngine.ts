// Keeps one server's store current: a snapshot, then the change stream from its cursor. Retries every 2 seconds, and at
// once on returning to the foreground. Its one claim of "live" is the server's `caught_up` frame.
import type { SyncFrame } from '@ouro/contract'
import type { AppLifecycle, Clock } from '../platform/ports.ts'
import type { EntityStore } from './entityStore.ts'
import { failureText, reasonOf, syncFrameOf } from './serverApi.ts'
import type { ServerApi } from './serverApi.ts'

export type ConnectionPhase =
  | 'connecting'
  /** Caught up with the server and following it. */
  | 'live'
  | 'offline'
  /** The token was refused. Nothing more is attempted. */
  | 'unpaired'

export interface ConnectionStatus {
  phase: ConnectionPhase
  /** Why it isn't live, in words for the person. Empty when live or connecting. */
  detail: string
  /** When it last stopped being live. Null while live. */
  downSince: number | null
}

const RETRY_DELAY_MS = 2000
/** The server sends something on the stream at least this often. A dead connection can't report itself, so silence is the only sign. */
const SERVER_HEARTBEAT_MS = 15_000
/** Silence this long while running means the connection is gone: two heartbeats missed, plus some slack for a slow network. */
const STREAM_SILENCE_LIMIT_MS = SERVER_HEARTBEAT_MS * 2 + 10_000
/** Back from the background, one missed heartbeat is enough: the OS often closes sockets there, and timers didn't run. */
const FOREGROUND_SILENCE_LIMIT_MS = SERVER_HEARTBEAT_MS + 5000

export class SyncEngine {
  private readonly api: ServerApi
  private readonly store: EntityStore
  private readonly clock: Clock
  private readonly lifecycle: AppLifecycle
  private readonly onStatusChange: () => void
  private readonly onCaughtUp: () => void
  private currentStatus: ConnectionStatus
  private stopped = false
  private needsSnapshot = true
  private closeOpenStream: ((outcome: ConnectOutcome) => void) | null = null
  private lastHeardFromStreamAt = 0
  private wakeFromRetryDelay: (() => void) | null = null
  private unsubscribeLifecycle: (() => void) | null = null

  constructor(deps: {
    api: ServerApi
    store: EntityStore
    clock: Clock
    lifecycle: AppLifecycle
    onStatusChange: () => void
    /** The stream has delivered everything the server had when it connected. */
    onCaughtUp: () => void
  }) {
    this.api = deps.api
    this.store = deps.store
    this.clock = deps.clock
    this.lifecycle = deps.lifecycle
    this.onStatusChange = deps.onStatusChange
    this.onCaughtUp = deps.onCaughtUp
    this.currentStatus = { phase: 'connecting', detail: '', downSince: deps.clock.now() }
  }

  get status() { return this.currentStatus }

  start() {
    this.unsubscribeLifecycle = this.lifecycle.onForeground(() => this.onForeground())
    void this.run()
  }

  stop() {
    this.stopped = true
    this.closeOpenStream?.({ kind: 'dropped', detail: '' })
    this.wakeFromRetryDelay?.()
    this.unsubscribeLifecycle?.()
  }

  /** Take a new snapshot and follow on from it now. A snapshot may only replace the store here: applied beside a running
   * stream, it could be older than frames already applied, and the stream wouldn't send those again. */
  takeNewSnapshot() {
    if (this.stopped || this.currentStatus.phase === 'unpaired') return
    this.needsSnapshot = true
    this.wakeFromRetryDelay?.()
    this.closeOpenStream?.({ kind: 'resync' })
  }

  private onForeground() {
    this.wakeFromRetryDelay?.()
    if (this.clock.now() - this.lastHeardFromStreamAt >= FOREGROUND_SILENCE_LIMIT_MS) this.closeOpenStream?.(SILENT_STREAM)
  }

  private setStatus(phase: ConnectionPhase, detail: string) {
    const down = phase !== 'live'
    const downSince = down ? this.currentStatus.downSince ?? this.clock.now() : null
    this.currentStatus = { phase, detail, downSince }
    this.onStatusChange()
  }

  private async run() {
    while (!this.stopped) {
      if (this.currentStatus.phase !== 'offline') this.setStatus('connecting', '')
      const outcome = await this.connectOnce()
      if (this.stopped) return
      switch (outcome.kind) {
        case 'unpaired':
          this.setStatus('unpaired', outcome.detail)
          return
        case 'resync':
          this.needsSnapshot = true
          continue
        case 'dropped':
          this.setStatus('offline', outcome.detail)
          await this.waitBeforeRetry()
      }
    }
  }

  private async connectOnce(): Promise<ConnectOutcome> {
    if (this.needsSnapshot) {
      const snapshot = await this.api.snapshot()
      if (this.stopped) return { kind: 'dropped', detail: '' }
      if (!snapshot.ok) {
        const detail = failureText(snapshot.failure)
        return snapshot.failure.kind === 'unauthenticated' ? { kind: 'unpaired', detail } : { kind: 'dropped', detail }
      }
      this.store.applySnapshot(snapshot.value)
      this.needsSnapshot = false
    }
    return this.followChanges()
  }

  private async followChanges(): Promise<ConnectOutcome> {
    const abort = new AbortController()
    let cancelSilenceTimer = () => {}
    const closed = new Promise<ConnectOutcome>((resolve) => {
      this.closeOpenStream = (outcome) => {
        abort.abort()
        resolve(outcome)
      }
    })
    const heardFromStream = () => {
      this.lastHeardFromStreamAt = this.clock.now()
      cancelSilenceTimer()
      cancelSilenceTimer = this.clock.setTimer(STREAM_SILENCE_LIMIT_MS, () => this.closeOpenStream?.(SILENT_STREAM))
    }
    heardFromStream()
    try {
      // Raced because a read isn't known to settle once its connection is dead or aborted.
      return await Promise.race([this.readChanges(abort.signal, heardFromStream), closed])
    } finally {
      cancelSilenceTimer()
      // Only an abort closes an expo/fetch connection. Cancelling its reader leaves it open.
      abort.abort()
      this.closeOpenStream = null
    }
  }

  private async readChanges(signal: AbortSignal, heardFromStream: () => void): Promise<ConnectOutcome> {
    try {
      const stream = await this.api.openChanges(this.store.epoch!, this.store.cursor, signal)
      if (stream.status === 401) return { kind: 'unpaired', detail: failureText({ kind: 'unauthenticated', status: 401 }) }
      if (stream.status !== 200) return { kind: 'dropped', detail: `stream: HTTP ${stream.status}` }
      const parser = new ServerSentDataParser()
      for await (const chunk of stream.chunks) {
        if (signal.aborted) return { kind: 'dropped', detail: '' }
        heardFromStream()
        for (const payload of parser.push(chunk)) {
          const outcome = this.applyFrame(syncFrameOf(payload))
          if (outcome) return outcome
        }
      }
      // expo/fetch reports a lost connection as a normal end, and can lose the last frame. So no end is ever a clean one:
      // reconnect from the last applied cursor, and the server replays whatever was lost.
      return { kind: 'dropped', detail: 'the connection ended' }
    } catch (error) {
      return { kind: 'dropped', detail: reasonOf(error) }
    }
  }

  private applyFrame(frame: SyncFrame): ConnectOutcome | null {
    switch (frame.frame) {
      case 'change':
        this.store.applyChange(frame.change)
        return null
      case 'caught_up':
        this.setStatus('live', '')
        this.onCaughtUp()
        return null
      case 'resync_required':
        return { kind: 'resync' }
    }
  }

  private waitBeforeRetry() {
    return new Promise<void>((resolve) => {
      const finish = () => {
        cancelTimer()
        this.wakeFromRetryDelay = null
        resolve()
      }
      const cancelTimer = this.clock.setTimer(RETRY_DELAY_MS, finish)
      this.wakeFromRetryDelay = finish
    })
  }
}

type ConnectOutcome =
  | { kind: 'unpaired'; detail: string }
  /** The epoch moved on: take a new snapshot, right away. */
  | { kind: 'resync' }
  | { kind: 'dropped'; detail: string }

const SILENT_STREAM: ConnectOutcome = { kind: 'dropped', detail: 'nothing heard from the server' }

/** Turns stream chunks into SSE `data` payloads. Comments and other fields are ignored; the cursor is in the frame. */
export class ServerSentDataParser {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const payloads: string[] = []
    for (;;) {
      const end = this.buffer.indexOf('\n\n')
      if (end < 0) return payloads
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart())
      if (data.length) payloads.push(data.join('\n'))
    }
  }
}
