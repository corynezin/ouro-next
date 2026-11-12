// A Claude Code transcript, read as it grows, for the Context screen (domain/context.ts rebuilds the requests). Each
// transcript is read once, then only what has been appended since; a file that shrank or was replaced is read again.
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { emptyTranscript, feedTranscript } from '../domain/context.ts'
import type { TranscriptState } from '../domain/context.ts'

/** Read in pieces this size: a transcript of hundreds of megabytes is never one string, and each piece holds the event loop for tens of milliseconds at most. */
const READ_CHUNK_BYTES = 1024 * 1024
/** The phone asks for the list, a request and its blocks in quick succession, and follows a working agent: keep a few. */
const CACHED_TRANSCRIPTS = 4
/** A transcript nobody has looked at for this long is let go: it is read again, whole, if asked for. */
const TRANSCRIPT_IDLE_MS = 10 * 60_000

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
  : value
/** Claude Code's hash of a message: sha256 of its JSON with keys sorted at every depth. */
export const transcriptHashOf = (message: unknown): string => createHash('sha256').update(JSON.stringify(sortKeys(message))).digest('hex')

interface Read { ino: number; offset: number; partial: Buffer; state: TranscriptState; idle: NodeJS.Timeout | null }
const cache = new Map<string, Read>()
const reading = new Map<string, Promise<TranscriptState | null>>()

function feedLines(read: Read, bytes: Buffer): void {
  const end = bytes.lastIndexOf(10)
  if (end < 0) { read.partial = bytes; return }
  // Split on the newline byte, so a character of several bytes is never cut in two.
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue /* not a record Claude Code wrote whole */ }
    feedTranscript(read.state, entry, transcriptHashOf)
  }
  read.partial = Buffer.from(bytes.subarray(end + 1))
}

async function refresh(path: string): Promise<TranscriptState | null> {
  let info
  try { info = await stat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    forget(path)
    return null
  }
  let read = cache.get(path)
  if (!read || read.ino !== info.ino || info.size < read.offset) {
    forget(path)
    read = { ino: info.ino, offset: 0, partial: Buffer.alloc(0), state: emptyTranscript(), idle: null }
  }
  cache.delete(path)
  cache.set(path, read)
  for (const [stale, old] of cache) if (cache.size > CACHED_TRANSCRIPTS && stale !== path) { clearTimeout(old.idle ?? undefined); cache.delete(stale) }
  if (read.idle) clearTimeout(read.idle)
  read.idle = setTimeout(() => forget(path), TRANSCRIPT_IDLE_MS)
  read.idle.unref()

  if (info.size > read.offset) {
    const file = await open(path, 'r')
    try {
      while (read.offset < info.size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, info.size - read.offset))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, read.offset)
        if (bytesRead === 0) break
        read.offset += bytesRead
        feedLines(read, Buffer.concat([read.partial, chunk.subarray(0, bytesRead)]))
      }
    } finally {
      await file.close()
    }
  }
  return read.state
}

function forget(path: string): void {
  const read = cache.get(path)
  if (read?.idle) clearTimeout(read.idle)
  cache.delete(path)
}

/** The transcript at `path`, read up to its end, or null when there is no such file. Reads of one path take turns. */
export function transcriptAt(path: string): Promise<TranscriptState | null> {
  const next = (reading.get(path) ?? Promise.resolve(null)).catch(() => null).then(() => refresh(path))
  reading.set(path, next)
  void next.finally(() => { if (reading.get(path) === next) reading.delete(path) }).catch(() => {})
  return next
}
