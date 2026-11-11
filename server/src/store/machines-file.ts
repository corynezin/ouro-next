// The servers this one is making or has made, kept in one JSON file beside the database, rewritten whole on each change.
// They are few, and their steps take minutes, so nothing here needs to be faster than that.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProvisioningStep } from '@ouro/contract'

export type MachineProgress =
  | { state: 'provisioning'; step: ProvisioningStep }
  | { state: 'ready'; address: string; pairing: { code: string; expiresAt: number } | null; phonePaired: boolean }
  | { state: 'failed'; why: string; step: ProvisioningStep }

export interface MachineRecord {
  id: string
  label: string
  provider: string
  createdAt: number
  /** The commit it is made from, fixed when it was asked for, so a step run again installs the same. */
  commit: string
  /** What the provider's steps recorded, such as an instance id. */
  data: Record<string, string>
  progress: MachineProgress
}

export class MachinesFile {
  private readonly path: string
  private records: MachineRecord[]

  constructor(path: string) {
    this.path = path
    this.records = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { machines: MachineRecord[] }).machines : []
  }

  list(): MachineRecord[] {
    return this.records.map((record) => structuredClone(record))
  }

  get(id: string): MachineRecord | null {
    const record = this.records.find((candidate) => candidate.id === id)
    return record ? structuredClone(record) : null
  }

  put(record: MachineRecord): void {
    this.records = [...this.records.filter((candidate) => candidate.id !== record.id), structuredClone(record)].sort((a, b) => a.createdAt - b.createdAt)
    this.save()
  }

  delete(id: string): void {
    this.records = this.records.filter((candidate) => candidate.id !== id)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.partial`, JSON.stringify({ machines: this.records }, null, 2), { mode: 0o600 })
    renameSync(`${this.path}.partial`, this.path)
  }
}
