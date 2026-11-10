import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { wroteToMemory } from './cli.ts'

const root = mkdtempSync(join(tmpdir(), 'ouro-hook-'))
after(() => rmSync(root, { recursive: true, force: true }))

test("the memory hook syncs after a write to the memory folder, at a session's start, and not otherwise", () => {
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir)
  symlinkSync(memoryDir, join(root, 'linked'))
  const wrote = (filePath: string) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { file_path: filePath } })
  assert.equal(wroteToMemory(wrote(join(memoryDir, 'tea.md')), memoryDir), true)
  assert.equal(wroteToMemory(wrote(join(root, 'linked', 'tea.md')), memoryDir), true, 'by any path to it')
  assert.equal(wroteToMemory(wrote(join(root, 'src', 'main.ts')), memoryDir), false)
  assert.equal(wroteToMemory(wrote(join(memoryDir, 'data.json')), memoryDir), false, 'notes are Markdown')
  assert.equal(wroteToMemory(JSON.stringify({ hook_event_name: 'SessionStart' }), memoryDir), true)
  assert.equal(wroteToMemory(wrote(join(memoryDir, 'tea.md')), undefined), false, 'an agent without project memory')
})
