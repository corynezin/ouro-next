// Agents' memory through the real server and runners: one memory per project at any checkout of it, personal notes
// reaching agents in other projects, none outside git, and Claude Code pointed at the project's memory with its hooks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let run: JourneyRun
let phone: AppClient
let recordPath: string

before(async () => {
  run = new JourneyRun()
  recordPath = join(run.dir, 'claude-launches.jsonl')
  const fakeClaude = join(run.dir, 'claude')
  writeFileSync(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${resolve(import.meta.dirname, 'fake-claude.ts')}" "$@"\n`)
  chmodSync(fakeClaude, 0o755)
  run.addServerEnv({ OURO_AGENT_ENV_JSON: JSON.stringify({ OURO_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_RECORD: recordPath, OURO_CLI_RETRY_MS: '60000' }) })
  await run.startServer()
  phone = await run.pairDevice()
})
after(() => run.cleanup())

function checkout(name: string, origin: string | null): string {
  const folder = join(run.dir, name)
  mkdirSync(folder, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'j', GIT_AUTHOR_EMAIL: 'j@j', GIT_COMMITTER_NAME: 'j', GIT_COMMITTER_EMAIL: 'j@j' } })
  git('init', '-q')
  if (origin) git('remote', 'add', 'origin', origin)
  git('commit', '-q', '--allow-empty', '-m', 'first')
  return folder
}

/** Starts a stand-in agent whose task runs `command`, and answers what it replied. */
async function replyOf(name: string, folder: string, command: string): Promise<string> {
  await phone.command('create_agent', { task: standInScript({ do: 'run', command }), name, model: 'stand-in', folder })
  let reply = ''
  await waitFor(`${name}'s reply`, async () => {
    const answer = (await phone.conversation(name)).find((message) => message.from === name)
    reply = answer?.text ?? ''
    return answer !== undefined
  }, 30_000)
  return reply
}

const note = (lines: string[]) => `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}`

test('checkouts of one project share its memory; a personal note reaches agents in other projects, its other notes stay', async () => {
  const first = checkout('agents-first', 'git@github.com:example/agents.git')
  const second = checkout('agents-second', 'https://github.com/example/agents')
  const other = checkout('website', 'git@github.com:example/website.git')

  const writer = await replyOf('writer', first, [
    `${note(['---', 'name: Tea', 'description: what the person drinks', 'type: user', '---', 'green tea, no sugar'])} > "$OURO_MEMORY_DIR/tea.md"`,
    `${note(['---', 'name: Build', 'type: project', '---', 'run make'])} > "$OURO_MEMORY_DIR/build.md"`,
    'ouro memory sync',
    'ouro reply "$OURO_MEMORY_DIR"',
  ].join(' && '))
  assert.equal(writer, join(run.dataDir, 'memory', 'projects', 'github.com+example+agents'))

  const twin = await replyOf('twin', second, 'ouro reply "$OURO_MEMORY_DIR: $(tail -n 1 "$OURO_MEMORY_DIR/build.md")"')
  assert.equal(twin, `${writer}: run make`, "the other checkout's agent has the project's memory")

  const elsewhere = await replyOf('elsewhere', other, 'ouro reply "$(tail -n 1 "$OURO_MEMORY_DIR/tea.md"); build: $(ls "$OURO_MEMORY_DIR" | grep -c build.md)"')
  assert.equal(elsewhere, 'green tea, no sugar; build: 0', 'the personal note is there, the project note is not')
  assert.match(readFileSync(join(run.dataDir, 'memory', 'projects', 'github.com+example+website', 'MEMORY.md'), 'utf8'), /\[Tea\]\(tea\.md\) — what the person drinks/)
})

test('a folder outside git has no project memory', async () => {
  // Not under the run's folder, which may itself be inside a checkout.
  const plain = mkdtempSync(join(tmpdir(), 'ouro-plain-'))
  try {
    assert.equal(await replyOf('loose', plain, 'ouro reply "memory: ${OURO_MEMORY_DIR:-none}"'), 'memory: none')
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test("Claude Code is pointed at the project's memory, with the hooks that sync it", async () => {
  const folder = checkout('claude-project', 'git@github.com:example/claude-project.git')
  await phone.command('create_agent', { task: 'work', name: 'on-claude', model: 'sonnet', folder })
  await waitFor('a launch recorded', async () => existsSync(recordPath), 30_000)
  const { args } = JSON.parse(readFileSync(recordPath, 'utf8').trim().split('\n').at(-1)!) as { args: string[] }
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { autoMemoryDirectory: string; hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }
  assert.equal(settings.autoMemoryDirectory, join(run.dataDir, 'memory', 'projects', 'github.com+example+claude-project'))
  assert.equal(settings.hooks.SessionStart?.[0]?.hooks[0]?.command, 'ouro memory sync --hook')
  assert.equal(settings.hooks.PostToolUse?.[0]?.matcher, 'Write|Edit|MultiEdit')
})
