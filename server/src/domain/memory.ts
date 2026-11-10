// Agents' memory: which project a checkout is, which notes are about the person, and the index Claude Code reads. Pure.
// Claude Code keeps memory per folder path; agents get one memory per project instead, the same at every checkout of it.
// Notes about the person are shared by every project's memory.

/** github.com/example/agents, for any form of that remote's URL. */
export function normalizeRemote(url: string): string {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '') // scheme
    .replace(/^[^@/]+@/, '') // user@
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/') // scp-like host:path
    .replace(/:\d+\//, '/') // port
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase()
}

/** What git says about a checkout, as far as telling projects apart goes. */
export interface CheckoutIdentity {
  originUrl: string | null
  /** The first commit, when there is no origin. */
  rootCommit: string | null
}

/** The same project has the same key at every path and on every machine: its origin, else its first commit. Null: not a
 * project (no git, or no commits yet), so Claude Code's own per-folder memory applies. */
export function projectKeyOf(checkout: CheckoutIdentity): string | null {
  if (checkout.originUrl) return normalizeRemote(checkout.originUrl)
  return checkout.rootCommit ? `commit-${checkout.rootCommit.slice(0, 12)}` : null
}

/** A project key as one folder name, reversibly: '/' becomes '+' and anything else unusual is %-escaped, so two projects
 * never share a folder. */
export function projectFolderName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._/-]/g, (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/\//g, '+')
}

/** The project key a folder name was made from. */
export function projectKeyOfFolderName(folder: string): string {
  return folder.replace(/\+/g, '/').replace(/%([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** The `key: value` lines of a note's front matter; the first of a repeated key counts. */
export function frontmatterOf(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)
  const fields: Record<string, string> = {}
  for (const line of block?.[1]?.split('\n') ?? []) {
    const field = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (field && !(field[1]! in fields)) fields[field[1]!] = field[2]!.replace(/^["']|["']$/g, '').trim()
  }
  return fields
}

/** A note is about the person, and so in every project, when it says `scope: personal`, or `type: user` without saying
 * another scope. */
export function isPersonalNote(text: string): boolean {
  const { scope, type } = frontmatterOf(text)
  if (scope === 'project' || scope === 'machine' || scope === 'node') return false
  return scope === 'personal' || type === 'user'
}

export const MEMORY_INDEX_FILE = 'MEMORY.md'

/** The notes in a memory folder: Markdown files other than the index. */
export function isNoteFile(file: string): boolean {
  return file.endsWith('.md') && file !== MEMORY_INDEX_FILE
}

/** A personal note edited in two places in ways that don't merge: the version that lost the name is kept beside it,
 * marked, for the next agent to merge by hand. */
export function conflictNoteText(text: string, conflictOf: string): string {
  const marker = `conflict: true\nconflictOf: ${conflictOf}`
  return text.startsWith('---\n') ? text.replace(/^---\n/, `---\n${marker}\n`) : `---\n${marker}\n---\n\n${text}`
}

/** `<note>.conflict-<writer>.md`, then `-2`, `-3`… for the `attempt`th name tried. */
export function conflictNoteFile(file: string, writtenBy: string, attempt: number): string {
  const name = file.replace(/\.md$/, `.conflict-${writtenBy.replace(/[^a-zA-Z0-9-]/g, '-')}.md`)
  return attempt === 1 ? name : name.replace(/\.md$/, `-${attempt}.md`)
}

/** A personal note as the store last has it. `history`: the hashes of its earlier versions, newest first: they show a copy
 * to be an old version, and give a three-way merge its base. A deleted note stays, so the delete isn't undone by a copy
 * that still has it. */
export interface PersonalNote {
  file: string
  version: { kind: 'live'; hash: string } | { kind: 'deleted' }
  history: string[]
  /** The machine that wrote this version: a conflict note is named after it. */
  writtenBy: string
  writtenAt: number
}

/** How many earlier versions a note remembers. */
export const PERSONAL_NOTE_HISTORY_LIMIT = 500

const INDEX_BEGIN = '<!-- ouro: shared notes (kept by Ouro; edits here are replaced) -->'
const INDEX_END = '<!-- ouro: end of shared notes -->'

export interface IndexedNote {
  file: string
  text: string
}

/** MEMORY.md as agents wrote it, plus a block Ouro keeps listing the notes it doesn't link (personal ones arrive without
 * a line there) and open conflicts. */
export function renderMemoryIndex(current: string, notes: readonly IndexedNote[]): string {
  const start = current.indexOf(INDEX_BEGIN)
  const end = current.indexOf(INDEX_END)
  const own = (start >= 0 && end > start ? current.slice(0, start) + current.slice(end + INDEX_END.length) : current).replace(/\n+$/, '').replace(/^\n+/, '')
  const lines = [...notes].sort((a, b) => a.file.localeCompare(b.file)).flatMap((note) => {
    if (own.includes(`(${note.file})`)) return []
    const { name, description, conflict, conflictOf } = frontmatterOf(note.text)
    if (conflict === 'true') return [`- [CONFLICT: ${name ?? note.file}](${note.file}) — ${conflictOf} was edited in two places differently: merge this into it, then delete this file`]
    return [`- [${name ?? note.file}](${note.file}) — ${description ?? 'a note'}`]
  })
  if (lines.length === 0) return own === '' ? '' : `${own}\n`
  return `${own === '' ? '' : `${own}\n\n`}${INDEX_BEGIN}\n${lines.join('\n')}\n${INDEX_END}\n`
}

/**
 * Notes kept the same on two fully trusted computers. Each computer pulls the other's notes now and then and changes only
 * its own, against `base`: the text the two last agreed on for that note (null: never agreed, or absent then). A side
 * that hasn't changed since then takes the other's; changes on both merge three ways; an edit beats a delete; edits that
 * don't merge keep this side's under the name and the other's beside it as a conflict note. `agreed` is what to remember
 * as the base after this.
 */
export type NoteSyncDecision =
  | { action: 'keep_ours'; agreed: string | null }
  | { action: 'take_theirs'; text: string; agreed: string }
  | { action: 'delete_ours'; agreed: null }
  | { action: 'merged'; text: string; agreed: string }
  | { action: 'conflict'; theirs: string; agreed: string }

/**
 * Which agreed version is the base: of what this machine and the other each last saw the two agree on (by hash), the one
 * a side still has unchanged, since that is the latest; otherwise this machine's own. Null: none.
 */
export function chooseNoteBase(hashes: { ours: string | null; theirs: string | null; agreedHere: string | null; agreedThere: string | null }): string | null {
  const agreed = [hashes.agreedHere, hashes.agreedThere].filter((hash): hash is string => hash !== null)
  return agreed.find((hash) => hash === hashes.ours) ?? agreed.find((hash) => hash === hashes.theirs) ?? hashes.agreedHere ?? hashes.agreedThere
}

/** `ours`, `theirs`: the note's text on each computer; null where it is absent or deleted. */
export function decideNoteSync(
  note: { ours: string | null; theirs: string | null; base: string | null },
  mergeThreeWay: (ours: string, base: string, theirs: string) => string | null,
): NoteSyncDecision {
  const { ours, theirs, base } = note
  if (ours === theirs) return { action: 'keep_ours', agreed: ours }
  // Not changed there: what changed here stays, and the other computer takes it when it pulls.
  if (theirs === base) return { action: 'keep_ours', agreed: base }
  if (ours === base) return theirs === null ? { action: 'delete_ours', agreed: null } : { action: 'take_theirs', text: theirs, agreed: theirs }
  // Changed on both sides.
  if (ours === null) return { action: 'take_theirs', text: theirs!, agreed: theirs! }
  if (theirs === null) return { action: 'keep_ours', agreed: base }
  const merged = base === null ? null : mergeThreeWay(ours, base, theirs)
  if (merged !== null) return { action: 'merged', text: merged, agreed: theirs }
  return { action: 'conflict', theirs, agreed: theirs }
}
