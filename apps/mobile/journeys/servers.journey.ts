// Several servers: Servers counts the unread on one that isn't open, from that server.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { OtherServersUnread } from '../src/core/servers/otherServersUnread.ts'
import { agentUnreadTotal } from '../src/features/shared/agentFacts.ts'
import { JourneyRun, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test("Servers counts the unread on a server that isn't open, from that server, and leaves the open one out", async () => {
  const first = new JourneyRun()
  const second = new JourneyRun()
  runs.push(first, second)
  await Promise.all([first.startServer(), second.startServer()])
  const { phone, session } = await pairedPhone(first)
  try {
    const created = await session.command('create_agent', { task: 'hello there', name: 'dave', model: null, folder: null })
    assert.ok(created.ok, created.ok ? '' : JSON.stringify(created.failure))
    await waitFor("dave's reply, unread", () => agentUnreadTotal(session.store) > 0)
    const unreadOnFirst = agentUnreadTotal(session.store)
    const firstId = session.serverId

    const code = /code: (\S+)/.exec(await second.cli('pair'))![1]!
    const secondServer = await phone.pairAndActivate(second.url, code)
    const unread = new OtherServersUnread({ core: phone, unreadOf: agentUnreadTotal })
    await unread.checkIfDue()
    assert.deepEqual([...unread.counts], [[firstId, unreadOnFirst]])
    assert.equal(unread.counts.has(secondServer.id), false)
  } finally {
    phone.activeSession?.dispose()
  }
})
