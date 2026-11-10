// Agents' memory on this machine. Each project has one memory folder, which Claude Code is told to use for agents working
// in any checkout of it. Personal notes are kept once, in the store, with every version: syncing a project's folder takes
// in what agents changed there and copies the rest in. Agents write the folder directly, so a sync compares it with what
// was last copied there.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  chooseNoteBase, conflictNoteFile, conflictNoteText, decideNoteSync, isNoteFile, isPersonalNote, MEMORY_INDEX_FILE, PERSONAL_NOTE_HISTORY_LIMIT, projectFolderName,
  projectKeyOf, projectKeyOfFolderName, renderMemoryIndex,
} from '../domain/memory.ts'
import type { CheckoutIdentity, NoteSyncDecision, PersonalNote } from '../domain/memory.ts'
import type { PeerMemory, PeerNoteAgreement } from '@ouro/contract'
import type { NoteScope, Store } from '../store/store.ts'

export interface CheckoutTools {
  checkoutIdentityOf(folder: string): CheckoutIdentity | null
  mainCheckoutOf(folder: string): string | null
  mergeThreeWay(ours: string, base: string, theirs: string): string | null
}

export interface MemoryConfig {
  store: Store
  checkouts: CheckoutTools
  /** Where each project's memory folder is made. */
  projectsDir: string
  /** Claude Code's own configuration folder for agents, whose per-folder memory seeds a new project's. */
  claudeConfigDir: string
  machineName: string
  now: () => number
}

export interface ProjectMemory {
  projectKey: string
  dir: string
}

const noteHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Agents may be reading the folder: a note is replaced whole, never seen half-written. */
function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.ouro-${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}

export class Memory {
  private readonly config: MemoryConfig

  constructor(config: MemoryConfig) {
    this.config = config
  }

  /** The memory of the project an agent's folder is a checkout of, made the first time. Null: not a project. */
  projectMemoryOf(folder: string): ProjectMemory | null {
    const identity = this.config.checkouts.checkoutIdentityOf(folder)
    const projectKey = identity && projectKeyOf(identity)
    if (!projectKey) return null
    const dir = join(this.config.projectsDir, projectFolderName(projectKey))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      // What Claude Code already remembers of this project, at its main checkout and at this folder, is where it starts.
      const mainCheckout = this.config.checkouts.mainCheckoutOf(folder)
      for (const source of new Set([mainCheckout, folder].filter((path): path is string => path !== null))) this.seedFrom(this.claudeMemoryDirOf(source), dir)
    }
    return { projectKey, dir }
  }

  /** A project's shared notes, for an agent moving to another computer. Personal notes are the person's, kept in the
   * store, and don't go with it. */
  sharedNotesOf(project: ProjectMemory): { file: string; text: string }[] {
    if (!existsSync(project.dir)) return []
    return readdirSync(project.dir).filter(isNoteFile).sort().flatMap((file) => {
      const text = readText(join(project.dir, file))
      return text === null || isPersonalNote(text) ? [] : [{ file, text }]
    })
  }

  /** A moved agent's project notes, added to this machine's memory of the project where it lacks them: what this machine
   * already has stays as it is. */
  takeSharedNotes(projectKey: string, notes: { file: string; text: string }[]): void {
    const dir = join(this.config.projectsDir, projectFolderName(projectKey))
    mkdirSync(dir, { recursive: true })
    for (const note of notes) {
      if (!isNoteFile(note.file) || note.file.includes('/') || isPersonalNote(note.text)) continue
      if (!existsSync(join(dir, note.file))) writeAtomically(join(dir, note.file), note.text)
    }
  }

  // Kept the same on fully trusted computers

  /** The projects this machine has memory for. */
  projectKeys(): string[] {
    if (!existsSync(this.config.projectsDir)) return []
    return readdirSync(this.config.projectsDir).map(projectKeyOfFolderName).sort()
  }

  /** What a fully trusted peer pulls: every live personal note, and the shared notes of each project both have, with what
   * this machine last agreed on with that peer. */
  notesForPeer(peer: { machineId: string }, projectKeys: readonly string[]): PeerMemory {
    const { store } = this.config
    const agreementsOf = (scope: NoteScope) => [...store.noteBasesWithPeer(peer.machineId, scope)].map(([file, hash]) => ({ file, hash }))
    const personalNotes = store.listPersonalNotes().flatMap((note) => {
      const text = note.version.kind === 'live' ? store.noteText(note.version.hash) : null
      return text === null ? [] : [{ file: note.file, text }]
    })
    const projects = projectKeys.flatMap((projectKey) => {
      const dir = join(this.config.projectsDir, projectFolderName(projectKey))
      return existsSync(dir) ? [{ projectKey, notes: this.sharedNotesOf({ projectKey, dir }), agreements: agreementsOf({ kind: 'project', projectKey }) }] : []
    })
    return { personalNotes, personalAgreements: agreementsOf({ kind: 'personal' }), projects }
  }

  /** Takes in what a fully trusted peer has, note by note against what the two last agreed on: see decideNoteSync. Only
   * this machine changes; the peer takes this machine's side when it pulls in turn. */
  takeNotesFromPeer(peer: { machineId: string; name: string }, theirs: PeerMemory): void {
    const agreementsOf = (agreements: PeerNoteAgreement[]) => new Map(agreements.map((agreement) => [agreement.file, agreement.hash]))
    this.config.store.transaction(() => {
      const personal = new Map(theirs.personalNotes.filter((note) => isPersonalNote(note.text)).map((note) => [note.file, note.text]))
      this.takePersonalNotesFromPeer(peer, personal, agreementsOf(theirs.personalAgreements))
      for (const project of theirs.projects) {
        const dir = join(this.config.projectsDir, projectFolderName(project.projectKey))
        if (!existsSync(dir)) continue
        const shared = project.notes.filter((note) => isNoteFile(note.file) && !note.file.includes('/') && !isPersonalNote(note.text))
        this.takeProjectNotesFromPeer(peer, { projectKey: project.projectKey, dir }, new Map(shared.map((note) => [note.file, note.text])), agreementsOf(project.agreements))
      }
    })
    // Every project's folder shows the personal notes as they are now.
    for (const projectKey of this.projectKeys()) this.syncPersonalNotes({ projectKey, dir: join(this.config.projectsDir, projectFolderName(projectKey)) })
  }

  private takePersonalNotesFromPeer(peer: { machineId: string; name: string }, theirs: Map<string, string>, agreedThere: Map<string, string>): void {
    const { store } = this.config
    const scope: NoteScope = { kind: 'personal' }
    const ours = new Map(store.listPersonalNotes().flatMap((note) => {
      const text = note.version.kind === 'live' ? store.noteText(note.version.hash) : null
      return text === null ? [] : [[note.file, text] as const]
    }))
    for (const [file, decision] of this.decideEach(peer, scope, ours, theirs, agreedThere)) {
      const current = store.personalNote(file)
      if (decision.action === 'take_theirs') this.writeVersion(file, decision.text, current, peer.name)
      if (decision.action === 'merged') this.writeVersion(file, decision.text, current, this.config.machineName)
      if (decision.action === 'delete_ours' && current) this.deletePersonalNote(current)
      if (decision.action === 'conflict') this.saveConflictNote(file, decision.theirs, peer.name)
    }
  }

  private takeProjectNotesFromPeer(peer: { machineId: string; name: string }, project: ProjectMemory, theirs: Map<string, string>, agreedThere: Map<string, string>): void {
    const ours = new Map(this.sharedNotesOf(project).map((note) => [note.file, note.text]))
    for (const [file, decision] of this.decideEach(peer, { kind: 'project', projectKey: project.projectKey }, ours, theirs, agreedThere)) {
      const path = join(project.dir, file)
      // A personal note under that name here is the person's, not the project's: left alone.
      const here = readText(path)
      if (here !== null && isPersonalNote(here)) continue
      if (decision.action === 'take_theirs' || decision.action === 'merged') writeAtomically(path, decision.text)
      if (decision.action === 'delete_ours') rmSync(path, { force: true })
      if (decision.action === 'conflict') this.saveProjectConflictNote(project.dir, file, decision.theirs, peer.name)
    }
  }

  /** Decides each note either side has or had, and remembers what the two now agree on. */
  private decideEach(peer: { machineId: string }, scope: NoteScope, ours: Map<string, string>, theirs: Map<string, string>, agreedThere: Map<string, string>): [string, NoteSyncDecision][] {
    const { store } = this.config
    const agreedHere = store.noteBasesWithPeer(peer.machineId, scope)
    const files = [...new Set([...ours.keys(), ...theirs.keys(), ...agreedHere.keys(), ...agreedThere.keys()])].sort()
    return files.map((file) => {
      const note = { ours: ours.get(file) ?? null, theirs: theirs.get(file) ?? null }
      const baseHash = chooseNoteBase({
        ours: note.ours === null ? null : noteHash(note.ours),
        theirs: note.theirs === null ? null : noteHash(note.theirs),
        agreedHere: agreedHere.get(file) ?? null,
        agreedThere: agreedThere.get(file) ?? null,
      })
      const base = baseHash === null ? null : this.textOfVersion(baseHash, [note.ours, note.theirs])
      const decision = decideNoteSync({ ...note, base }, this.config.checkouts.mergeThreeWay)
      if (decision.agreed !== null) store.saveNoteText(noteHash(decision.agreed), decision.agreed)
      store.setNoteBaseWithPeer(peer.machineId, scope, file, decision.agreed === null ? null : noteHash(decision.agreed))
      return [file, decision]
    })
  }

  /** A version's text: one of these, or as stored here. Null: a version agreed only on the other machine, whose text this
   * one never had, so there is no base to merge from. */
  private textOfVersion(hash: string, candidates: (string | null)[]): string | null {
    return candidates.find((text): text is string => text !== null && noteHash(text) === hash) ?? this.config.store.noteText(hash)
  }

  private saveProjectConflictNote(dir: string, file: string, losingText: string, writtenBy: string): void {
    const text = conflictNoteText(losingText, file)
    for (let attempt = 1; ; attempt++) {
      const path = join(dir, conflictNoteFile(file, writtenBy, attempt))
      const there = readText(path)
      if (there === text) return
      if (there === null) return writeAtomically(path, text)
    }
  }

  /** Where Claude Code keeps its own memory for a folder. */
  private claudeMemoryDirOf(folder: string): string {
    return join(this.config.claudeConfigDir, 'projects', resolve(folder).replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
  }

  /** Copies, leaving the originals: notes not already there, and index lines the index doesn't have. */
  private seedFrom(source: string, dir: string): void {
    if (!existsSync(source)) return
    for (const file of readdirSync(source).filter((name) => name.endsWith('.md'))) {
      if (file !== MEMORY_INDEX_FILE) {
        if (!existsSync(join(dir, file))) copyFileSync(join(source, file), join(dir, file))
        continue
      }
      const have = readText(join(dir, file)) ?? ''
      const missing = (readText(join(source, file)) ?? '').split('\n').filter((line) => line.trim() !== '' && !have.includes(line))
      if (missing.length > 0) writeAtomically(join(dir, file), `${have === '' || have.endsWith('\n') ? have : `${have}\n`}${missing.join('\n')}\n`)
    }
  }

  /** Brings a project's memory folder and the personal notes together: what agents changed there since the last sync
   * goes into the store, then the store's notes are copied in, and the index lists them. */
  syncPersonalNotes(project: ProjectMemory): void {
    const { store } = this.config
    store.transaction(() => {
      this.takeInChanges(project)
      this.copyIn(project)
    })
    const notes = readdirSync(project.dir).filter(isNoteFile).flatMap((file) => {
      const text = readText(join(project.dir, file))
      return text === null ? [] : [{ file, text }]
    })
    const indexPath = join(project.dir, MEMORY_INDEX_FILE)
    const current = readText(indexPath) ?? ''
    const rendered = renderMemoryIndex(current, notes)
    if (rendered !== current) writeAtomically(indexPath, rendered)
  }

  private takeInChanges({ projectKey, dir }: ProjectMemory): void {
    const { store } = this.config
    const copies = store.personalNoteCopiesOf(projectKey)
    for (const [file, copiedHash] of copies) {
      const local = readText(join(dir, file))
      if (local === null) {
        // Deleted here: that wins only over a note nobody changed since.
        const note = store.personalNote(file)
        if (note?.version.kind === 'live' && note.version.hash === copiedHash) this.deletePersonalNote(note)
        store.setPersonalNoteCopy(projectKey, file, null)
      } else if (noteHash(local) !== copiedHash) {
        // No longer personal: it stays here as one of the project's own notes.
        if (!isPersonalNote(local)) store.setPersonalNoteCopy(projectKey, file, null)
        else this.keepHere(projectKey, dir, file, local, this.savePersonalNote(file, local, copiedHash))
      }
    }
    for (const file of readdirSync(dir).filter(isNoteFile)) {
      if (copies.has(file)) continue
      const local = readText(join(dir, file))
      if (local === null || !isPersonalNote(local)) continue
      // A personal note new to this folder. Unless it is the store's version, nothing says what it was edited from.
      const note = store.personalNote(file)
      const base = note?.version.kind === 'live' && note.version.hash === noteHash(local) ? note.version.hash : null
      this.keepHere(projectKey, dir, file, local, this.savePersonalNote(file, local, base))
    }
  }

  private keepHere(projectKey: string, dir: string, file: string, local: string, now: string): void {
    if (now !== local) writeAtomically(join(dir, file), now)
    this.config.store.setPersonalNoteCopy(projectKey, file, noteHash(now))
  }

  private copyIn({ projectKey, dir }: ProjectMemory): void {
    const { store } = this.config
    const copies = store.personalNoteCopiesOf(projectKey)
    for (const note of store.listPersonalNotes()) {
      const path = join(dir, note.file)
      const local = readText(path)
      const copiedHash = copies.get(note.file) ?? null
      if (note.version.kind === 'deleted') {
        // A copy edited here since is that agent's to keep.
        if (local !== null && copiedHash !== null && noteHash(local) === copiedHash) rmSync(path, { force: true })
        if (copiedHash !== null) store.setPersonalNoteCopy(projectKey, note.file, null)
        continue
      }
      const untouched = local === null || noteHash(local) === copiedHash || noteHash(local) === note.version.hash
      if (!untouched) continue
      const text = store.noteText(note.version.hash)
      if (text === null) continue
      if (local !== text) writeAtomically(path, text)
      store.setPersonalNoteCopy(projectKey, note.file, note.version.hash)
    }
  }

  /**
   * Saves `text` as personal note `file`, edited from version `base` (null: new, or not known), and answers what the note
   * now says. The store unchanged since `base` takes it as it is. Changed on both sides, they are merged three ways; if
   * the edits overlap, `text` takes the name and the store's version is kept beside it as a conflict note. With no base,
   * nothing says this text is newer, so the store keeps the name and `text` becomes the conflict note.
   */
  private savePersonalNote(file: string, text: string, base: string | null): string {
    const { store } = this.config
    const hash = noteHash(text)
    const current = store.personalNote(file)
    if (current === null || current.version.kind === 'deleted' || current.version.hash === base || current.version.hash === hash) {
      if (current?.version.kind !== 'live' || current.version.hash !== hash) this.writeVersion(file, text, current)
      return text
    }
    const stored = store.noteText(current.version.hash) ?? text
    // An old version of the note, in a folder that wasn't synced since: the store's is newer.
    if (current.history.includes(hash)) return stored
    const baseText = base === null ? null : store.noteText(base)
    const merged = baseText === null ? null : this.config.checkouts.mergeThreeWay(text, baseText, stored)
    if (merged !== null) {
      this.writeVersion(file, merged, current)
      return merged
    }
    if (base === null) {
      this.saveConflictNote(file, text, this.config.machineName)
      return stored
    }
    this.saveConflictNote(file, stored, current.writtenBy)
    this.writeVersion(file, text, current)
    return text
  }

  private saveConflictNote(file: string, losingText: string, writtenBy: string): void {
    const text = conflictNoteText(losingText, file)
    for (let attempt = 1; ; attempt++) {
      const name = conflictNoteFile(file, writtenBy, attempt)
      const taken = this.config.store.personalNote(name)
      // The same conflict again reuses its note.
      if (taken?.version.kind === 'live' && taken.version.hash === noteHash(text)) return
      if (taken === null || taken.version.kind === 'deleted') {
        this.writeVersion(name, text, taken)
        return
      }
    }
  }

  private writeVersion(file: string, text: string, previous: PersonalNote | null, writtenBy: string = this.config.machineName): void {
    const hash = noteHash(text)
    this.config.store.saveNoteText(hash, text)
    this.config.store.savePersonalNote({ file, version: { kind: 'live', hash }, history: this.historyAfter(previous), writtenBy, writtenAt: this.config.now() })
  }

  private deletePersonalNote(note: PersonalNote): void {
    this.config.store.savePersonalNote({ ...note, version: { kind: 'deleted' }, history: this.historyAfter(note), writtenBy: this.config.machineName, writtenAt: this.config.now() })
  }

  private historyAfter(previous: PersonalNote | null): string[] {
    if (previous === null) return []
    const earlier = previous.version.kind === 'live' ? [previous.version.hash, ...previous.history] : previous.history
    return [...new Set(earlier)].slice(0, PERSONAL_NOTE_HISTORY_LIMIT)
  }
}
