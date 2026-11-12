// Work on a Sprite runs as jobs: a script started detached that writes its exit status to a file, which is polled. A job
// outlives the request that started it and a restart of whoever started it; a job started again waits for the one before
// it. A Sprite with no session open pauses, freezing a detached job, so each job holds its Sprite awake through the
// Sprite's Tasks API while it runs.
import type { SpritesApi } from './api.ts'

/** The Tasks API's socket, on every Sprite. */
export const SPRITE_TASKS_SOCKET = '/.sprite/api.sock'
/** A hold lasts 5 minutes unless renewed. */
export const HOLD_RENEW_SECONDS = 60

/**
 * `launch <job> <tasks socket> <renew seconds>` starts `<job>.sh` detached and returns at once. The job takes
 * `<job>.lock` before it runs, so one started again waits for the earlier one. While it runs it holds the Sprite awake
 * as the task `<taskPrefix><job name>`, renewed on the interval and let go at the end, and it writes `<job>.exit` only
 * when it has ended. The renewer finishes a hold it has begun before it stops, so no hold lands after the let-go.
 * Before it returns, the launcher itself holds the Sprite for 5 minutes as `<taskPrefix><job name>-launch`: a new Sprite
 * pauses as soon as the session that launched the job ends, which can be before the detached job's first hold lands,
 * and the job then stays frozen until something wakes the Sprite. That hold just expires.
 *
 * `taskPrefix` keeps the hub's tasks (`ouro-hub-`) and a server's (`ouro-made-`) apart; it must be shell-safe.
 */
export const spriteLauncher = (taskPrefix: string): string => {
  if (!/^[a-z0-9-]+$/.test(taskPrefix)) throw new Error(`a task prefix is lowercase letters, digits and hyphens, not ${JSON.stringify(taskPrefix)}`)
  return String.raw`rm -f "$1.exit" "$1.out"
curl -sS --max-time 20 --unix-socket "$2" -X PUT -H "content-type: application/json" -d "{\"expire\":\"5m\"}" "http://sprite/v1/tasks/${taskPrefix}$(basename "$1")-launch" > /dev/null 2>&1 || true
setsid bash -c '
exec 9>"$0.lock"; flock 9
task="http://sprite/v1/tasks/${taskPrefix}$(basename "$0")"
hold() { curl -sS --max-time 20 --unix-socket "$1" -X PUT -H "content-type: application/json" -d "{\"expire\":\"5m\"}" "$task" > /dev/null 2>&1; }
hold "$@"
(trap exit TERM; while sleep "$2" & wait $!; do hold "$@"; done) & renewer=$!
bash "$0.sh" > "$0.log" 2>&1; status=$?
kill "$renewer"; wait "$renewer"
curl -sS --unix-socket "$1" -X DELETE "$task" > /dev/null 2>&1
echo "$status" > "$0.exit.partial"; mv "$0.exit.partial" "$0.exit"' "$1" "$2" "$3" < /dev/null > /dev/null 2>&1 &`
}

/** How a job ended: `logTail` is the end of its output, for saying why. */
export type SpriteJobOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; status: number; logTail: string }
  | { kind: 'timed_out'; logTail: string }

/** The end of a job's log kept for a failure. */
const LOG_TAIL_CHARS = 1500

/**
 * Writes `<path>.sh`, launches it with the launcher, and polls `<path>.exit` until it ends or `deadlineMs` passes. What
 * a failure means is the caller's to say.
 */
export async function runSpriteJob(job: {
  api: SpritesApi; sprite: string; path: string; script: string; launcher: string; deadlineMs: number; pollIntervalMs: number
}): Promise<SpriteJobOutcome> {
  const { api, sprite, path } = job
  const logTail = async () => {
    const log = await api.readFile(sprite, `${path}.log`).catch(() => null)
    return log ? log.toString('utf8').slice(-LOG_TAIL_CHARS) : ''
  }
  await api.writeFile(sprite, `${path}.sh`, Buffer.from(job.script), '0755')
  await api.exec(sprite, ['bash', '-c', job.launcher, 'launch', path, SPRITE_TASKS_SOCKET, String(HOLD_RENEW_SECONDS)])
  const deadline = Date.now() + job.deadlineMs
  for (;;) {
    const exit = await api.readFile(sprite, `${path}.exit`)
    if (exit) {
      const status = Number(exit.toString('utf8').trim())
      return status === 0 ? { kind: 'succeeded' } : { kind: 'failed', status, logTail: await logTail() }
    }
    if (Date.now() >= deadline) return { kind: 'timed_out', logTail: await logTail() }
    await new Promise((done) => setTimeout(done, job.pollIntervalMs))
  }
}
