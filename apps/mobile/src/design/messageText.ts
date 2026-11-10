// A message's text as blocks and inline runs. Pure, so it's tested under node; Markdown.tsx and Bubble.tsx only render it.

export interface TextSegment { code: boolean; text: string; lang?: string }

/** Text and fenced code blocks, in order. An unclosed fence runs to the end. */
export function segments(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let buf: string[] = []
  let code: { lang: string } | null = null
  const flush = () => {
    if (code) out.push({ code: true, text: buf.join('\n'), lang: code.lang || undefined })
    else {
      const t = buf.join('\n').replace(/^\s*\n|\n\s*$/g, '')
      if (t.trim()) out.push({ code: false, text: t })
    }
    buf = []
  }
  for (const line of text.split('\n')) {
    const fence = /^\s*```\s*([\w+.#-]*)\s*$/.exec(line)
    if (fence && !code) {
      flush()
      code = { lang: fence[1]! }
    } else if (fence && code && !fence[1]) {
      flush()
      code = null
    } else buf.push(line)
  }
  flush()
  return out.length ? out : [{ code: false, text: '' }]
}

/** Bare web addresses as markdown links; not inside `code` or an existing link; trailing punctuation stays text. */
export function linkify(text: string): string {
  return text.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[^(<\[\w/])(https?:\/\/[^\s<>()\[\]`]+)/g, (_m, pre: string, url: string) => {
      const tail = /[.,;:!?'"]+$/.exec(url)?.[0] ?? ''
      const u = tail ? url.slice(0, -tail.length) : url
      return `${pre}[${u}](${u})${tail}`
    }))).join('')
}

export type InlineRun =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'bold' | 'italic'; children: InlineRun[] }
  | { kind: 'link'; text: string; url: string }

export function parseInline(s: string): InlineRun[] {
  const out: InlineRun[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*?\*)|(\b_[^_\s][^_]*?_\b)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) })
    const x = m[0]
    if (m[1]) out.push({ kind: 'code', text: x.slice(1, -1) })
    else if (m[2] || m[3]) out.push({ kind: 'bold', children: parseInline(x.slice(2, -2)) })
    else if (m[4]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(x)!
      out.push({ kind: 'link', text: link[1]!, url: link[2]! })
    } else out.push({ kind: 'italic', children: parseInline(x.slice(1, -1)) })
    last = m.index + x.length
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) })
  return out
}

export type TextBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; text: string; indent: number }
  | { kind: 'numbered'; number: string; text: string; indent: number }
  | { kind: 'quote'; text: string }

export function parseBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', text: para.join('\n') })
    para = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let m: RegExpExecArray | null
    if (!line.trim()) {
      flush()
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush()
      out.push({ kind: 'heading', level: m[1]!.length, text: m[2]! })
    } else if ((m = /^(\s*)[-*•]\s+(.*)$/.exec(line))) {
      flush()
      out.push({ kind: 'bullet', text: m[2]!, indent: Math.floor(m[1]!.length / 2) })
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) {
      flush()
      out.push({ kind: 'numbered', number: m[2]!, text: m[3]!, indent: Math.floor(m[1]!.length / 2) })
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush()
      out.push({ kind: 'quote', text: m[1]! })
    } else para.push(line)
  }
  flush()
  return out
}

// ---- @mentions ----

export interface MentionOption { label: string; insert: string }

/** The @word the cursor is in, and who it can complete to; null when it isn't in one. */
export function activeMention(text: string, cursor: number, options: readonly MentionOption[]) {
  const before = text.slice(0, cursor)
  const hit = /(?:^|[^\w@./-])@([\w./-]*)$/.exec(before)
  if (!hit) return null
  const q = hit[1]!.toLowerCase()
  const start = cursor - hit[1]!.length - 1
  return { start, end: cursor, options: options.filter((o) => o.insert.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) }
}
