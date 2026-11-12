// An agent's model conversation as the program that held it stores it, read out for a move and written in on arrival.
// Claude Code keeps a conversation under a folder named after where it ran, and records that folder inside it, so both
// change with the agent's folder. Codex keeps its threads in its own store, which isn't carried: an agent moved off
// Codex starts a new conversation there, seeded from what's stored.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PROVIDER_SESSION_ID_PATTERN } from '@ouro/contract'
import type { ModelRuntime } from '../domain/models.ts'

export interface ConversationStores {
  /** The agent's own state folder, where the stand-in keeps its conversations. */
  agentStateDir: string
  claudeConfigDir: string
}

export interface ConversationFile {
  /** Relative to the program's store. */
  path: string
  content: Buffer
}

/** Claude Code's folder name for a working folder: every character but letters and digits becomes "-". */
const claudeProjectFolderOf = (folder: string): string => resolve(folder).replace(/[^a-zA-Z0-9]/g, '-')

/** Where Claude Code keeps the transcript of conversation `sessionId`, which ran in `ranIn`; null for a session id that
 * could name a file elsewhere (one with a path separator or `..`, as a moved agent could bring). */
export const claudeTranscriptPathOf = (claudeConfigDir: string, sessionId: string, ranIn: string): string | null =>
  PROVIDER_SESSION_ID_PATTERN.test(sessionId) ? join(claudeConfigDir, 'projects', claudeProjectFolderOf(ranIn), `${sessionId}.jsonl`) : null

function filesUnder(root: string, dir: string): ConversationFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return filesUnder(root, path)
    return [{ path: relative(root, path), content: readFileSync(path) }]
  })
}

/** The conversation's files, or null when it isn't carried or can't be found. */
export function conversationFilesOf(runtime: ModelRuntime, sessionId: string, ranIn: string, stores: ConversationStores): ConversationFile[] | null {
  switch (runtime) {
    case 'stand_in': {
      const path = join('standin', `${sessionId}.jsonl`)
      if (!existsSync(join(stores.agentStateDir, path))) return null
      return [{ path, content: readFileSync(join(stores.agentStateDir, path)) }]
    }
    case 'claude_code': {
      const transcript = claudeTranscriptPathOf(stores.claudeConfigDir, sessionId, ranIn)
      if (transcript === null || !existsSync(transcript)) return null
      // Beside the transcript, a folder of the same name holds what its subagents and tools kept.
      return [{ path: relative(stores.claudeConfigDir, transcript), content: readFileSync(transcript) }, ...filesUnder(stores.claudeConfigDir, join(dirname(transcript), sessionId))]
    }
    case 'codex':
      return null
  }
}

/** Claude Code records the folder each step ran in; a moved conversation says the new one, so a resume runs there. */
export function rewriteRanIn(transcript: string, from: string, to: string): string {
  if (from === to) return transcript
  return transcript.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line
    try {
      const entry = JSON.parse(line) as { cwd?: unknown }
      if (typeof entry.cwd !== 'string' || (entry.cwd !== from && !entry.cwd.startsWith(`${from}/`))) return line
      return JSON.stringify({ ...entry, cwd: to + entry.cwd.slice(from.length) })
    } catch {
      return line
    }
  }).join('\n')
}

function writeWhole(path: string, content: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.ouro-${process.pid}.tmp`
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Refuses a path that would leave the store it belongs in. */
function inside(root: string, path: string): string {
  const full = resolve(root, path)
  if (!full.startsWith(`${resolve(root)}${sep}`)) throw new Error(`a conversation file outside its store: ${path}`)
  return full
}

/** Writes a moved conversation in, for an agent that now works in `folder`. */
export function installConversation(runtime: ModelRuntime, conversation: { providerSessionId: string; ranIn: string; files: ConversationFile[] }, folder: string, stores: ConversationStores): void {
  switch (runtime) {
    case 'stand_in':
      for (const file of conversation.files) writeWhole(inside(stores.agentStateDir, file.path), file.content)
      return
    case 'claude_code': {
      const oldProject = join('projects', claudeProjectFolderOf(conversation.ranIn))
      const newProject = join('projects', claudeProjectFolderOf(folder))
      for (const file of conversation.files) {
        if (!file.path.startsWith(`${oldProject}${sep}`)) throw new Error(`a conversation file outside its project: ${file.path}`)
        const path = inside(stores.claudeConfigDir, join(newProject, file.path.slice(oldProject.length + 1)))
        const isTranscript = file.path === join(oldProject, `${conversation.providerSessionId}.jsonl`)
        writeWhole(path, isTranscript ? rewriteRanIn(file.content.toString('utf8'), resolve(conversation.ranIn), resolve(folder)) : file.content)
      }
      return
    }
    case 'codex':
      return
  }
}
