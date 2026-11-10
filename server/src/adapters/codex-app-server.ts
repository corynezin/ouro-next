// One `codex app-server` over stdio: JSON-RPC requests to it, and its notifications. Requests from it (approvals) are
// declined: agents run without permission prompts.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams
  private nextId = 0
  private readonly waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  onNotify: (method: string, params: unknown) => void = () => {}
  onClose: (reason: string) => void = () => {}

  /** `cwd` and `env` null: this process's own. */
  constructor(options: { command: string; cwd: string | null; env: Record<string, string> | null }) {
    this.child = spawn(options.command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) })
    this.child.on('error', (error) => this.failAll(error))
    this.child.stdin.on('error', () => { /* writing to a process that is gone */ })
    this.child.on('close', (code) => {
      this.failAll(new Error(`codex app-server exited (${code})`))
      this.onClose(`codex app-server exited (${code})`)
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
  }

  private onLine(line: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(line) as typeof message } catch { return }
    if (message.method && message.id !== undefined) {
      this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: `${message.method} is not supported` } })}\n`)
    } else if (message.method) {
      this.onNotify(message.method, message.params)
    } else if (message.id !== undefined) {
      const waiter = this.waiting.get(message.id)
      this.waiting.delete(message.id)
      if (message.error) waiter?.reject(new Error(String(message.error.message ?? 'codex request failed')))
      else waiter?.resolve(message.result)
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'ouro', title: 'Ouro', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  }

  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr
  }

  close(): void {
    this.child.kill()
  }
}

