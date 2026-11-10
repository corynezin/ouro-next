import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avatarModel } from './avatarModel.ts'
import { bubbleActions, textActions, wordsPresses } from './bubbleActions.ts'
import { tapChoice } from './choiceTap.ts'
import { attachOptions, COMPOSER_COPY, composedSend, draftWithTakenBack, pickedAssetFile } from './composerText.ts'
import { ago, capPct, dateStampOf, dateTimeOf, foldForSearch, formatSize, money, oneLine, timeOfDay, timerText, tokensText, untilText } from './format.ts'
import { activeMention, linkify, parseBlocks, parseInline, segments } from './messageText.ts'
import { senderColor, senderColors, tint } from './theme.ts'

test('ago reads as the reference does', () => {
  const now = 100_000_000
  assert.equal(ago(now - 30_000, now), 'now')
  assert.equal(ago(now - 5 * 60_000, now), '5m')
  assert.equal(ago(now - 3 * 3_600_000, now), '3h')
  assert.equal(ago(now - 2 * 86_400_000, now), '2d')
  assert.equal(ago(now - 13 * 86_400_000, now), '13d')
  assert.equal(ago(now - 42 * 86_400_000, now), '6w')
  assert.equal(ago(now + 5000, now), 'now')
})

test('amounts read as the reference does', () => {
  assert.equal(money(1.2), '$1.20')
  assert.equal(capPct(0.42), '42%')
  assert.equal(capPct(0.004), '0.4%')
  assert.equal(capPct(0.0004), '<0.1%')
  assert.equal(capPct(0), '0%')
  assert.equal(tokensText(120_500), '120k')
  assert.equal(tokensText(999), '999')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
  assert.equal(timerText(65_000), '1:05')
  assert.equal(oneLine('a\n\nb\r\nc'), 'a b c')
  assert.equal(foldForSearch('Éa'), 'ea')
})

test("times read in the phone's locale as the reference's: the time of day, a day with it, and until-when by whether it is today", () => {
  const at = new Date(2026, 10, 4, 9, 5).getTime()
  assert.equal(timeOfDay(at), new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  assert.equal(dateTimeOf(at), new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  assert.match(timeOfDay(at), /9.05/)
  assert.ok(!/2026/.test(dateTimeOf(at)), 'no year')
  assert.equal(untilText(at, new Date(2026, 10, 4, 23, 59).getTime()), timeOfDay(at), 'today: the time alone')
  assert.equal(untilText(at, new Date(2026, 10, 3, 9, 5).getTime()), dateTimeOf(at), 'another day: with the day')
})

test('fenced code splits from text; an unclosed fence runs to the end; a language stays', () => {
  assert.deepEqual(segments('hi\n```ts\nconst a\n```\nbye'), [
    { code: false, text: 'hi' }, { code: true, text: 'const a', lang: 'ts' }, { code: false, text: 'bye' },
  ])
  assert.deepEqual(segments('```\nopen'), [{ code: true, text: 'open', lang: undefined }])
  assert.deepEqual(segments(''), [{ code: false, text: '' }])
})

test('bare addresses link, except in code or an existing link, and punctuation stays out', () => {
  assert.equal(linkify('see https://a.b/c.'), 'see [https://a.b/c](https://a.b/c).')
  assert.equal(linkify('`https://a.b`'), '`https://a.b`')
  assert.equal(linkify('[x](https://a.b)'), '[x](https://a.b)')
})

test('inline runs: bold, italic, code, links, nesting', () => {
  assert.deepEqual(parseInline('a **b** `c`'), [
    { kind: 'text', text: 'a ' }, { kind: 'bold', children: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'c' },
  ])
  assert.deepEqual(parseInline('*x*'), [{ kind: 'italic', children: [{ kind: 'text', text: 'x' }] }])
  assert.deepEqual(parseInline('[t](http://u)'), [{ kind: 'link', text: 't', url: 'http://u' }])
  assert.deepEqual(parseInline('snake_case_word'), [{ kind: 'text', text: 'snake_case_word' }])
})

test('blocks: headings, nested bullets, numbers with . and ), quotes, paragraphs', () => {
  assert.deepEqual(parseBlocks('# T\n\npara\nmore\n- a\n  - b\n1. c\n2) d\n> q'), [
    { kind: 'heading', level: 1, text: 'T' },
    { kind: 'paragraph', text: 'para\nmore' },
    { kind: 'bullet', text: 'a', indent: 0 },
    { kind: 'bullet', text: 'b', indent: 1 },
    { kind: 'numbered', number: '1', text: 'c', indent: 0 },
    { kind: 'numbered', number: '2', text: 'd', indent: 0 },
    { kind: 'quote', text: 'q' },
  ])
})

test('the @word at the cursor completes to matching members', () => {
  const options = [{ label: 'Sam', insert: 'sam' }, { label: 'fixer', insert: 'fixer' }]
  assert.deepEqual(activeMention('hi @fi', 6, options), { start: 3, end: 6, options: [options[1]] })
  assert.equal(activeMention('hi there', 8, options), null)
  assert.equal(activeMention('a@fi', 4, options), null)
  assert.equal(activeMention('@', 1, options)?.options.length, 2)
})

test('sender colours are stable and from the palette; tint is rgba', () => {
  assert.equal(senderColor('alice'), senderColor('alice'))
  assert.ok(senderColors.includes(senderColor('bob')))
  assert.equal(tint('#FF9500', 0.22), 'rgba(255, 149, 0, 0.22)')
})

test('model aliases and full ids share the same visuals', () => {
  for (const [alias, full] of [
    ['or-haiku', 'anthropic/claude-haiku-5.5'],
    ['sonnet', 'claude-sonnet-5-5[1m]'],
    ['deepseek', 'deepseek/deepseek-v4-pro'],
    ['deepseek-flash', 'deepseek/deepseek-v4.1-flash'],
    ['gemini-flash', 'google/gemini-3.8-flash'],
    ['qwen-coder', 'qwen/qwen3-coder'],
  ] as const) assert.deepEqual(avatarModel(alias), avatarModel(full), `${alias} / ${full}`)
})

test('unfamiliar models of a known company keep the company and no guessed tier', () => {
  assert.deepEqual(avatarModel('gpt-future'), { company: 'openai', capability: undefined })
  assert.deepEqual(avatarModel('google/gemini-future'), { company: 'google', capability: undefined })
  assert.deepEqual(avatarModel('gpt-6.1-sol'), { company: 'openai', capability: 'balanced' })
  assert.deepEqual(avatarModel('gpt-6-astra'), { company: 'openai', capability: 'flagship' })
})

test('avatars classify models by company and tier, and unknown ones stay neutral', () => {
  assert.deepEqual(avatarModel('opus'), { company: 'anthropic', capability: 'flagship' })
  assert.deepEqual(avatarModel('sonnet[1m]'), { company: 'anthropic', capability: 'balanced' })
  assert.deepEqual(avatarModel('or-haiku'), { company: 'anthropic', capability: 'fast' })
  assert.deepEqual(avatarModel('gpt-5-luna'), { company: 'openai', capability: 'fast' })
  assert.deepEqual(avatarModel('gemini-flash'), { company: 'google', capability: 'fast' })
  assert.deepEqual(avatarModel('deepseek'), { company: 'deepseek', capability: 'flagship' })
  assert.deepEqual(avatarModel('deepseek-flash'), { company: 'deepseek', capability: 'fast' })
  assert.deepEqual(avatarModel('qwen-coder'), { company: 'qwen', capability: 'balanced' })
  assert.deepEqual(avatarModel('mystery'), {})
  assert.deepEqual(avatarModel(undefined), {})
})

test('an agent\'s start reads as the reference has it: YYYY-MM-DD HH:MM, in local time', () => {
  assert.equal(dateStampOf(new Date(2026, 10, 9, 16, 3).getTime()), '2026-11-09 16:03')
  assert.equal(dateStampOf(new Date(2027, 0, 1, 0, 0).getTime()), '2027-01-01 00:00')
})

test('avatar tiers follow UI-11: each family, the company prefixes, and a trailing [..] ignored', () => {
  for (const [model, capability] of [
    ['haiku', 'fast'], ['anthropic/claude-opus-5-5', 'flagship'],
    ['gpt-5.6-mini', 'fast'], ['codex-nano', 'fast'], ['gpt-6-terra', 'balanced'], ['openai/gpt-6-pro', 'flagship'],
    ['gemini-pro', 'flagship'], ['google/gemini-3.8-flash', 'fast'],
    ['deepseek-pro', 'flagship'], ['deepseek/deepseek-v4-flash', 'fast'],
    ['qwen-coder[32k]', 'balanced'],
  ] as const) assert.equal(avatarModel(model).capability, capability, model)
  assert.equal(avatarModel('qwen-max').capability, undefined, 'a Qwen other than coder is unknown')
})

test('a choice tap buzzes only when the caller takes it, so a second tap it ignores is felt as nothing (CHAT-55)', () => {
  let buzzes = 0
  const buzz = () => { buzzes++ }
  tapChoice('yes', () => true, buzz)
  tapChoice('yes', () => false, buzz)
  tapChoice('yes', () => {}, buzz)
  assert.equal(buzzes, 2)
})

test('the composer: the attach sheet, picked files named, a failed send taken back on a new line, and what Send sends', () => {
  // CHAT-58: Paste image only while the clipboard holds one.
  assert.deepEqual(attachOptions(false).map((option) => option.title), ['Photo Library', 'Camera', 'Files'])
  assert.deepEqual(attachOptions(true).map((option) => option.title), ['Photo Library', 'Camera', 'Files', 'Paste image'])
  // CHAT-60, CHAT-61, CHAT-74: the pickers' words, and names for what has none.
  assert.equal(COMPOSER_COPY.cameraDenied, 'Ouro may not use the camera (Settings → Ouro).')
  assert.equal(COMPOSER_COPY.clipboardHasNoImage, 'The clipboard has no image.')
  assert.equal(COMPOSER_COPY.pastedFileName, 'pasted.png')
  assert.deepEqual(pickedAssetFile({ fileName: 'IMG_1.JPG', type: 'image', mimeType: 'image/jpeg' }, 7), { fileName: 'IMG_1.JPG', mimeType: 'image/jpeg', isImage: true })
  assert.deepEqual(pickedAssetFile({ type: 'image', mimeType: 'image/jpeg' }, 7), { fileName: 'photo-7.jpg', mimeType: 'image/jpeg', isImage: true })
  assert.deepEqual(pickedAssetFile({ type: 'video', mimeType: 'video/quicktime' }, 7), { fileName: 'video-7.mov', mimeType: 'video/quicktime', isImage: false })
  assert.deepEqual(pickedAssetFile({ type: 'video' }, 7), { fileName: 'video-7.mov', mimeType: 'video/quicktime', isImage: false })
  // CHAT-23: Edit joins the draft on a new line.
  assert.equal(draftWithTakenBack('', 'again'), 'again')
  assert.equal(draftWithTakenBack('first', 'again'), 'first\nagain')
  // CHAT-64: trimmed, and files alone send.
  assert.deepEqual(composedSend('  hi  ', 0), { sendable: true, text: 'hi' })
  assert.deepEqual(composedSend('   ', 0), { sendable: false, text: '' })
  assert.deepEqual(composedSend('', 2), { sendable: true, text: '' })
})

test("a bubble's long-press: its own actions, then Copy and Select text for its words; a done report's summary has those two (CHAT-21, CHAT-43)", () => {
  const did: string[] = []
  const handlers = { copyText: (text: string) => did.push(`copy ${text}`), selectText: (text: string) => did.push(`select ${text}`) }
  const retry = { title: 'Retry', onPress: () => did.push('retry') }
  const sheet = bubbleActions([retry], 'hello', handlers)
  assert.deepEqual(sheet.map((action) => action.title), ['Retry', 'Copy', 'Select text'])
  for (const action of sheet) action.onPress()
  assert.deepEqual(did, ['retry', 'copy hello', 'select hello'])
  assert.deepEqual(bubbleActions([retry], '', handlers).map((action) => action.title), ['Retry'], 'a file with no words has nothing to copy')
  assert.deepEqual(textActions('the summary', handlers).map((action) => action.title), ['Copy', 'Select text'])
})

test("a failed bubble's words take its long-press as well as its tap, so the long-press still has Copy and Select text (CHAT-21)", () => {
  const tap = () => {}
  const longPress = () => {}
  assert.deepEqual(wordsPresses(true, tap, longPress), { onPress: tap, onLongPress: longPress }, 'words with a tap take the touch, so the long-press too')
  assert.deepEqual(wordsPresses(true, undefined, longPress), { onPress: undefined, onLongPress: undefined }, 'otherwise the Pressable has both')
  assert.deepEqual(wordsPresses(false, undefined, longPress), { onPress: undefined, onLongPress: longPress }, 'outside a Pressable the words take it')
})
