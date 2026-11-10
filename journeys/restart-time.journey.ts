// A long start-up that grew with history once caused a real outage. Startup must not read history.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { seedHistory } from '../tools/seed-history.ts'
import { JourneyRun, waitFor } from './harness.ts'

const SEEDED_MESSAGES = 300_000

const run = new JourneyRun()
after(() => run.cleanup())

/**
 * The server's own time from its first line to listening, which covers opening the database, finding agents again and
 * the first scheduler pass, and leaves out Node's own start, which only adds machine noise. The median of a few starts.
 */
async function startupWorkMs(starts: number): Promise<{ medianMs: number; samples: number[]; wallMs: number[] }> {
  const samples: number[] = []
  const wallMs: number[] = []
  for (let index = 0; index < starts; index++) {
    const started = await run.startServer()
    samples.push(started.listening.elapsedMs)
    wallMs.push(started.wallMs)
    if (index < starts - 1) await run.killServer('SIGKILL')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)]!, samples, wallMs }
}

/**
 * Reading 300,000 messages costs over a second on the machines this runs on, so a startup that touched history would
 * blow far past this margin, while scheduling noise stays well inside it.
 */
const ALLOWED_GROWTH_MS = 100

test('restart time does not grow with history', async () => {
  await run.startServer()
  const phone = await run.pairDevice()
  await run.killServer('SIGKILL')

  const empty = await startupWorkMs(3)
  await run.killServer('SIGKILL')
  seedHistory(run.dataDir, SEEDED_MESSAGES, Date.now())
  const seeded = await startupWorkMs(3)

  console.log(`startup work, median of 3: ${empty.medianMs} ms empty ${JSON.stringify(empty.samples)}, ${seeded.medianMs} ms with ${SEEDED_MESSAGES} messages ${JSON.stringify(seeded.samples)}; launch to first answer ${JSON.stringify(empty.wallMs)} and ${JSON.stringify(seeded.wallMs)} ms`)
  assert.ok(seeded.medianMs <= empty.medianMs + ALLOWED_GROWTH_MS, `startup work took ${seeded.medianMs} ms ${JSON.stringify(seeded.samples)} with history against ${empty.medianMs} ms ${JSON.stringify(empty.samples)} without`)

  // It really is serving that history, in pages, and new work still flows.
  const snapshot = await phone.snapshot()
  const seededChat = snapshot.chats.find((chat) => chat.title === 'seeded')!
  const page = await phone.history(seededChat.id, undefined, 20)
  assert.equal(page.messages.length, 20)
  assert.equal(page.hasOlder, true)
  assert.equal(page.messages.at(-1)?.text, `seeded message ${SEEDED_MESSAGES - 1}`)

  await phone.command('create_agent', { task: 'hello', name: 'after-seed', model: null, folder: null })
  await waitFor('a reply', async () => (await phone.conversation('after-seed')).some((message) => message.from === 'after-seed'))
})
