import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { holdJourneyLock, processStartOf } from './journey-lock.ts'
import type { JourneyLockHolder } from './journey-lock.ts'

const dir = mkdtempSync(join(tmpdir(), 'journey-lock-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const lockModule = join(import.meta.dirname, 'journey-lock.ts')

/**
 * Another process that takes the lock, says so, holds it for `holdMs`, and exits. `lettingGoAt` is the time it wrote just
 * before letting go, from inside it: the lock is free from then, a little before its parent hears it exit.
 */
function otherHolder(path: string, holdMs: number): Promise<{ pid: number; exited: Promise<void>; lettingGoAt: Promise<number> }> {
  // Registered before the lock's own exit handler, so it runs first.
  const script = `import { writeSync } from 'node:fs'
import { holdJourneyLock } from ${JSON.stringify(lockModule)}
process.once('exit', () => writeSync(1, 'letting go at ' + Date.now() + '\\n'))
await holdJourneyLock({ path: ${JSON.stringify(path)}, pollMs: 20, onWait: () => {} })
process.stdout.write('held\\n')
setTimeout(() => process.exit(0), ${holdMs})`
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  // 'close', not 'exit': by then everything it wrote has been read.
  const exited = new Promise<void>((done) => child.on('close', () => done()))
  const lettingGoAt = exited.then(() => Number(/letting go at (\d+)/.exec(output)![1]))
  return new Promise((held) => child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes('held')) held({ pid: child.pid!, exited, lettingGoAt })
  }))
}

test('a second journey process waits until the holder exits, and is told who holds it', async () => {
  const path = join(dir, 'busy.lock')
  const other = await otherHolder(path, 400)
  const waitedFor: (JourneyLockHolder | null)[] = []
  await holdJourneyLock({ path, pollMs: 20, onWait: (holder) => waitedFor.push(holder) })
  const heldAt = Date.now()
  assert.ok(heldAt >= await other.lettingGoAt, 'not before the holder let go')
  assert.equal(waitedFor[0]?.pid, other.pid)
  assert.equal((JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as JourneyLockHolder).pid, process.pid)
})

test('the holder lets go when it exits', async () => {
  const path = join(dir, 'released.lock')
  const other = await otherHolder(path, 0)
  await other.exited
  assert.ok(!existsSync(path))
})

test("a lock whose holder is gone is taken over at once", async () => {
  const path = join(dir, 'gone.lock')
  const gonePid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString()
  mkdirSync(path)
  writeFileSync(join(path, 'holder.json'), JSON.stringify({ pid: Number(gonePid), command: 'killed journey', since: 1 }))
  await holdJourneyLock({ path, pollMs: 20, onWait: () => assert.fail('it should not wait') })
  assert.equal((JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as JourneyLockHolder).pid, process.pid)
})

test('a lock made but never described is taken over once it is stale', async () => {
  const path = join(dir, 'undescribed.lock')
  mkdirSync(path)
  const longAgo = new Date(Date.now() - 60_000)
  utimesSync(path, longAgo, longAgo)
  await holdJourneyLock({ path, pollMs: 20, onWait: () => assert.fail('it should not wait') })
  assert.equal((JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as JourneyLockHolder).pid, process.pid)
})

/** A live process that isn't any lock's holder, as a pid given out again would be. */
function bystander(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  return { pid: child.pid!, stop: () => child.kill('SIGKILL') }
}

test("a live process with the gone holder's pid but another start time doesn't hold the lock", async () => {
  const path = join(dir, 'reused.lock')
  const other = bystander()
  try {
    const start = processStartOf(other.pid)
    assert.ok(start, 'this system tells when a process started')
    mkdirSync(path)
    writeFileSync(join(path, 'holder.json'), JSON.stringify({ pid: other.pid, processStart: `before ${start}`, command: 'killed journey', since: 1 }))
    await holdJourneyLock({ path, pollMs: 20, onWait: () => assert.fail('it should not wait') })
    assert.equal((JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as JourneyLockHolder).pid, process.pid)
  } finally {
    other.stop()
  }
})

test('a holder alive with the start time it recorded keeps the lock', async () => {
  const path = join(dir, 'kept.lock')
  const holder = bystander()
  const waits: (JourneyLockHolder | null)[] = []
  try {
    mkdirSync(path)
    writeFileSync(join(path, 'holder.json'), JSON.stringify({ pid: holder.pid, processStart: processStartOf(holder.pid), command: 'running journey', since: 1 }))
    const taking = holdJourneyLock({ path, pollMs: 20, onWait: (seen) => waits.push(seen) })
    await new Promise((settle) => setTimeout(settle, 300))
    assert.equal(waits[0]?.pid, holder.pid, 'it waits for the holder')
    assert.equal((JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as JourneyLockHolder).pid, holder.pid)
    holder.stop()
    await taking
  } finally {
    holder.stop()
  }
})

test("a process's start time is the same on every reading, and none for a pid that is gone", () => {
  assert.equal(processStartOf(process.pid), processStartOf(process.pid))
  const gonePid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString())
  assert.equal(processStartOf(gonePid), null)
})
