// Merge branch against the real server: an agent in a git project works on its own branch, and the phone merges it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { directSend } from '../src/features/chat/model.ts'
import { branchMergeText, detailsModel } from '../src/features/details/model.ts'
import { JourneyRun, standInScript, waitFor } from '../../../journeys/harness.ts'
import { cleanUp, pairedPhone, runs } from './support.ts'

after(cleanUp)

test('Merge branch: a stopped agent in a git project offers Merge from its details, and says what merging did', async () => {
  const run = new JourneyRun()
  runs.push(run)
  await run.startServer()
  const { phone, session } = await pairedPhone(run)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    const repo = join(run.dir, 'garden')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    const created = await session.command('create_agent', { task: 'ready', name: 'frank', model: null, folder: repo })
    assert.ok(created.ok)
    const agentId = created.value.agent.id
    await waitFor('frank idle', () => session.store.agents.get(agentId)?.state.state === 'idle', 20_000)
    const details = () => detailsModel(session.store, session.store.agents.get(agentId)!, Date.now())
    assert.equal(details().rows.find((row) => row.label === 'Branch')?.value, 'agent/frank → main')
    assert.equal(details().mergeable, null, 'not while it runs')

    const commit = standInScript({ do: 'run', command: 'echo pulled > weeds.txt && git add weeds.txt && git commit -q -m "edit weeds.txt"' })
    session.outbox.send(directSend(session.store.agents.get(agentId)!, commit, [], null))
    const worktree = session.store.agents.get(agentId)!.folder
    await waitFor('the commit on its branch', () => git(worktree, 'log', '-1', '--format=%s') === 'edit weeds.txt', 20_000)
    assert.equal(await session.commandError('stop_agent', { agentId }), null)
    const mergeable = await waitFor('Merge offered once stopped', () => details().mergeable, 20_000)
    assert.deepEqual(mergeable, { branch: 'agent/frank', base: 'main' })

    // The button, as the screen sends it.
    const merged = await session.command('merge_agent_branch', { agentId })
    assert.ok(merged.ok)
    assert.equal(branchMergeText(merged.value.merge), 'Merged agent/frank into main.')
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'edit weeds.txt')
    const again = await session.command('merge_agent_branch', { agentId })
    assert.ok(again.ok)
    assert.equal(branchMergeText(again.value.merge), 'Nothing to merge: main already has agent/frank.')
  } finally {
    phone.activeSession?.dispose()
  }
})
