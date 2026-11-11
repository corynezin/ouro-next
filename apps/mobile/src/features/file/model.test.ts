import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMarkdownFile, markdownLinkAction, markdownToHtml, sharedFileName } from './model.ts'

test('Markdown files are told apart by their extension', () => {
  assert.equal(isMarkdownFile('README.md'), true)
  assert.equal(isMarkdownFile('notes.MARKDOWN'), true)
  assert.equal(isMarkdownFile('photo.png'), false)
  assert.equal(isMarkdownFile('md'), false)
  assert.equal(isMarkdownFile('archive.md.zip'), false)
})

test('a Markdown file becomes a UTF-8 page with GFM tables, task lists and code', () => {
  const page = markdownToHtml('# Café ☕\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```ts\nconst x = 1 < 2\n```\n')
  assert.match(page, /^<!doctype html>/)
  assert.match(page, /<meta charset="utf-8">/)
  assert.match(page, /<h1>Café ☕<\/h1>/)
  assert.match(page, /<table>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/)
  assert.match(page, /<input checked="" disabled="" type="checkbox">/)
  assert.match(page, /<code class="language-ts">const x = 1 &lt; 2/)
})

test('raw HTML in a Markdown file is shown as text, never run', () => {
  const page = markdownToHtml('<script>alert(1)</script>\n\nInline <img src=x onerror="alert(1)"> and <b>bold</b>.\n')
  const body = page.slice(page.indexOf('<body>'))
  assert.doesNotMatch(body, /<script|<img|<b>/)
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(body, /&lt;b&gt;bold&lt;\/b&gt;/)
})

test('links in a Markdown file: anchors stay, web and mail open outside, anything else is ignored', () => {
  assert.equal(markdownLinkAction('about:blank'), 'load')
  assert.equal(markdownLinkAction('about:blank#setup'), 'load')
  assert.equal(markdownLinkAction('https://example.com/a'), 'open')
  assert.equal(markdownLinkAction('HTTP://example.com'), 'open')
  assert.equal(markdownLinkAction('mailto:someone@example.com'), 'open')
  assert.equal(markdownLinkAction('javascript:alert(1)'), 'block')
  assert.equal(markdownLinkAction('file:///etc/passwd'), 'block')
  assert.equal(markdownLinkAction('other.md'), 'block')
})

test('a shared copy is saved under the file name, never a path', () => {
  assert.equal(sharedFileName('a/b\\c.md'), 'a_b_c.md')
  assert.equal(sharedFileName(''), 'file')
})
