// One journey process at a time on a machine. Each journey file starts real servers, runners and guardians, and two at
// once have run a shared machine out of memory. The journey harness takes this lock when a journey file loads it and
// holds it until that process exits; any other journey process on the machine waits. The lock is a directory, made
// atomically, with the holder's description in it. A lock whose holder is gone (killed, or pruned) is taken over. Its pid
// alone can't say so: once it is gone the system may give the pid to another process, so the holder's start time is kept
// with it, and a live pid that started at another time is someone else.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Per machine: every checkout and every user of the machine's temporary directory shares it. */
export const MACHINE_JOURNEY_LOCK = join(tmpdir(), 'ouro-rebirth-journey.lock')

/** A holder that made the directory but hasn't described itself within this long died in between. */
const UNDESCRIBED_HOLDER_GRACE_MS = 10_000

export interface JourneyLockHolder {
  pid: number
  /** When the process with this pid started, as `processStartOf` says; null where it couldn't be told. */
  processStart: string | null
  command: string
  since: number
}

/**
 * When a running process started, as the system tells it: on Linux its start in clock ticks since boot (field 22 of
 * /proc/<pid>/stat), elsewhere what `ps -o lstart` prints. Only compared with another reading on the same machine. Null
 * when the process is gone or the system won't say.
 */
export function processStartOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // The command name, field 2, is in parentheses and may hold spaces or parentheses itself: count from after it.
      const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return afterName[22 - 3] ?? null
    }
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return started === '' ? null : started
  } catch {
    return null
  }
}

export interface JourneyLockOptions {
  path: string
  pollMs: number
  /** Called while waiting: at the first wait, then about once a minute. */
  onWait: (holder: JourneyLockHolder | null) => void
}

/** Resolves once this process holds the lock. It is let go when the process exits. */
export async function holdJourneyLock(options: JourneyLockOptions): Promise<void> {
  let lastToldAt = 0
  for (;;) {
    if (tryTake(options.path)) return
    const holder = holderOf(options.path)
    if (holderIsGone(options.path, holder)) {
      takeOverFromGoneHolder(options.path, holder)
      continue
    }
    if (Date.now() - lastToldAt >= 60_000) {
      options.onWait(holder)
      lastToldAt = Date.now()
    }
    await new Promise((wait) => setTimeout(wait, options.pollMs))
  }
}

function tryTake(path: string): boolean {
  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  const holder: JourneyLockHolder = { pid: process.pid, processStart: processStartOf(process.pid), command: process.argv.slice(1).join(' '), since: Date.now() }
  writeFileSync(join(path, 'holder.json'), JSON.stringify(holder))
  process.once('exit', () => letGo(path))
  return true
}

/** Only this process's own lock: a takeover may have given the path to another. */
function letGo(path: string): void {
  if (holderOf(path)?.pid === process.pid) rmSync(path, { recursive: true, force: true })
}

function holderOf(path: string): JourneyLockHolder | null {
  try {
    const described = JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8')) as Omit<JourneyLockHolder, 'processStart'> & { processStart?: string | null }
    // A lock taken before start times were kept says nothing of its holder's.
    return { ...described, processStart: described.processStart ?? null }
  } catch {
    return null
  }
}

function holderIsGone(path: string, holder: JourneyLockHolder | null): boolean {
  if (holder === null) {
    const madeAt = mtimeOf(path)
    return madeAt !== null && Date.now() - madeAt > UNDESCRIBED_HOLDER_GRACE_MS
  }
  try {
    process.kill(holder.pid, 0)
  } catch (error) {
    // EPERM: it exists, as another user's process.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  return pidReused(holder)
}

/** The pid is alive, but its process started at another time than the holder's: the holder is gone. */
function pidReused(holder: JourneyLockHolder): boolean {
  if (holder.processStart === null) return false
  const now = processStartOf(holder.pid)
  return now !== null && now !== holder.processStart
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * A rename is atomic, so of several waiters only one moves the gone holder's lock aside; then all race to take it. A
 * waiter that judged an earlier lock gone may move aside one just taken by another: it sees whose it moved, and puts
 * a live holder's lock back.
 */
function takeOverFromGoneHolder(path: string, judgedGone: JourneyLockHolder | null): void {
  const aside = `${path}.gone-${process.pid}-${Date.now()}`
  try {
    renameSync(path, aside)
  } catch {
    return
  }
  const moved = holderOf(aside)
  const movedTheJudgedOne = moved?.pid === judgedGone?.pid && moved?.since === judgedGone?.since
  if (!movedTheJudgedOne && !holderIsGone(aside, moved)) {
    try {
      renameSync(aside, path)
      return
    } catch {
      // Taken again meanwhile: the live holder carries on without its directory, and lets go of nothing on exit.
    }
  }
  rmSync(aside, { recursive: true, force: true })
}
