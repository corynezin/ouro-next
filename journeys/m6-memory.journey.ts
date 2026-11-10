// Memory across the person's computers, through two real servers: notes about the person and a project's shared notes
// reach the other fully trusted computer, edits and deletes go either way, and a computer trusted only to message
// shares no memory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JourneyRun, standInScript, waitFor } from './harness.ts'
import type { AppClient } from './harness.ts'

let alpha: JourneyRun
let beta: JourneyRun
let alphaPhone: AppClient
let betaPhone: AppClient

before(async () => {
  alpha = new JourneyRun()
  beta = new JourneyRun()
  alpha.addServerEnv({ OURO_MACHINE_NAME: 'alpha', OURO_PEER_MEMORY_PULL_MS: '300' })
  beta.addServerEnv({ OURO_MACHINE_NAME: 'beta', OURO_PEER_MEMORY_PULL_MS: '300' })
  await Promise.all([alpha.startServer(), beta.startServer()])
  alphaPhone = await alpha.pairDevice()
  betaPhone = await beta.pairDevice()
  const invite = await alphaPhone.command('create_computer_invite', {})
  await betaPhone.command('join_computer', { address: alpha.url, code: invite.command.split(' ').at(-1)! })
})
after(async () => {
  await alpha.cleanup()
  await beta.cleanup()
})

function checkout(run: JourneyRun, name: string, origin: string): string {
  const folder = join(run.dir, name)
  mkdirSync(folder, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'j', GIT_AUTHOR_EMAIL: 'j@j', GIT_COMMITTER_NAME: 'j', GIT_COMMITTER_EMAIL: 'j@j' } })
  git('init', '-q')
  git('remote', 'add', 'origin', origin)
  git('commit', '-q', '--allow-empty', '-m', 'first')
  return folder
}

/** A stand-in agent whose task runs `command` in `folder`; resolves once it has replied. */
async function runInAgent(phone: AppClient, name: string, folder: string, command: string): Promise<void> {
  await phone.command('create_agent', { task: standInScript({ do: 'run', command: `${command} && ouro reply done` }), name, model: 'stand-in', folder })
  await waitFor(`${name}'s reply`, async () => (await phone.conversation(name)).some((message) => message.from === name), 30_000)
}

const note = (lines: string[]) => `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')}`
const projectDir = (run: JourneyRun, project: string) => join(run.dataDir, 'memory', 'projects', project)
const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null

test("notes about the person and a project's shared notes reach the other fully trusted computer", async () => {
  // Beta has a checkout of the same project, and one of another project.
  await runInAgent(betaPhone, 'reader', checkout(beta, 'agents', 'https://github.com/example/agents'), 'true')
  await runInAgent(betaPhone, 'web', checkout(beta, 'website', 'git@github.com:example/website.git'), 'true')

  await runInAgent(alphaPhone, 'writer', checkout(alpha, 'agents', 'git@github.com:example/agents.git'), [
    `${note(['---', 'name: Tea', 'description: what the person drinks', 'type: user', '---', 'green tea'])} > "$OURO_MEMORY_DIR/tea.md"`,
    `${note(['---', 'name: Build', 'type: project', '---', 'run make'])} > "$OURO_MEMORY_DIR/build.md"`,
    'ouro memory sync',
  ].join(' && '))

  const agentsAtBeta = projectDir(beta, 'github.com+example+agents')
  await waitFor('the project note at beta', () => read(join(agentsAtBeta, 'build.md'))?.endsWith('run make\n'), 30_000)
  await waitFor('the personal note in both of beta\'s projects', () =>
    read(join(agentsAtBeta, 'tea.md'))?.endsWith('green tea\n') && read(join(projectDir(beta, 'github.com+example+website'), 'tea.md'))?.endsWith('green tea\n'), 30_000)
  assert.equal(read(join(projectDir(beta, 'github.com+example+website'), 'build.md')), null, "another project's notes stay out")
})

test('an edit on either computer reaches the other, and so does a delete', async () => {
  const agentsAtAlpha = projectDir(alpha, 'github.com+example+agents')
  const agentsAtBeta = projectDir(beta, 'github.com+example+agents')
  await runInAgent(betaPhone, 'editor', join(beta.dir, 'agents'), [
    `${note(['---', 'name: Tea', 'description: what the person drinks', 'type: user', '---', 'green tea, no sugar'])} > "$OURO_MEMORY_DIR/tea.md"`,
    'ouro memory sync',
  ].join(' && '))
  await waitFor('the edit at alpha', () => read(join(agentsAtAlpha, 'tea.md'))?.endsWith('green tea, no sugar\n'), 30_000)

  await runInAgent(alphaPhone, 'cleaner', join(alpha.dir, 'agents'), 'rm "$OURO_MEMORY_DIR/build.md"')
  await waitFor('the delete at beta', () => read(join(agentsAtBeta, 'build.md')) === null, 30_000)
  // A while later, still gone on both: neither brought it back.
  await new Promise((settle) => setTimeout(settle, 1_500))
  assert.equal(read(join(agentsAtAlpha, 'build.md')), null)
  assert.equal(read(join(agentsAtBeta, 'build.md')), null)
})

test('a computer trusted only to message shares no memory either way', async () => {
  const alphaIdAtBeta = (await betaPhone.snapshot()).computers.find((computer) => computer.name === 'alpha')!.id
  await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'limited' })
  try {
    await runInAgent(alphaPhone, 'secret', join(alpha.dir, 'agents'), `${note(['---', 'name: Plan', 'type: project', '---', 'not for beta'])} > "$OURO_MEMORY_DIR/plan.md"`)
    await new Promise((settle) => setTimeout(settle, 2_000))
    assert.equal(read(join(projectDir(beta, 'github.com+example+agents'), 'plan.md')), null)
  } finally {
    await betaPhone.command('set_computer_trust', { computerId: alphaIdAtBeta, trust: 'full' })
  }
  await waitFor('the note at beta once trusted again', () => read(join(projectDir(beta, 'github.com+example+agents'), 'plan.md'))?.endsWith('not for beta\n'), 30_000)
})
