// Reading a journal by byte cursor. Only whole lines count: a line still being written is left for the next read.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { JournalRecord } from '../domain/journal.ts'

const NEWLINE = 0x0a

function openIfExists(path: string): number | null {
  try {
    return openSync(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function readBytes(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  const read = readSync(fd, buffer, 0, length, start)
  return buffer.subarray(0, read)
}

export function journalSize(path: string): number {
  const fd = openIfExists(path)
  if (fd === null) return 0
  try {
    return fstatSync(fd).size
  } finally {
    closeSync(fd)
  }
}

function parseLines(text: string): JournalRecord[] {
  const records: JournalRecord[] = []
  for (const line of text.split('\n')) {
    if (line.length > 0) records.push(JSON.parse(line) as JournalRecord)
  }
  return records
}

/** Whole records from `start` onward, up to `maxBytes`, and the offset just after the last one. */
export function readJournalForward(path: string, start: number, maxBytes: number): { records: JournalRecord[]; end: number } {
  const fd = openIfExists(path)
  if (fd === null) return { records: [], end: start }
  try {
    const bytes = readBytes(fd, start, maxBytes)
    const lastNewline = bytes.lastIndexOf(NEWLINE)
    if (lastNewline < 0) return { records: [], end: start }
    const whole = bytes.subarray(0, lastNewline + 1)
    return { records: parseLines(whole.toString('utf8')), end: start + whole.length }
  } finally {
    closeSync(fd)
  }
}

/** Whole records ending at `end`, about `maxBytes` of them, and the offset of the first. */
export function readJournalBackward(path: string, end: number, maxBytes: number): { records: JournalRecord[]; start: number } {
  const fd = openIfExists(path)
  if (fd === null) return { records: [], start: 0 }
  try {
    const from = Math.max(0, end - maxBytes)
    const bytes = readBytes(fd, from, end - from)
    if (from === 0) return { records: parseLines(bytes.toString('utf8')), start: 0 }
    const firstNewline = bytes.indexOf(NEWLINE)
    if (firstNewline < 0) return { records: [], start: end }
    return { records: parseLines(bytes.subarray(firstNewline + 1).toString('utf8')), start: from + firstNewline + 1 }
  } finally {
    closeSync(fd)
  }
}
