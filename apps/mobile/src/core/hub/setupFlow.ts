// Waiting for the hub to make a server, then pairing this phone with it, with no code shown. Polls every 2 seconds, every
// 5 after the hub couldn't be reached, and stops at the first answer that ends it.
import type { HostedServer, ProvisioningStep } from '@ouro/contract'
import type { Clock } from '../platform/ports.ts'
import { HUB_SIGNED_OUT_TEXT } from './hubApi.ts'
import type { HubResult } from './hubApi.ts'

export type SetupState =
  /** `step` is null until the hub has said which. */
  | { stage: 'waiting'; step: ProvisioningStep | null }
  | { stage: 'pairing' }
  | { stage: 'failed'; message: string }
  /** Paired and connected: the app moves on by itself. */
  | { stage: 'done' }

export const SETUP_COPY = {
  signedOut: HUB_SIGNED_OUT_TEXT,
  failed: 'Setting up your computer failed.',
  alreadyPaired: 'Your computer is ready but already paired with another phone.',
  pairingFailed: (reason: string) => `Connecting this phone failed: ${reason}`,
} as const

const POLL_MS = 2000
const POLL_AFTER_UNREACHABLE_MS = 5000

export interface SetupFlowDeps {
  clock: Clock
  /** The server being made. Null: the hub doesn't list it yet, so keep waiting. */
  read: () => Promise<HubResult<HostedServer | null>>
  /** Throws a readable error if pairing or saving fails. */
  pair: (address: string, code: string, server: HostedServer) => Promise<void>
  onChange: () => void
}

export class SetupFlow {
  private readonly deps: SetupFlowDeps
  private current: SetupState = { stage: 'waiting', step: null }
  private cancelTimer: (() => void) | null = null
  /** Each start moves this on, so an answer to an earlier run is dropped. */
  private run = 0

  constructor(deps: SetupFlowDeps) {
    this.deps = deps
  }

  get state() { return this.current }

  /** Also "Try again" after a failure. */
  start() {
    this.stop()
    const run = this.run
    this.set({ stage: 'waiting', step: null })
    void this.poll(run)
  }

  stop() {
    this.run++
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private async poll(run: number) {
    const answer = await this.deps.read()
    if (run !== this.run) return
    if (answer.ok) return this.follow(run, answer.value)
    switch (answer.failure.kind) {
      case 'unauthenticated': return this.set({ stage: 'failed', message: SETUP_COPY.signedOut })
      case 'refused': return this.set({ stage: 'failed', message: answer.failure.message || SETUP_COPY.failed })
      case 'invalid_answer': return this.set({ stage: 'failed', message: SETUP_COPY.failed })
      case 'unreachable': return this.pollAgainIn(run, POLL_AFTER_UNREACHABLE_MS)
    }
  }

  private async follow(run: number, server: HostedServer | null) {
    if (server === null) {
      this.set({ stage: 'waiting', step: null })
      return this.pollAgainIn(run, POLL_MS)
    }
    const status = server.status
    switch (status.state) {
      case 'provisioning':
        this.set({ stage: 'waiting', step: status.step })
        return this.pollAgainIn(run, POLL_MS)
      case 'failed':
        return this.set({ stage: 'failed', message: status.why || SETUP_COPY.failed })
      case 'ready': {
        if (status.pairing === null) return this.set({ stage: 'failed', message: SETUP_COPY.alreadyPaired })
        this.set({ stage: 'pairing' })
        try {
          await this.deps.pair(status.address, status.pairing.code, server)
          if (run === this.run) this.set({ stage: 'done' })
        } catch (failure) {
          const message = failure instanceof Error && failure.name === 'NetworkPlacementFailed' ? failure.message : SETUP_COPY.pairingFailed(failure instanceof Error ? failure.message : String(failure))
          if (run === this.run) this.set({ stage: 'failed', message })
        }
      }
    }
  }

  private pollAgainIn(run: number, delayMs: number) {
    this.cancelTimer = this.deps.clock.setTimer(delayMs, () => { this.cancelTimer = null; void this.poll(run) })
  }

  private set(state: SetupState) {
    this.current = state
    this.deps.onChange()
  }
}

/** The account's server made at sign-up. */
export const primaryOf = (servers: readonly HostedServer[]) => servers.find((server) => server.primary) ?? null
