import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { folderBases } from './base-source.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-bases-'))
  made.push(dir)
  return dir
}

function tree(text: string): string {
  const dir = folder()
  writeFileSync(join(dir, 'server.txt'), text)
  return dir
}

test('a folder of bases numbers what is published, and the same files again publish nothing new', async () => {
  const bases = folderBases(join(folder(), 'bases'))
  assert.equal(await bases.latest(), null)

  const first = await bases.publish({ notes: 'the first', treeHash: 'aaa', treeDir: tree('one\n') })
  assert.deepEqual(first, { base: { n: 1, notes: 'the first', treeHash: 'aaa' }, alreadyPublished: false })
  const again = await bases.publish({ notes: 'the first, retried', treeHash: 'aaa', treeDir: tree('one\n') })
  assert.deepEqual(again, { base: { n: 1, notes: 'the first', treeHash: 'aaa' }, alreadyPublished: true })
  const second = await bases.publish({ notes: 'the second', treeHash: 'bbb', treeDir: tree('two\n') })
  assert.deepEqual(second.base, { n: 2, notes: 'the second', treeHash: 'bbb' })
  assert.deepEqual(await bases.latest(), second.base)

  const into = folder()
  await bases.fetch(1, into)
  assert.equal(readFileSync(join(into, 'server.txt'), 'utf8'), 'one\n')
  await assert.rejects(bases.fetch(3, folder()), /base 3 isn't in/)
})

test('a base still being written isn\'t there to read', async () => {
  const dir = folder()
  const bases = folderBases(dir)
  await bases.publish({ notes: 'the first', treeHash: 'aaa', treeDir: tree('one\n') })
  mkdirSync(join(dir, '.2.writing', 'tree'), { recursive: true })
  mkdirSync(join(dir, '3', 'tree'), { recursive: true })
  assert.equal((await bases.latest())?.n, 1)
})

test('a withdrawn base is offered no more, its files stay, and numbers only rise', async () => {
  const bases = folderBases(folder())
  await bases.publish({ notes: 'the first', treeHash: 'aaa', treeDir: tree('one\n') })
  await bases.publish({ notes: 'the second', treeHash: 'bbb', treeDir: tree('two\n') })
  assert.equal(await bases.withdraw(3), null)
  assert.deepEqual(await bases.withdraw(2), { n: 2, notes: 'the second', treeHash: 'bbb' })
  assert.deepEqual(await bases.withdraw(2), { n: 2, notes: 'the second', treeHash: 'bbb' })
  assert.equal((await bases.latest())?.n, 1)

  const into = folder()
  await bases.fetch(2, into)
  assert.equal(readFileSync(join(into, 'server.txt'), 'utf8'), 'two\n')

  // The withdrawn files again are a new base, not the withdrawn one.
  const again = await bases.publish({ notes: 'the second, fixed', treeHash: 'bbb', treeDir: tree('two\n') })
  assert.deepEqual(again, { base: { n: 3, notes: 'the second, fixed', treeHash: 'bbb' }, alreadyPublished: false })
})
