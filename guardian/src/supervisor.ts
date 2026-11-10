// Starts and stops the one ourod. It never touches runners: stopping the server stops only the server.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardianConfig, GuardianPaths } from './config.ts'

export class OurodSupervisor {
  private child: ChildProcess | null = null
  private runningRelease: string | null = null
  private readonly config: GuardianConfig
  private readonly paths: GuardianPaths
  private onUnexpectedExit: ((code: number | null) => void) | null = null

  constructor(config: GuardianConfig, paths: GuardianPaths) {
    this.config = config
    this.paths = paths
  }

  get release(): string | null {
    return this.runningRelease
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  whenExitsUnexpectedly(handler: (code: number | null) => void): void {
    this.onUnexpectedExit = handler
  }

  start(releaseId: string): void {
    if (this.child) throw new Error('ourod is already running')
    const logFd = openSync(this.paths.ourodLog, 'a')
    const child = spawn(process.execPath, ['--no-warnings', join(this.paths.releaseDir(releaseId), 'server/src/bin/ourod.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        OURO_DATA: this.paths.dataDir,
        OURO_APP_LISTEN: `unix:${this.paths.appSocket}`,
        OURO_RELEASE_ID: releaseId,
        OURO_MACHINE_NAME: this.config.machineName,
        OURO_CLI_BIN_DIR: this.paths.cliBin,
        OURO_GUARDIAN_SOCKET: this.paths.controlSocket,
        OURO_APP_SOURCE: this.config.appSourceDir,
        ...(this.config.publicUrl ? { OURO_PUBLIC_URL: this.config.publicUrl } : {}),
        ...this.config.ourodEnv,
      },
      stdio: ['ignore', logFd, logFd],
    })
    closeSync(logFd)
    this.child = child
    this.runningRelease = releaseId
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.runningRelease = null
      this.onUnexpectedExit?.(code)
    })
  }

  /** Politely, then not. Resolves once it's gone, so there are never two writers. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.runningRelease = null
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), this.config.timing.stopGraceMs)
    await exited
    clearTimeout(force)
  }
}
