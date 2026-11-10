import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conflictNoteFile, conflictNoteText, chooseNoteBase, decideNoteSync, isPersonalNote, normalizeRemote, projectFolderName, projectKeyOfFolderName, projectKeyOf, renderMemoryIndex } from './memory.ts'

test('every form of a remote names the same project', () => {
  for (const url of ['git@github.com:Example/Agents.git', 'https://github.com/example/agents', 'ssh://git@github.com:22/example/agents.git', 'https://user@github.com/example/agents/']) {
    assert.equal(normalizeRemote(url), 'github.com/example/agents', url)
  }
  assert.equal(projectKeyOf({ originUrl: 'git@github.com:example/agents.git', rootCommit: 'abc' }), 'github.com/example/agents')
  assert.equal(projectKeyOf({ originUrl: null, rootCommit: '0123456789abcdef0123' }), 'commit-0123456789ab')
  assert.equal(projectKeyOf({ originUrl: null, rootCommit: null }), null)
})

test('folder names keep projects apart', () => {
  assert.equal(projectFolderName('github.com/example/agents'), 'github.com+example+agents')
  assert.notEqual(projectFolderName('github.com/a/b-c'), projectFolderName('github.com/a-b/c'))
  assert.equal(projectFolderName('host/a b'), 'host+a%20b')
  for (const key of ['github.com/example/agents', 'host/a b', 'host/a+b%c', 'commit-0123456789ab']) assert.equal(projectKeyOfFolderName(projectFolderName(key)), key)
})

test('a note is personal by its scope, or by being about the user', () => {
  assert.equal(isPersonalNote('---\nname: x\ntype: user\n---\nlikes tea'), true)
  assert.equal(isPersonalNote('---\ntype: project\nscope: personal\n---\n'), true)
  assert.equal(isPersonalNote('---\ntype: user\nscope: project\n---\n'), false)
  assert.equal(isPersonalNote('---\ntype: feedback\n---\n'), false)
  assert.equal(isPersonalNote('no front matter'), false)
})

test('a conflict note says what it conflicts with, and finds a free name', () => {
  assert.equal(conflictNoteText('---\nname: tea\n---\nbody', 'tea.md'), '---\nconflict: true\nconflictOf: tea.md\nname: tea\n---\nbody')
  assert.equal(conflictNoteText('body', 'tea.md'), '---\nconflict: true\nconflictOf: tea.md\n---\n\nbody')
  assert.equal(conflictNoteFile('tea.md', 'my machine', 1), 'tea.conflict-my-machine.md')
  assert.equal(conflictNoteFile('tea.md', 'alpha', 2), 'tea.conflict-alpha-2.md')
})

test("the index keeps what agents wrote and lists the notes it doesn't link", () => {
  const personal = { file: 'tea.md', text: '---\nname: Tea\ndescription: likes tea\ntype: user\n---\n' }
  const linked = { file: 'build.md', text: '---\nname: Build\n---\n' }
  const conflict = { file: 'tea.conflict-alpha.md', text: '---\nconflict: true\nconflictOf: tea.md\nname: Tea\n---\n' }
  const own = '- [Build](build.md) — how to build\n'
  const rendered = renderMemoryIndex(own, [personal, linked, conflict])
  assert.equal(rendered, [
    '- [Build](build.md) — how to build',
    '',
    '<!-- ouro: shared notes (kept by Ouro; edits here are replaced) -->',
    '- [CONFLICT: Tea](tea.conflict-alpha.md) — tea.md was edited in two places differently: merge this into it, then delete this file',
    '- [Tea](tea.md) — likes tea',
    '<!-- ouro: end of shared notes -->',
    '',
  ].join('\n'))
  assert.equal(renderMemoryIndex(rendered, [personal, linked, conflict]), rendered, 'rendering again changes nothing')
  assert.equal(renderMemoryIndex(rendered, [linked]), own, 'the block goes when nothing needs it')
})

test('two computers keep a note the same: the side that changed wins, both changed merge, an edit beats a delete', () => {
  // A stand-in merge: lines added on either side since the base, kept; null when both changed the same line.
  const merge = (ours: string, base: string, theirs: string) => {
    const baseLines = new Set(base.split('\n'))
    if (ours.split('\n')[0] !== base.split('\n')[0] && theirs.split('\n')[0] !== base.split('\n')[0]) return null
    return [...new Set([...ours.split('\n'), ...theirs.split('\n').filter((line) => !baseLines.has(line))])].join('\n')
  }
  const decide = (ours: string | null, theirs: string | null, base: string | null) => decideNoteSync({ ours, theirs, base }, merge)
  assert.deepEqual(decide('a', 'a', null), { action: 'keep_ours', agreed: 'a' }, 'the same on both')
  assert.deepEqual(decide('a2', 'a', 'a'), { action: 'keep_ours', agreed: 'a' }, 'changed only here')
  assert.deepEqual(decide('a', 'a2', 'a'), { action: 'take_theirs', text: 'a2', agreed: 'a2' }, 'changed only there')
  assert.deepEqual(decide(null, 'new', null), { action: 'take_theirs', text: 'new', agreed: 'new' }, 'new there')
  assert.deepEqual(decide('a', null, 'a'), { action: 'delete_ours', agreed: null }, 'deleted there, untouched here')
  assert.deepEqual(decide(null, 'a', 'a'), { action: 'keep_ours', agreed: 'a' }, 'deleted here: the other computer deletes it when it pulls')
  assert.deepEqual(decide(null, 'a2', 'a'), { action: 'take_theirs', text: 'a2', agreed: 'a2' }, 'deleted here, edited there: the edit wins')
  assert.deepEqual(decide('a2', null, 'a'), { action: 'keep_ours', agreed: 'a' }, 'edited here, deleted there: the edit wins')
  assert.deepEqual(decide('t\nmine', 't\ntheirs', 't'), { action: 'merged', text: 't\nmine\ntheirs', agreed: 't\ntheirs' })
  assert.deepEqual(decide('mine', 'theirs', 't'), { action: 'conflict', theirs: 'theirs', agreed: 'theirs' }, 'edits that overlap')
  assert.deepEqual(decide('mine', 'theirs', null), { action: 'conflict', theirs: 'theirs', agreed: 'theirs' }, 'made on both with no base')
  // After a conflict, the other side's text is the base: the same conflict isn't raised again.
  assert.deepEqual(decide('mine', 'theirs', 'theirs'), { action: 'keep_ours', agreed: 'theirs' })
})

test("the base is the latest agreement either computer saw: one may have seen the two agree when the other hasn't", () => {
  assert.equal(chooseNoteBase({ ours: 'g', theirs: 'e', agreedHere: null, agreedThere: 'g' }), 'g', 'they took ours, then edited it')
  assert.equal(chooseNoteBase({ ours: 'e', theirs: 'g', agreedHere: 'g', agreedThere: null }), 'g')
  assert.equal(chooseNoteBase({ ours: 'x', theirs: 'y', agreedHere: 'a', agreedThere: 'b' }), 'a', 'neither side unchanged: our own')
  assert.equal(chooseNoteBase({ ours: null, theirs: 'y', agreedHere: null, agreedThere: null }), null)
})
