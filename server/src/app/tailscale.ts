// Connecting this server to the person's Tailscale network, and taking it off again. Connect and remove each return at once
// and run on; the app asks again while they do. Only one runs at a time. While a step runs or the login waits for the
// person, the server counts it as work, so a host that pauses when idle stays up for the login to finish.
import type { TailscaleFailure, TailscaleState, TailscaleStatus } from '@ouro/contract'
import { TailscaleStepFailed } from '../adapters/tailscale.ts'
import type { TailscaleHost, TailscaleObservation, TailscaleSetup } from '../adapters/tailscale.ts'
import { CommandRefused } from './failure.ts'

/** After `tailscale up` starts, how long to wait for its login link, and how often to look. */
const LOGIN_LINK_WAIT_MS = 15_000
const LOGIN_LINK_CHECK_MS = 500
/** While the login waits for the person, how often the tick looks whether it finished. Each look runs `tailscale status`. */
const LOGIN_FINISHED_CHECK_MS = 5_000
/** How long a login left waiting keeps the host awake: one never approved mustn't keep it billing. */
export const LOGIN_WAIT_KEEPS_AWAKE_MS = 15 * 60_000

type Step = 'installing' | 'removing'

export interface TailscaleConfig {
  setup: TailscaleSetup
  hostname: string
  now: () => number
  log: (event: string, fields: Record<string, unknown>) => void
}

function stateOf(observation: TailscaleObservation): TailscaleState {
  switch (observation.kind) {
    case 'not_installed':
    case 'stopped': return { state: 'not_connected' }
    case 'needs_login': return { state: 'logging_in', loginUrl: observation.loginUrl }
    case 'running': return { state: 'connected', ip: observation.ip }
  }
}

/** A failed step's own words; anything else thrown is reported as it is, so a bug still says what it was. */
const messageOf = (error: unknown) => (error instanceof TailscaleStepFailed ? error.message : `Tailscale failed: ${(error as Error).message}`)

export class TailscaleConnection {
  private readonly config: TailscaleConfig
  private stepInProgress: Step | null = null
  private lastFailure: TailscaleFailure | null = null
  /** When the login link was first seen, while the login still waits for the person; null otherwise. */
  private loginWaitingSince: number | null = null
  private lastLoginCheckAt = 0
  private loginCheckInFlight = false
  /** The step running now, for tests to wait on. */
  running: Promise<void> | null = null

  constructor(config: TailscaleConfig) {
    this.config = config
  }

  async status(): Promise<TailscaleStatus> {
    const { setup } = this.config
    if (setup.kind === 'not_needed') return { tailscale: { state: 'not_needed' }, lastFailure: null, neededForComputers: false }
    const { neededForComputers } = setup
    if (this.stepInProgress) return { tailscale: { state: this.stepInProgress }, lastFailure: null, neededForComputers }
    return { tailscale: stateOf(this.noted(await setup.host.observe())), lastFailure: this.lastFailure, neededForComputers }
  }

  /** Whether this has work the host mustn't pause under: a step running, or a login waiting for the person, for a while. */
  keepsHostAwake(): boolean {
    if (this.stepInProgress) return true
    return this.loginWaitingSince !== null && this.config.now() - this.loginWaitingSince < LOGIN_WAIT_KEEPS_AWAKE_MS
  }

  /** From the core's tick: while the login waits, looks now and then whether the person finished it. */
  tick(): void {
    const { setup } = this.config
    if (setup.kind === 'not_needed' || this.loginWaitingSince === null || this.stepInProgress || this.loginCheckInFlight) return
    const now = this.config.now()
    if (now - this.lastLoginCheckAt < LOGIN_FINISHED_CHECK_MS) return
    this.lastLoginCheckAt = now
    this.loginCheckInFlight = true
    void setup.host.observe()
      // A step begun meanwhile has its own say about the login.
      .then((observation) => { if (!this.stepInProgress) this.noted(observation) }, () => {})
      .finally(() => { this.loginCheckInFlight = false })
  }

  /** Starts connecting: installs Tailscale if needed and asks it for a login link, which `status` then gives. */
  async connect(): Promise<TailscaleStatus> {
    const host = this.hostOrRefuse()
    if (!this.stepInProgress) this.begin('installing', 'connect', () => this.connectSteps(host))
    return this.status()
  }

  /** Starts taking Tailscale off this server. */
  async remove(): Promise<TailscaleStatus> {
    const host = this.hostOrRefuse()
    if (!this.stepInProgress) this.begin('removing', 'remove', () => host.remove())
    return this.status()
  }

  private hostOrRefuse(): TailscaleHost {
    const { setup } = this.config
    if (setup.kind === 'not_needed') throw new CommandRefused('tailscale_not_needed', 'this server reaches your computers without Tailscale set up from here')
    return setup.host
  }

  private begin(step: Step, action: TailscaleFailure['action'], steps: () => Promise<void>): void {
    this.stepInProgress = step
    this.lastFailure = null
    this.loginWaitingSince = null
    this.running = steps()
      .catch((error: unknown) => {
        this.lastFailure = { action, message: messageOf(error) }
        this.config.log('tailscale_failed', { action, why: this.lastFailure.message })
      })
      .finally(() => {
        this.stepInProgress = null
        this.running = null
      })
  }

  private async connectSteps(host: TailscaleHost): Promise<void> {
    if ((await host.observe()).kind === 'not_installed') await host.install()
    await host.startLogin(this.config.hostname)
    const giveUpAt = Date.now() + LOGIN_LINK_WAIT_MS
    while (Date.now() < giveUpAt) {
      const observed = this.noted(await host.observe())
      if (observed.kind === 'needs_login' || observed.kind === 'running') return
      await new Promise((resolve) => setTimeout(resolve, LOGIN_LINK_CHECK_MS))
    }
    throw new TailscaleStepFailed('Tailscale started but gave no login link')
  }

  /** Keeps track of whether the login waits for the person, from what was just observed. */
  private noted(observation: TailscaleObservation): TailscaleObservation {
    if (observation.kind !== 'needs_login') this.loginWaitingSince = null
    else if (this.loginWaitingSince === null) this.loginWaitingSince = this.config.now()
    return observation
  }
}
