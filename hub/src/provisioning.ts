// Making a person's computer, one step at a time. The step a server is at is stored before it runs, and every step can
// run again after an interruption with the same result, so a hub that restarts carries on where it was.
import { ProvisioningStep } from '@ouro/contract'
import type { HubStore, PairingRecord, ServerRecord } from './store.ts'

/** What a provisioner is told about the computer to make. */
export interface ComputerOrder {
  serverId: string
  label: string
  distributionCommit: string
}

/**
 * Where computers come from. Every step must be safe to run again: the hub may have stopped during it, or after it and
 * before it recorded the next one.
 */
export interface Provisioner {
  /** A machine exists for the server, with an address phones will reach. */
  create(order: ComputerOrder): Promise<void>
  /** Ouro at the order's commit is on it, as the person's own copy of the source. */
  upload(order: ComputerOrder): Promise<void>
  /** The source's dependencies are installed. */
  install(order: ComputerOrder): Promise<void>
  /** Ouro's configuration is written and its services are defined. */
  setup(order: ComputerOrder): Promise<void>
  /** Its services run and its first release is live. */
  service(order: ComputerOrder): Promise<void>
  /** The server's app API, as a phone pairs with it. */
  address(order: ComputerOrder): Promise<string>
  /** A new one-time code for the owner's phone. */
  startPairing(order: ComputerOrder): Promise<PairingRecord>
  /** Whether any phone has paired with the server. */
  hasPairedPhone(order: ComputerOrder): Promise<boolean>
  /** The machine and everything on it are gone; destroying one that is already gone succeeds. */
  destroy(order: ComputerOrder): Promise<void>
}

export const orderOf = (server: ServerRecord): ComputerOrder => ({ serverId: server.id, label: server.label, distributionCommit: server.distributionCommit })

export const nextStep = (step: ProvisioningStep): ProvisioningStep | null => ProvisioningStep.options[ProvisioningStep.options.indexOf(step) + 1] ?? null

/** Fit to show the person; the detail goes to the hub's log. */
export function failureWhy(step: ProvisioningStep, error: Error): string {
  const firstLine = error.message.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no detail'
  return `Setting up your computer failed at the ${step} step: ${firstLine.slice(0, 200)}`
}

export type ProvisioningEvent =
  | { event: 'step_started'; serverId: string; step: ProvisioningStep }
  | { event: 'server_ready'; serverId: string }
  | { event: 'server_failed'; serverId: string; step: ProvisioningStep; detail: string }

export class Provisioning {
  private readonly running = new Map<string, Promise<void>>()
  private readonly store: HubStore
  private readonly provisioner: Provisioner
  private readonly log: (event: ProvisioningEvent) => void

  constructor(store: HubStore, provisioner: Provisioner, log: (event: ProvisioningEvent) => void) {
    this.store = store
    this.provisioner = provisioner
    this.log = log
  }

  /** Carries on with every server that was being made when the hub last stopped. */
  resumeAll(): void {
    for (const server of this.store.serversProvisioning()) this.start(server.id)
  }

  /** Starts making the server unless that is under way already. Settles when it is ready or has failed. */
  start(serverId: string): Promise<void> {
    const underWay = this.running.get(serverId)
    if (underWay) return underWay
    const driving = this.drive(serverId).finally(() => this.running.delete(serverId))
    this.running.set(serverId, driving)
    return driving
  }

  /** Settles once nothing is being made: for an orderly stop. */
  async settled(): Promise<void> {
    await Promise.all(this.running.values())
  }

  private async drive(serverId: string): Promise<void> {
    for (;;) {
      const server = this.store.server(serverId)
      if (!server || server.progress.state !== 'provisioning') return
      const { step } = server.progress
      const order = orderOf(server)
      this.log({ event: 'step_started', serverId, step })
      try {
        if (step === 'pair') {
          const address = await this.provisioner.address(order)
          const pairing = await this.provisioner.startPairing(order)
          this.store.markReady(serverId, address, pairing)
          this.log({ event: 'server_ready', serverId })
          return
        }
        await this.provisioner[step](order)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.store.markFailed(serverId, failureWhy(step, failure))
        this.log({ event: 'server_failed', serverId, step, detail: failure.message.slice(0, 4000) })
        return
      }
      this.store.advance(serverId, step, nextStep(step)!)
    }
  }
}
