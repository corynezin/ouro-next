// One message: files above the text, time and receipt (or a footnote) under it; yours on the right in the theme colour.
// Fenced code as monospaced blocks with Copy; a folded done report under its message. Long-press: Copy / Select text.
// In a group, `sender` labels and colours everyone else's. Renders only: what's shown comes in through props.
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { Image } from 'expo-image'
import type { ChooseChoice } from './choiceTap.ts'
import { AskChoices } from './AskChoices.tsx'
import { C } from './colors.ts'
import { timeOfDay } from './format.ts'
import { Markdown } from './Markdown.tsx'
import { actionSheet } from './menus.tsx'
import { bubbleActions } from './bubbleActions.ts'
import type { BubbleAction } from './bubbleActions.ts'
import { segments } from './messageText.ts'
import { Symbol } from './Symbol.tsx'
import { myBubble, senderColor, tint } from './theme.ts'
import { toast } from './Toast.tsx'

export function copyText(text: string, what = 'Copied') {
  Clipboard.setStringAsync(text)
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
  toast(what)
}

export interface BubbleFile {
  key: string
  fileName: string
  isImage: boolean
  /** "2.1 MB", when known. */
  sizeText: string | null
  /** Where to load an image from. Null for a file that isn't shown inline. */
  imageSource: { uri: string; headers: Record<string, string> } | null
  onOpen: () => void
}


export function Bubble({ text, sentAt, mine, sender, files = [], receipt, footnote, failed, faded, choices, avatar, onPress, extraActions, onSelectText }: {
  text: string
  sentAt: number
  mine: boolean
  /** Who said it, in a group. */
  sender?: string
  files?: readonly BubbleFile[]
  receipt?: string | null
  footnote?: string
  failed?: boolean
  faded?: boolean
  /** Tappable answers to the ask this message posed. */
  choices?: { options: readonly string[]; onChoose: ChooseChoice } | null
  /** A small element left of the bubble, only on others' messages. */
  avatar?: ReactNode
  onPress?: () => void
  extraActions?: readonly BubbleAction[]
  onSelectText: (text: string) => void
}) {
  const senderHue = sender ? senderColor(sender) : null
  const handlers = { copyText, selectText: onSelectText }
  const menu = () => actionSheet(undefined, bubbleActions(extraActions ?? [], text, handlers))
  const fg = mine ? 'white' : C.label
  const col = (
    <View style={[s.col, !!avatar && !mine && s.avatarCol, mine ? s.mine : s.theirs, faded && { opacity: 0.7 }]}>
      {sender ? <Text style={[s.person, senderHue ? { color: senderHue } : null]}>{sender}</Text> : null}
      {files.map((f) => <FileView key={f.key} file={f} onLongPress={menu} />)}
      {(!!text || !files.length) && (
        <Pressable onPress={onPress} onLongPress={menu} delayLongPress={350}
          style={[s.bubble, text.includes('\n') && s.multilineBubble, { backgroundColor: failed ? 'rgba(255,59,48,0.75)' : mine ? myBubble : senderHue ? tint(senderHue, 0.22) : C.fill }]}>
          <Body text={text} mine={mine} color={fg} onLongPress={menu} onPress={onPress} />
        </Pressable>
      )}
      {choices ? <AskChoices choices={choices.options} onChoose={choices.onChoose} /> : null}
      <Text style={s.meta} onPress={onPress}>{timeOfDay(sentAt)}{footnote ? <Text style={{ color: failed ? C.red : C.secondary }}>  {footnote}</Text> : receipt ? `  ${receipt}` : ''}</Text>
    </View>
  )
  if (avatar && !mine) return <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>{avatar}{col}</View>
  return col
}

/** A message's text: markdown, with fenced code as blocks. */
export function Body({ text, mine, color, onLongPress, onPress }: { text: string; mine: boolean; color: ColorValue; onLongPress?: () => void; onPress?: () => void }) {
  const parts = segments(text)
  const linkColor = mine ? 'white' : C.link
  if (!parts.some((p) => p.code)) return <Markdown text={text} color={color} linkColor={linkColor} onLongPress={onLongPress} onPress={onPress} linksOnly />
  return (
    <View style={{ gap: 8 }}>
      {parts.map((p, i) => p.code ? <CodeBlock key={i} code={p.text} lang={p.lang} mine={mine} />
        : <Markdown key={i} text={p.text} color={color} linkColor={linkColor} onLongPress={onLongPress} onPress={onPress} linksOnly />)}
    </View>
  )
}

export function CodeBlock({ code, lang, mine }: { code: string; lang?: string; mine: boolean }) {
  return (
    <View style={[s.code, { backgroundColor: mine ? 'rgba(0,0,0,0.2)' : 'rgba(127,127,127,0.12)' }]}>
      <View style={s.codeHead}>
        <Text style={[s.lang, { color: mine ? 'rgba(255,255,255,0.8)' : C.secondary }]}>{lang || 'code'}</Text>
        <Pressable onPress={() => copyText(code)} hitSlop={8} style={s.copy} accessibilityLabel="Copy code">
          <Symbol name="doc.on.doc" size={11} color={mine ? 'white' : 'blue'} />
          <Text style={{ fontSize: 11, color: mine ? 'white' : C.blue }}>Copy</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        <Text selectable style={[s.mono, { color: mine ? 'white' : C.label }]}>{code}</Text>
      </ScrollView>
    </View>
  )
}

/** A file in a message: an image inline (tap: full screen), other files as a chip (tap: open). */
function FileView({ file, onLongPress }: { file: BubbleFile; onLongPress?: () => void }) {
  const [ratio, setRatio] = useState(4 / 3)
  if (file.isImage && file.imageSource) return (
    <Pressable onPress={file.onOpen} onLongPress={onLongPress}>
      <Image source={file.imageSource} style={[s.image, { aspectRatio: ratio }]} contentFit="cover"
        transition={150} onLoad={(e) => { const { width, height } = e.source; if (width && height) setRatio(Math.max(0.5, Math.min(2.5, width / height))) }}
        accessibilityLabel={file.fileName} />
    </Pressable>
  )
  return (
    <Pressable onPress={file.onOpen} onLongPress={onLongPress} style={s.file}>
      <Symbol name="doc.fill" size={22} color="blue" />
      <View style={{ flexShrink: 1 }}>
        <Text style={{ color: C.label, fontSize: 15 }} numberOfLines={1}>{file.fileName}</Text>
        {file.sizeText && <Text style={{ color: C.secondary, fontSize: 12 }}>{file.sizeText}</Text>}
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  col: { gap: 3, maxWidth: '100%' },
  // Resolve the available width before measuring multiline markdown beside an avatar.
  avatarCol: { flex: 1, minWidth: 0 },
  mine: { alignItems: 'flex-end', paddingLeft: 40 },
  theirs: { alignItems: 'flex-start', paddingRight: 40 },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '100%' },
  // Give block markdown a definite width before Yoga measures list wrapping and height.
  // Intrinsic sizing here can shrink lists after measuring them, leaving text outside the bubble.
  multilineBubble: { alignSelf: 'stretch' },
  meta: { fontSize: 11, color: C.secondary },
  person: { fontSize: 12, fontWeight: '600', color: C.secondary },
  code: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 4, alignSelf: 'stretch' },
  codeHead: { flexDirection: 'row', alignItems: 'center' },
  lang: { fontSize: 11, fontWeight: '500', flex: 1 },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mono: { fontFamily: 'Menlo', fontSize: 13 },
  image: { width: 240, borderRadius: 14, backgroundColor: C.fill },
  file: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.fill, borderRadius: 12, padding: 10, maxWidth: 260 },
})
