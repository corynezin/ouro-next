import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunnerConfig } from '../adapters/runner-protocol.ts'

const runnerEntry = join(import.meta.dirname, '..', 'bin', 'ouro-runner.ts')

async function waitFor(what: string, done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A stand-in runner with no `ourod` at all, in its own data directory. */
async function startRunner(): Promise<{ root: string; dataDir: string; child: ChildProcess; exited: () => boolean }> {
  const root = mkdtempSync(join(tmpdir(), 'runner-test-'))
  const dataDir = join(root, 'data')
  for (const dir of [dataDir, join(root, 'state'), join(root, 'work')]) mkdirSync(dir)
  const journalPath = join(dataDir, 'journal.jsonl')
  const config: RunnerConfig = {
    agentId: 'agent-1', generation: 1, journalPath, socketPath: join(dataDir, 'runner.sock'), stateDir: join(root, 'state'),
    release: 'test', provider: 'stand_in', model: 'stand-in', folder: join(root, 'work'), resumeProviderSessionId: null, systemPrompt: 'test', env: {},
    secretEnvFiles: {},
    memoryDir: null,
    promptCacheTtlMs: null,
  }
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))
  const child = spawn(process.execPath, ['--no-warnings', runnerEntry, configPath], { stdio: 'ignore' })
  let hasExited = false
  child.on('exit', () => { hasExited = true })
  await waitFor('the runner to be ready', () => existsSync(journalPath) && readFileSync(journalPath, 'utf8').includes('runner_ready'), 15_000)
  return { root, dataDir, child, exited: () => hasExited }
}

test('a runner whose data directory is removed stops itself within seconds', async () => {
  const runner = await startRunner()
  try {
    rmSync(runner.dataDir, { recursive: true })
    await waitFor('the runner to leave', runner.exited, 10_000)
  } finally {
    runner.child.kill('SIGKILL')
    rmSync(runner.root, { recursive: true, force: true })
  }
})

test('a runner stays up with no ourod, as long as its journal exists: it survives ourod restarts', async () => {
  const runner = await startRunner()
  try {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    assert.equal(runner.exited(), false)
  } finally {
    runner.child.kill('SIGKILL')
    rmSync(runner.root, { recursive: true, force: true })
  }
})

test('a runner leaves on SIGTERM', async () => {
  const runner = await startRunner()
  try {
    runner.child.kill('SIGTERM')
    await waitFor('the runner to leave', runner.exited, 10_000)
  } finally {
    runner.child.kill('SIGKILL')
    rmSync(runner.root, { recursive: true, force: true })
  }
})
