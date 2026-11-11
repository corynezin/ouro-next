// A file sent in a chat, opened on its own screen: what the screen and its share button need beyond the attachment.
import { marked, Renderer } from 'marked'

/** The name a shared copy is saved under in the cache: the file's own name, never a path. */
export function sharedFileName(fileName: string): string {
  return fileName.replace(/[/\\]/g, '_') || 'file'
}

/** Files the screen shows formatted: Markdown, read as UTF-8 (a web view shown the raw file guesses the encoding and garbles it). */
export function isMarkdownFile(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName)
}

export const FILE_COPY = {
  shareFailed: "Couldn't share it",
  httpError: (status: number) => `HTTP ${status}`,
}

const MARKDOWN_CSS = `
:root { color-scheme: light dark; }
html, body { background: transparent; }
body { font-family: -apple-system, sans-serif; font-size: 17px; line-height: 1.5; margin: 16px; word-wrap: break-word; }
h1, h2 { border-bottom: 1px solid rgba(127,127,127,.3); padding-bottom: .25em; }
h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; }
code { font-family: Menlo, monospace; font-size: .85em; background: rgba(127,127,127,.18); padding: .1em .3em; border-radius: 4px; }
pre { background: rgba(127,127,127,.15); padding: 12px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid rgba(127,127,127,.4); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: rgba(127,127,127,.15); }
blockquote { margin-left: 0; padding-left: 12px; border-left: 4px solid rgba(127,127,127,.4); opacity: .85; }
img { max-width: 100%; } a { color: #0a84ff; }
`

/** A Markdown file as a standalone HTML page (GFM: tables, task lists, fenced code). Raw HTML in it is shown as text. */
export function markdownToHtml(source: string): string {
  const body = marked.parse(source, { gfm: true, async: false, renderer: escapingRenderer })
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${MARKDOWN_CSS}</style></head><body>${body}</body></html>`
}

const escapingRenderer = new Renderer()
escapingRenderer.html = ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What a tap on a link in a rendered Markdown file does: in-page anchors stay, web and mail links open outside, the rest do nothing. */
export function markdownLinkAction(url: string): 'load' | 'open' | 'block' {
  if (url.startsWith('about:')) return 'load'
  if (/^(https?|mailto):/i.test(url)) return 'open'
  return 'block'
}
