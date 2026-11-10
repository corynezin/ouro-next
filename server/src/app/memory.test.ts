import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { checkoutIdentityOf, mainCheckoutOf, mergeThreeWay } from '../adapters/checkouts.ts'
import { Store } from '../store/store.ts'
import { Memory } from './memory.ts'
import type { ProjectMemory } from './memory.ts'

const root = mkdtempSync(join(tmpdir(), 'ouro-memory-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function setUp() {
  const dir = join(root, `case-${++counter}`)
  mkdirSync(dir)
  const claudeConfigDir = join(dir, 'claude')
  const memory = new Memory({
    store: new Store(':memory:'),
    checkouts: { checkoutIdentityOf, mainCheckoutOf, mergeThreeWay },
    projectsDir: join(dir, 'projects'),
    claudeConfigDir,
    machineName: 'alpha',
    now: () => 1,
  })
  return { dir, claudeConfigDir, memory }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString()

function checkout(path: string, origin: string | null): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q')
  if (origin) git(path, 'remote', 'add', 'origin', origin)
  git(path, 'commit', '-q', '--allow-empty', '-m', 'first')
  return path
}

const personal = (name: string, body: string) => `---\nname: ${name}\ndescription: about the person\ntype: user\n---\n${body}`
const write = (project: ProjectMemory, file: string, text: string) => writeFileSync(join(project.dir, file), text)
const read = (project: ProjectMemory, file: string) => (existsSync(join(project.dir, file)) ? readFileSync(join(project.dir, file), 'utf8') : null)

function twoProjects() {
  const setup = setUp()
  const a = setup.memory.projectMemoryOf(checkout(join(setup.dir, 'a'), 'git@github.com:example/a.git'))!
  const b = setup.memory.projectMemoryOf(checkout(join(setup.dir, 'b'), 'git@github.com:example/b.git'))!
  return { ...setup, a, b }
}

test('a project has one memory wherever it is checked out; a folder outside git has none', () => {
  const { dir, memory } = setUp()
  const first = checkout(join(dir, 'first'), 'git@github.com:Example/Agents.git')
  const second = checkout(join(dir, 'second'), 'https://github.com/example/agents')
  git(first, 'worktree', 'add', '-q', join(dir, 'worktree'))
  const memories = [first, second, join(dir, 'worktree')].map((folder) => memory.projectMemoryOf(folder))
  assert.equal(memories[0]!.projectKey, 'github.com/example/agents')
  assert.deepEqual(new Set(memories.map((project) => project!.dir)).size, 1)
  const local = memory.projectMemoryOf(checkout(join(dir, 'no-origin'), null))
  assert.match(local!.projectKey, /^commit-[0-9a-f]{12}$/)
  mkdirSync(join(dir, 'plain'))
  assert.equal(memory.projectMemoryOf(join(dir, 'plain')), null)
})

test("a new project's memory starts from what Claude Code remembered of it, leaving that in place", () => {
  const { dir, claudeConfigDir, memory } = setUp()
  const folder = checkout(join(dir, 'repo'), 'git@github.com:example/seeded.git')
  const claudeMemory = join(claudeConfigDir, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
  mkdirSync(claudeMemory, { recursive: true })
  writeFileSync(join(claudeMemory, 'build.md'), 'run make')
  writeFileSync(join(claudeMemory, 'MEMORY.md'), '- [Build](build.md) — how\n')
  const project = memory.projectMemoryOf(folder)!
  assert.equal(read(project, 'build.md'), 'run make')
  assert.equal(read(project, 'MEMORY.md'), '- [Build](build.md) — how\n')
  assert.ok(existsSync(join(claudeMemory, 'build.md')))
})

test("a personal note written in one project reaches the others, and their index lists it; a project's own note stays", () => {
  const { memory, a, b } = twoProjects()
  write(a, 'tea.md', personal('Tea', 'likes green tea'))
  write(a, 'build.md', '---\nname: Build\ntype: project\n---\nrun make')
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  assert.equal(read(b, 'tea.md'), personal('Tea', 'likes green tea'))
  assert.equal(read(b, 'build.md'), null)
  assert.match(read(b, 'MEMORY.md')!, /- \[Tea\]\(tea\.md\) — about the person/)

  write(b, 'tea.md', personal('Tea', 'likes oolong'))
  memory.syncPersonalNotes(b)
  memory.syncPersonalNotes(a)
  assert.equal(read(a, 'tea.md'), personal('Tea', 'likes oolong'), 'an edit elsewhere replaces an untouched copy')
})

test('edits made in two places since the same version merge, and overlapping ones keep both', () => {
  const { memory, a, b } = twoProjects()
  const lines = (...body: string[]) => personal('Habits', body.join('\n'))
  write(a, 'habits.md', lines('one', 'two', 'three', 'four', 'five'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  write(a, 'habits.md', lines('ONE', 'two', 'three', 'four', 'five'))
  write(b, 'habits.md', lines('one', 'two', 'three', 'four', 'FIVE'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  assert.equal(read(b, 'habits.md'), lines('ONE', 'two', 'three', 'four', 'FIVE'))
  memory.syncPersonalNotes(a)
  assert.equal(read(a, 'habits.md'), lines('ONE', 'two', 'three', 'four', 'FIVE'))

  write(a, 'habits.md', lines('ONE', 'two', 'from a', 'four', 'FIVE'))
  write(b, 'habits.md', lines('ONE', 'two', 'from b', 'four', 'FIVE'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  assert.equal(read(b, 'habits.md'), lines('ONE', 'two', 'from b', 'four', 'FIVE'), 'the later edit keeps the name')
  const conflict = read(b, 'habits.conflict-alpha.md')!
  assert.match(conflict, /^---\nconflict: true\nconflictOf: habits\.md\n/)
  assert.match(conflict, /from a/)
  assert.match(read(b, 'MEMORY.md')!, /\[CONFLICT: Habits\]\(habits\.conflict-alpha\.md\)/)
  memory.syncPersonalNotes(a)
  assert.equal(read(a, 'habits.md'), lines('ONE', 'two', 'from b', 'four', 'FIVE'))
  assert.ok(read(a, 'habits.conflict-alpha.md'), 'the conflict note reaches every project')
})

test('a delete reaches untouched copies and stays deleted; a copy edited meanwhile is kept', () => {
  const { memory, a, b } = twoProjects()
  write(a, 'old.md', personal('Old', 'stale'))
  write(a, 'kept.md', personal('Kept', 'v1'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  unlinkSync(join(a.dir, 'old.md'))
  unlinkSync(join(a.dir, 'kept.md'))
  write(b, 'kept.md', personal('Kept', 'v2, edited in b'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  assert.equal(read(b, 'old.md'), null, 'the untouched copy goes')
  assert.equal(read(b, 'kept.md'), personal('Kept', 'v2, edited in b'), 'the edited one stays')
  memory.syncPersonalNotes(a)
  assert.equal(read(a, 'old.md'), null, 'and the delete is not undone')
  assert.doesNotMatch(read(b, 'MEMORY.md')!, /old\.md/)
})

test('a personal note that stops being personal stays where it is, as a project note', () => {
  const { memory, a, b } = twoProjects()
  write(a, 'pref.md', personal('Pref', 'tabs'))
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  write(a, 'pref.md', '---\nname: Pref\ntype: user\nscope: project\n---\ntabs, here only')
  memory.syncPersonalNotes(a)
  memory.syncPersonalNotes(b)
  assert.equal(read(a, 'pref.md'), '---\nname: Pref\ntype: user\nscope: project\n---\ntabs, here only')
  assert.equal(read(b, 'pref.md'), personal('Pref', 'tabs'), "b's copy is the personal note, unchanged")
})
