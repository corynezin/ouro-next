// Agents in a git project, through the real server and runners: each works on its own branch in its own worktree, which
// merges back when it finishes or is archived. A conflict is reported and never forced; a done agent left quiet can be
// archived by itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AgentEntity } from '@ouro/contract'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

const run = new JourneyRun()
let phone: AppClient
let repo: string
before(async () => {
  await run.startServer()
  phone = await run.pairDevice()
  repo = join(run.dir, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'beds.txt'), 'tomatoes\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
})
after(() => run.cleanup())

const HOUR = 3_600_000
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const send = (to: string, text: string) => phone.command('send_message', { to, text, attachmentIds: [], wake: 'wake', answersAskId: null })
const commitFile = (file: string, text: string) => `printf '${text}\\n' > ${file} && git add ${file} && git commit -q -m "edit ${file}"`
const QUIET = standInScript({ do: 'text', text: 'ready' })

async function agentIn(name: string, folder: string): Promise<AgentEntity> {
  await phone.command('create_agent', { task: QUIET, name, model: null, folder })
  await waitFor(`${name} to go idle`, async () => (await phone.agent(name)).state.state === 'idle')
  return await phone.agent(name)
}

async function systemNotices(): Promise<string[]> {
  const snapshot = await phone.snapshot()
  const systemChat = snapshot.chats.find((chat) => chat.members.some((member) => member.address === 'system') && chat.members.some((member) => member.address === snapshot.viewer.address))
  if (!systemChat) return []
  return (await phone.history(systemChat.id)).messages.map((message) => message.text)
}

async function stateOf(agentId: string): Promise<AgentEntity> {
  const found = (await phone.snapshot()).agents.find((agent) => agent.id === agentId)
  assert.ok(found)
  return found
}

test('an agent works on its own branch, and done merges it into the main checkout', async () => {
  const agent = await agentIn('weeder', repo)
  const worktree = join(run.dir, '.garden.worktrees', 'weeder')
  assert.equal(agent.folder, worktree)
  assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/weeder')
  assert.deepEqual(agent.branch, { name: 'agent/weeder', base: 'main' })

  await send('weeder', standInScript({ do: 'run', command: commitFile('weeds.txt', 'pulled') }, { do: 'run', command: 'ouro done "weeded"' }))
  await waitFor('weeder to finish', async () => (await phone.agent('weeder')).state.state === 'done')
  await waitFor('the branch to merge', () => existsSync(join(repo, 'weeds.txt')))
  assert.equal(readFileSync(join(repo, 'weeds.txt'), 'utf8'), 'pulled\n')
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'edit weeds.txt')
  assert.deepEqual((await stateOf(agent.id)).branch, { name: 'agent/weeder', base: 'main' }, 'a done agent keeps its branch')
})

test('a conflict is reported to the parent and left in place; resolved by hand, ouro merge merges it', async () => {
  await agentIn('pepper', repo)
  const worktree = join(run.dir, '.garden.worktrees', 'pepper')
  writeFileSync(join(repo, 'beds.txt'), 'beans\n')
  git(repo, 'commit', '-q', '-am', 'beans on main')
  const mainBefore = git(repo, 'rev-parse', 'main')

  await send('pepper', standInScript({ do: 'run', command: commitFile('beds.txt', 'peppers') }, { do: 'run', command: 'ouro done "planted"' }))
  const notice = await waitFor('the person to hear of it', async () => (await systemNotices()).find((text) => text.startsWith('pepper\'s branch')) ?? null)
  assert.match(notice, /^pepper's branch agent\/pepper was not merged into main: rebasing it onto main conflicted:\n[\s\S]*\. It is left as it is: resolve it by hand, then ouro merge pepper\.$/)
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore, 'main is not touched')
  assert.equal(readFileSync(join(worktree, 'beds.txt'), 'utf8'), 'peppers\n', 'the agent\'s work is kept')

  git(worktree, 'reset', '-q', '--hard', 'main')
  writeFileSync(join(worktree, 'beds.txt'), 'beans\npeppers\n')
  git(worktree, 'commit', '-q', '-am', 'beans and peppers')
  assert.equal(await run.cli('merge', 'pepper'), 'merged agent/pepper into main (fast-forward)\n')
  assert.equal(readFileSync(join(repo, 'beds.txt'), 'utf8'), 'beans\npeppers\n')
  assert.equal(await run.cli('merge', 'pepper'), 'agent/pepper has nothing to merge into main\n')
})

test('archive merges the branch and removes the worktree; unarchived, the agent works in the main checkout', async () => {
  const agent = await agentIn('tidy', join(repo, 'shed'))
  const worktree = join(run.dir, '.garden.worktrees', 'tidy')
  assert.equal(agent.folder, join(worktree, 'shed'), 'a subfolder is kept')
  await send('tidy', `${standInScript({ do: 'run', command: `mkdir -p ${agent.folder} && cd ${agent.folder} && ${commitFile('tools.txt', 'rake')}` })}`)
  await waitFor('tidy to commit', () => git(worktree, 'log', '-1', '--format=%s') === 'edit tools.txt')
  await waitFor('tidy to go idle', async () => (await phone.agent('tidy')).state.state === 'idle')

  await phone.command('archive_agent', { agentId: agent.id })
  await waitFor('the folder to move back to the main checkout', async () => (await stateOf(agent.id)).folder === join(repo, 'shed'))
  assert.equal(existsSync(worktree), false, 'the worktree is gone')
  assert.equal(readFileSync(join(repo, 'shed', 'tools.txt'), 'utf8'), 'rake\n')
  assert.equal(git(repo, 'branch', '--list', 'agent/tidy'), '', 'the merged branch is gone')
  assert.equal((await stateOf(agent.id)).branch, null)

  await phone.command('unarchive_agent', { agentId: agent.id })
  assert.equal((await stateOf(agent.id)).folder, join(repo, 'shed'))
})

test('auto-archive, once on, archives an agent that finished and stayed quiet, and says so', async () => {
  for (const name of ['weeder', 'pepper']) await phone.command('archive_agent', { agentId: (await phone.agent(name)).id })
  const plainFolder = join(run.dir, 'plain')
  mkdirSync(plainFolder)
  const agent = await agentIn('brief', plainFolder)
  assert.equal(agent.branch, null, 'outside a git project it works in the folder itself')
  await send('brief', standInScript({ do: 'run', command: 'ouro done "all clear"' }))
  await waitFor('brief to finish', async () => (await phone.agent('brief')).state.state === 'done')
  const { server } = await phone.command('set_auto_archive', { afterHours: 1 })
  assert.equal(server.limits.autoArchiveAfterHours, 1)

  // Its report is still unread, so it stays.
  run.advanceClock(2 * HOUR)
  await new Promise((done) => setTimeout(done, 1500))
  assert.equal((await stateOf(agent.id)).state.state, 'done')

  const chatId = await phone.directChatWith('brief')
  const readThroughSeq = Math.max(...(await phone.history(chatId)).messages.map((message) => message.seq))
  await phone.command('mark_chat_read', { chatId, readThroughSeq })
  await waitFor('brief to be archived', async () => (await stateOf(agent.id)).state.state === 'archived')
  assert.ok((await systemNotices()).includes('Auto-archived brief: done, and quiet for over 1 h. Unarchive it to bring it back.'))
})
