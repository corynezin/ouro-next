// A replacement server that is slow to start is starting, not down: the guardian waits out its cold-start grace before
// it counts an outage, so a loaded machine doesn't spend or refuse a restart over a server that is only slow.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { GuardianRun } from './guardian-harness.ts'
import { waitFor } from './harness.ts'

// The start is slow enough that, counted from the crash, it would be a sustained outage: only the grace keeps it from
// being judged down. After the grace, the server's own start (Node's included) has 3 s to spare before the outage would
// be sustained; with 1.5 s windows a loaded machine used up the 1.2 s it had and was judged down.
const run = new GuardianRun({ timing: { coldStartGraceMs: 6_000, sustainedOutageMs: 6_000 } })
const START_DELAY_MS = run.timing.coldStartGraceMs + 3_000

before(async () => {
  await run.createSource()
  run.editSource('server/src/bin/ourod.ts', 'const core = new OuroCore({', `// A slow machine.\nawait new Promise((done) => setTimeout(done, ${START_DELAY_MS}))\nconst core = new OuroCore({`)
  await run.commitAll('a server that takes a while to start')
  await run.start()
  const first = await run.waitForFirstRelease()
  assert.equal(first.phase, 'live', `the first release didn't go live: ${first.reason}`)
})
after(() => run.cleanup())

const events = (output: string, name: string) => output.split(`"event":"${name}"`).length - 1

test('after a crash, a replacement slower than the grace comes back without being judged down', async () => {
  const before = await run.status()
  const outputBefore = run.output.length
  process.kill(before.ourodPid!, 'SIGKILL')
  const restarted = await waitFor('the replacement', async () => {
    const status = await run.status()
    return status.ourodPid !== null && status.ourodPid !== before.ourodPid ? status : null
  }, 20_000)
  await waitFor('it to serve', async () => (await fetch(`${run.url}/v2/identity`).catch(() => null))?.status === 200, 20_000)
  // Watch a while longer than grace plus a sustained outage.
  await new Promise((done) => setTimeout(done, run.timing.coldStartGraceMs + run.timing.sustainedOutageMs + 1_000))

  const since = run.output.slice(outputBefore)
  assert.equal(events(since, 'restarting'), 1, 'one restart, for the crash')
  assert.equal(events(since, 'restart_refused'), 0, 'the slow start was never judged an outage')
  assert.equal((await run.status()).ourodPid, restarted.ourodPid, 'the replacement kept running')
})
