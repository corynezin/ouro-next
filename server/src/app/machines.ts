// New servers this one makes on the cloud accounts it is connected to (see packages/contract/src/machines.ts). Each is
// made one step at a time, as the hub makes hosted ones: the step is recorded before it runs and every step can run
// again, so after a restart each carries on where it was. Once a phone has paired with one it is an ordinary server,
// linked by the phone with the others; it stays here until its machine is destroyed.
import { randomBytes } from 'node:crypto'
import { ProvisioningStep } from '@ouro/contract'
import type { MachineList, MachineProvider, NewMachine, SpritesActionResult, SpritesIntegrationState } from '@ouro/contract'
import type { MachineOrder, MachineProvisioner } from '../adapters/machine-provisioners.ts'
import type { SpritesAccount } from '../adapters/sprites-account.ts'
import type { MachineRecord, MachinesFile } from '../store/machines-file.ts'
import { CommandRefused } from './failure.ts'

/** One place servers can be made, and whether it can be now. */
export interface MachineProviderSetup {
  id: string
  name: string
  /** Null when it can't be used now; then `why` says what to set up, and `setup` names the integration to open. */
  provisioner: () => MachineProvisioner | null
  /** What is made, when available; what to do first, when not. */
  detail: () => string
  setup: string | null
}

export interface MachinesConfig {
  file: MachinesFile
  providers: readonly MachineProviderSetup[]
  /** The Sprites account Sprite servers are made on, set up in Integrations. */
  sprites: SpritesAccount
  /** The commit new servers are made from, or null when this server has no copy of its source to make one from. */
  currentCommit: () => Promise<string | null>
  now: () => number
  log: (event: string, fields: Record<string, unknown>) => void
}

/** A code is replaced this long before it expires, so the one handed out has time to be used. */
const PAIRING_RENEW_BEFORE_MS = 2 * 60_000
const STEPS = ProvisioningStep.options

export const failureWhy = (step: ProvisioningStep, error: Error): string => {
  const firstLine = error.message.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no detail'
  return `Making the server failed at the ${step} step: ${firstLine.slice(0, 300)}`
}

export class Machines {
  private readonly config: MachinesConfig
  private readonly running = new Map<string, Promise<void>>()
  private readonly pairingChecks = new Map<string, Promise<void>>()

  constructor(config: MachinesConfig) {
    this.config = config
  }

  /** Carries on with every server that was being made when this one last stopped. */
  resumeAll(): void {
    for (const record of this.config.file.list()) if (record.progress.state === 'provisioning') void this.start(record.id)
  }

  async list(): Promise<MachineList> {
    const providers: MachineProvider[] = this.config.providers.map((provider) => {
      const available = provider.provisioner() !== null
      return { id: provider.id, name: provider.name, available, detail: provider.detail(), setup: available ? null : provider.setup }
    })
    return { providers, machines: this.config.file.list().map((record) => this.shown(record)) }
  }

  async create(providerId: string, label: string): Promise<NewMachine> {
    const provider = this.config.providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new CommandRefused('not_found', `this server can't make servers on ${providerId}`)
    if (provider.provisioner() === null) throw new CommandRefused('invalid_request', provider.detail())
    const commit = await this.config.currentCommit()
    if (commit === null) throw new CommandRefused('invalid_request', 'this server has no copy of its source to make another server from')
    const record: MachineRecord = {
      id: `m-${randomBytes(4).toString('hex')}`, label: label.trim(), provider: provider.id, createdAt: this.config.now(), commit, data: {},
      progress: { state: 'provisioning', step: STEPS[0]! },
    }
    this.config.file.put(record)
    this.config.log('machine_requested', { machineId: record.id, provider: record.provider })
    void this.start(record.id)
    return this.shown(record)
  }

  /** As it stands, with a fresh pairing code once ready and until a phone has paired. */
  async get(id: string): Promise<NewMachine> {
    const record = this.recordOf(id)
    if (record.progress.state === 'ready' && !record.progress.phonePaired) await this.checkPairing(id)
    return this.shown(this.recordOf(id))
  }

  /** Destroys the machine and forgets it. One still being made is refused: its steps would go on making it. */
  async remove(id: string): Promise<void> {
    const record = this.recordOf(id)
    if (record.progress.state === 'provisioning' && this.running.has(id)) {
      throw new CommandRefused('invalid_request', 'this server is still being made; remove it once it is ready or has failed')
    }
    const provisioner = this.providerOf(record)?.provisioner() ?? null
    if (provisioner === null) throw new CommandRefused('invalid_request', `${this.providerOf(record)?.name ?? record.provider} isn't connected any more, so its machine can't be removed from here`)
    await provisioner.destroy(orderOf(record))
    this.config.file.delete(id)
    this.config.log('machine_removed', { machineId: id })
  }

  spritesStatus(): Promise<SpritesIntegrationState> {
    return this.config.sprites.status()
  }

  async spritesSetToken(token: string): Promise<SpritesActionResult> {
    const outcome = await this.config.sprites.setToken(token)
    return outcome.accepted ? { accepted: true, state: await this.spritesStatus() } : outcome
  }

  async spritesDisconnect(): Promise<SpritesActionResult> {
    this.config.sprites.disconnect()
    return { accepted: true, state: await this.spritesStatus() }
  }

  /** Settles when it is ready or has failed. */
  start(id: string): Promise<void> {
    const underWay = this.running.get(id)
    if (underWay) return underWay
    const driving = this.drive(id).finally(() => this.running.delete(id))
    this.running.set(id, driving)
    return driving
  }

  private async drive(id: string): Promise<void> {
    for (;;) {
      const record = this.config.file.get(id)
      if (!record || record.progress.state !== 'provisioning') return
      const { step } = record.progress
      this.config.log('machine_step_started', { machineId: id, step })
      try {
        const provisioner = this.providerOf(record)?.provisioner() ?? null
        if (provisioner === null) throw new Error(`${this.providerOf(record)?.name ?? record.provider} isn't connected any more`)
        const order = orderOf(record)
        if (step === 'pair') {
          const address = await provisioner.address(order)
          const pairing = await provisioner.startPairing(order)
          this.update(id, (current) => ({ ...current, progress: { state: 'ready', address, pairing, phonePaired: false } }))
          this.config.log('machine_ready', { machineId: id, address })
          return
        }
        if (step === 'create') {
          const data = await provisioner.create(order)
          this.update(id, (current) => ({ ...current, data: { ...current.data, ...data } }))
        } else {
          await provisioner[step](order)
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.update(id, (current) => ({ ...current, progress: { state: 'failed', step, why: failureWhy(step, failure) } }))
        this.config.log('machine_failed', { machineId: id, step, detail: failure.message.slice(0, 4000) })
        return
      }
      this.update(id, (current) => ({ ...current, progress: { state: 'provisioning', step: STEPS[STEPS.indexOf(step) + 1]! } }))
    }
  }

  private checkPairing(id: string): Promise<void> {
    const underWay = this.pairingChecks.get(id)
    if (underWay) return underWay
    const checking = this.refreshPairing(id).finally(() => this.pairingChecks.delete(id))
    this.pairingChecks.set(id, checking)
    return checking
  }

  /** The machine may be briefly unreachable; then what is known stays as it is. */
  private async refreshPairing(id: string): Promise<void> {
    const record = this.config.file.get(id)
    if (!record || record.progress.state !== 'ready' || record.progress.phonePaired) return
    const provisioner = this.providerOf(record)?.provisioner() ?? null
    if (provisioner === null) return
    const order = orderOf(record)
    try {
      if (await provisioner.hasPairedPhone(order)) {
        this.update(id, (current) => current.progress.state === 'ready' ? { ...current, progress: { ...current.progress, pairing: null, phonePaired: true } } : current)
        return
      }
      const { pairing } = record.progress
      if (pairing === null || pairing.expiresAt - PAIRING_RENEW_BEFORE_MS <= this.config.now()) {
        const renewed = await provisioner.startPairing(order)
        this.update(id, (current) => current.progress.state === 'ready' ? { ...current, progress: { ...current.progress, pairing: renewed } } : current)
      }
    } catch (error) {
      this.config.log('machine_pairing_check_failed', { machineId: id, detail: (error as Error).message.slice(0, 1000) })
    }
  }

  private shown(record: MachineRecord): NewMachine {
    const { progress } = record
    const status: NewMachine['status'] = progress.state === 'provisioning' ? { state: 'provisioning', step: progress.step }
      : progress.state === 'failed' ? { state: 'failed', why: progress.why }
      : { state: 'ready', address: progress.address, pairing: progress.phonePaired || progress.pairing === null || progress.pairing.expiresAt <= this.config.now() ? null : progress.pairing }
    const paired = progress.state === 'ready' && progress.phonePaired
    return { id: record.id, label: record.label, provider: record.provider, createdAt: record.createdAt, status, paired }
  }

  private recordOf(id: string): MachineRecord {
    const record = this.config.file.get(id)
    if (!record) throw new CommandRefused('not_found', 'no such server being made')
    return record
  }

  private providerOf(record: MachineRecord): MachineProviderSetup | undefined {
    return this.config.providers.find((provider) => provider.id === record.provider)
  }

  private update(id: string, change: (record: MachineRecord) => MachineRecord): void {
    const record = this.config.file.get(id)
    if (record) this.config.file.put(change(record))
  }
}

export const orderOf = (record: MachineRecord): MachineOrder => ({ id: record.id, label: record.label, commit: record.commit, data: record.data })
