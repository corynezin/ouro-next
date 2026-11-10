import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { mergeAgentBranch, placeAgent, removeAgentWorktree } from './worktrees.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A project with one commit on main, in a fresh folder of its own. */
function project(): string {
  const home = mkdtempSync(join(tmpdir(), 'ouro-worktrees-'))
  made.push(home)
  const repo = join(home, 'garden')
  mkdirSync(join(repo, 'notes'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'notes', 'beds.txt'), 'tomatoes\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

function commit(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', `edit ${file}`)
}

test('an agent asked to work in a main checkout gets its own worktree on agent/<name>, keeping the subfolder', () => {
  const repo = project()
  const place = placeAgent('weeder', 'a1', join(repo, 'notes'))
  assert.ok(place.worktree)
  assert.deepEqual(place.worktree, { repo, dir: join(repo, '..', '.garden.worktrees', 'weeder'), branch: 'agent/weeder', base: 'main' })
  assert.equal(place.folder, join(place.worktree.dir, 'notes'))
  assert.equal(git(place.worktree.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/weeder')
})

test('outside a git project, and inside another agent\'s worktree, the folder is used as it is', () => {
  const plain = mkdtempSync(join(tmpdir(), 'ouro-plain-'))
  made.push(plain)
  assert.deepEqual(placeAgent('weeder', 'a1', plain), { folder: plain, worktree: null })
  const repo = project()
  const parent = placeAgent('lead', 'a1', repo).worktree!
  assert.deepEqual(placeAgent('helper', 'a2', parent.dir), { folder: parent.dir, worktree: null })
})

test('a folder the project ignores, such as a data directory kept inside it, is not part of it', () => {
  const repo = project()
  writeFileSync(join(repo, '.gitignore'), 'runs/\n')
  const ignored = join(repo, 'runs', 'data', 'work')
  assert.deepEqual(placeAgent('weeder', 'a1', ignored), { folder: ignored, worktree: null })
})

test('a folder reached through a symlink is placed in the project it really is in', () => {
  const repo = project()
  const link = join(repo, '..', 'garden-link')
  symlinkSync(repo, link)
  const place = placeAgent('weeder', 'a1', join(link, 'notes'))
  assert.equal(place.worktree?.repo, realpathSync(repo))
  assert.equal(place.folder, join(place.worktree!.dir, 'notes'))
})

test('a branch left unmerged by an earlier agent of the same name is not reused', () => {
  const repo = project()
  placeAgent('weeder', 'a1', repo)
  const second = placeAgent('weeder', 'b2', repo).worktree!
  assert.equal(second.branch, 'agent/weeder-b2')
})

test('a branch merges by fast-forward, or by rebase when the base moved on; with nothing new there is nothing to merge', () => {
  const repo = project()
  const first = placeAgent('first', 'a1', repo).worktree!
  assert.equal(mergeAgentBranch(first).kind, 'nothing_to_merge')
  commit(first.dir, 'first.txt', 'one\n')
  assert.deepEqual(mergeAgentBranch(first), { kind: 'merged', branch: 'agent/first', base: 'main', how: 'fast_forward' })
  assert.equal(readFileSync(join(repo, 'first.txt'), 'utf8'), 'one\n', 'the main checkout has it')

  const second = placeAgent('second', 'a2', repo).worktree!
  commit(repo, 'main.txt', 'main moved\n')
  commit(second.dir, 'second.txt', 'two\n')
  assert.deepEqual(mergeAgentBranch(second), { kind: 'merged', branch: 'agent/second', base: 'main', how: 'rebase' })
  assert.equal(git(repo, 'log', '--format=%s', '-3'), 'edit second.txt\nedit main.txt\nedit first.txt', 'nobody else\'s commits are rewritten')
})

test('a conflict is left in place and reported, with both sides as they were', () => {
  const repo = project()
  const agent = placeAgent('weeder', 'a1', repo).worktree!
  commit(repo, 'notes/beds.txt', 'beans\n')
  commit(agent.dir, 'notes/beds.txt', 'peppers\n')
  const before = git(repo, 'rev-parse', 'main')
  const merge = mergeAgentBranch(agent)
  assert.equal(merge.kind, 'not_merged')
  assert.match(merge.kind === 'not_merged' ? merge.why : '', /^rebasing it onto main conflicted/)
  assert.equal(git(repo, 'rev-parse', 'main'), before)
  assert.equal(readFileSync(join(agent.dir, 'notes', 'beds.txt'), 'utf8'), 'peppers\n')
  assert.equal(git(agent.dir, 'status', '--porcelain'), '', 'the rebase is aborted')
})

test('it merges only into the base the main checkout has out', () => {
  const repo = project()
  const agent = placeAgent('weeder', 'a1', repo).worktree!
  commit(agent.dir, 'weeds.txt', 'pulled\n')
  git(repo, 'checkout', '-q', '-b', 'experiment')
  assert.deepEqual(mergeAgentBranch(agent), { kind: 'not_merged', branch: 'agent/weeder', base: 'main', why: `the main checkout ${repo} has experiment out, not main` })
})

test('a merged worktree is removed with its branch, unless it holds changes not committed', () => {
  const repo = project()
  const kept = placeAgent('messy', 'a1', repo).worktree!
  writeFileSync(join(kept.dir, 'draft.txt'), 'unsaved\n')
  assert.deepEqual(removeAgentWorktree(kept), { kind: 'kept', why: `${kept.dir} has changes not committed` })
  assert.ok(existsSync(join(kept.dir, 'draft.txt')))

  const tidy = placeAgent('tidy', 'a2', repo).worktree!
  commit(tidy.dir, 'tidy.txt', 'done\n')
  assert.equal(mergeAgentBranch(tidy).kind, 'merged')
  assert.deepEqual(removeAgentWorktree(tidy), { kind: 'removed' })
  assert.equal(existsSync(tidy.dir), false)
  assert.equal(git(repo, 'branch', '--list', 'agent/tidy'), '')
})
