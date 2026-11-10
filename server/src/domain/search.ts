// Message search: every word of the query, anywhere in the text, in any case. Pure; the store does the finding.

const EXCERPT_CHARS = 200

/** The query's words, lowercased, without repeats. Empty: nothing to search for. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

export function containsEveryWord(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return words.every((word) => lower.includes(word))
}

/** About 200 characters around the first matched word, on one line, with `…` where cut; and that word as written. */
export function excerptAround(text: string, words: readonly string[]): { excerpt: string; match: string } {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const lower = oneLine.toLowerCase()
  const first = words
    .map((word) => ({ word, at: lower.indexOf(word) }))
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)[0]
  if (!first) return { excerpt: oneLine.slice(0, EXCERPT_CHARS), match: '' }
  const start = Math.max(0, Math.min(first.at - Math.floor((EXCERPT_CHARS - first.word.length) / 2), oneLine.length - EXCERPT_CHARS))
  const end = Math.min(oneLine.length, start + EXCERPT_CHARS)
  const excerpt = `${start > 0 ? '…' : ''}${oneLine.slice(start, end)}${end < oneLine.length ? '…' : ''}`
  return { excerpt, match: oneLine.slice(first.at, first.at + first.word.length) }
}
