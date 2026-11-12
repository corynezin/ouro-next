import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeTranscriptPathOf, conversationFilesOf, installConversation, rewriteRanIn } from './conversations.ts'

const root = mkdtempSync(join(tmpdir(), 'ouro-conversations-'))
after(() => rmSync(root, { recursive: true, force: true }))

test("a Claude Code conversation moves to the new folder's project and says it ran there", () => {
  const from = { agentStateDir: join(root, 'a-state'), claudeConfigDir: join(root, 'a-claude') }
  const to = { agentStateDir: join(root, 'b-state'), claudeConfigDir: join(root, 'b-claude') }
  const project = join(from.claudeConfigDir, 'projects', '-work-app')
  mkdirSync(join(project, 'session-1', 'subagents'), { recursive: true })
  writeFileSync(join(project, 'session-1.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/work/app' })}\n${JSON.stringify({ type: 'user', cwd: '/work/app/sub' })}\n`)
  writeFileSync(join(project, 'session-1', 'subagents', 'agent-x.jsonl'), 'kept as it is\n')

  const files = conversationFilesOf('claude_code', 'session-1', '/work/app', from)!
  assert.deepEqual(files.map((file) => file.path), [join('projects', '-work-app', 'session-1.jsonl'), join('projects', '-work-app', 'session-1', 'subagents', 'agent-x.jsonl')])
  installConversation('claude_code', { providerSessionId: 'session-1', ranIn: '/work/app', files }, '/home/b/app', to)

  const moved = join(to.claudeConfigDir, 'projects', '-home-b-app')
  const lines = readFileSync(join(moved, 'session-1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cwd: string })
  assert.deepEqual(lines.map((line) => line.cwd), ['/home/b/app', '/home/b/app/sub'])
  assert.equal(readFileSync(join(moved, 'session-1', 'subagents', 'agent-x.jsonl'), 'utf8'), 'kept as it is\n')
})

test('a missing conversation, or a Codex one, is not carried', () => {
  const stores = { agentStateDir: join(root, 'none'), claudeConfigDir: join(root, 'none') }
  assert.equal(conversationFilesOf('claude_code', 'gone', '/work', stores), null)
  assert.equal(conversationFilesOf('stand_in', 'gone', '/work', stores), null)
  assert.equal(conversationFilesOf('codex', 'thread', '/work', stores), null)
})

test('only folders at or under the old one are rewritten', () => {
  assert.equal(rewriteRanIn('{"cwd":"/work/application"}', '/work/app', '/b'), '{"cwd":"/work/application"}')
  assert.equal(rewriteRanIn('not json "cwd"', '/work/app', '/b'), 'not json "cwd"')
})

test('a file path that would leave its store is refused', () => {
  const stores = { agentStateDir: join(root, 'c-state'), claudeConfigDir: join(root, 'c-claude') }
  assert.throws(() => installConversation('stand_in', { providerSessionId: 's', ranIn: '/w', files: [{ path: '../../escape', content: Buffer.from('x') }] }, '/w', stores))
})

test('a session id that could name a file outside the projects folder has no transcript path', () => {
  assert.equal(claudeTranscriptPathOf('/c', 'a1b2-c3', '/w'), '/c/projects/-w/a1b2-c3.jsonl')
  for (const sessionId of ['../../secrets', 'a/b', '', '..']) assert.equal(claudeTranscriptPathOf('/c', sessionId, '/w'), null, sessionId)
  assert.equal(conversationFilesOf('claude_code', '../escape', '/w', { agentStateDir: '/s', claudeConfigDir: '/c' }), null)
})
