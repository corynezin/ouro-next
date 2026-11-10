// Plan usage against the real server: a turn's plan report reaches the list's line, Settings and the agent's details.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { agentsListModel } from '../src/features/agents/model.ts'
import { directSend } from '../src/features/chat/model.ts'
import { detailsModel } from '../src/features/details/model.ts'
import { planWindowRows } from '../src/features/shared/planUsage.ts'
import { JourneyRun, standInScript, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test("Plan usage: a turn's report shows on the list's line, in Settings, and as the agent's share in its details", async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  try {
    const created = await session.command('create_agent', { task: 'ready', name: 'erin', model: null, folder: null })
    assert.ok(created.ok)
    const agentId = created.value.agent.id
    await waitFor('erin idle', () => session.store.agents.get(agentId)?.state.state === 'idle', 20_000)
    const resetsAt = Date.now() + 3 * 3_600_000
    const report = standInScript({ do: 'cost', usd: 2 }, { do: 'plan_usage', windows: [
      { windowMinutes: 300, usedFraction: 0.2, resetsAt, status: 'allowed' },
      { windowMinutes: 10_080, usedFraction: 0.07, resetsAt: resetsAt + 86_400_000, status: 'allowed' },
    ] })
    const line = () => agentsListModel(session.store, { connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now() }).usageLine
    await waitFor('no reading before the first report', () => line() === 'Claude: no reading yet', 20_000)
    session.outbox.send(directSend(session.store.agents.get(agentId)!, `work\n${report}`, [], null))

    await waitFor("the plan on the list's line", () => line() === 'Claude: 7%', 20_000)
    const rows = planWindowRows(session.store.server!.planUsage.claude!, Date.now())
    assert.deepEqual(rows.map((row) => row.label), ['5-hour', 'Weekly'])
    assert.match(rows[0]!.valueText, /^20% \(resets .+\)$/)
    assert.match(rows[1]!.valueText, /^7% \(resets .+\)$/)

    const usage = () => detailsModel(session.store, session.store.agents.get(agentId)!, Date.now()).rows.find((row) => row.label === 'Usage')?.value
    await waitFor('its share in its details', () => usage() === '~20% of 5h · ~7% of 7d', 20_000)
    const listed = agentsListModel(session.store, { connection: session.connection, fold: { kind: 'never' }, query: '', failureNote: null, now: Date.now() })
    const listedRow = [...listed.awake, ...listed.idle].find((row) => row.kind === 'local' && row.row.agentId === agentId)
    assert.ok(listedRow?.kind === 'local')
    assert.equal(listedRow.row.costText, null, 'on the plan, no dollars on its row')
  } finally {
    phone.activeSession?.dispose()
  }
})
