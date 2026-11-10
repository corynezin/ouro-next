// Markdown as agents write it: paragraphs, headings, - / 1. lists, > quotes, **bold**, *italic*, `code`, [links](url) and
// bare web addresses.
import { Fragment, type ReactNode } from 'react'
import { Linking, StyleSheet, Text, View, type ColorValue, type TextStyle } from 'react-native'
import { C } from './colors.ts'
import { linkify, parseBlocks, parseInline, type InlineRun } from './messageText.ts'
import { wordsPresses } from './bubbleActions.ts'

export function openLink(url: string) {
  Linking.openURL(url).catch(() => {})
}

function renderInline(parts: InlineRun[], o: { linkColor: ColorValue; codeBg: ColorValue; onLongPress?: () => void }, key = ''): ReactNode[] {
  return parts.map((p, i) => {
    const k = key + i
    switch (p.kind) {
      case 'text': return <Fragment key={k}>{p.text}</Fragment>
      case 'code': return <Text key={k} style={{ fontFamily: 'Menlo', fontSize: 14, backgroundColor: o.codeBg }}>{p.text}</Text>
      case 'bold': return <Text key={k} style={{ fontWeight: '700' }}>{renderInline(p.children, o, k)}</Text>
      case 'italic': return <Text key={k} style={{ fontStyle: 'italic' }}>{renderInline(p.children, o, k)}</Text>
      case 'link': return <Text key={k} style={{ color: o.linkColor, textDecorationLine: 'underline' }} onPress={() => openLink(p.url)} onLongPress={o.onLongPress}>{p.text}</Text>
    }
  })
}

export function Markdown({ text, color = C.label, linkColor = C.link, fontSize = 16, style, onLongPress, linksOnly, onPress }: {
  text: string; color?: ColorValue; linkColor?: ColorValue; fontSize?: number; style?: TextStyle; onLongPress?: () => void
  /** The text sits in a Pressable that handles long presses itself, unless the text takes taps (see wordsPresses). */
  linksOnly?: boolean
  /** A tap on the text (not a link): the bubble's tap (text inside a Pressable keeps taps to itself). */
  onPress?: () => void
}) {
  const o = { linkColor, codeBg: 'rgba(127,127,127,0.18)', onLongPress }
  const blockLong = wordsPresses(linksOnly ?? false, onPress, onLongPress).onLongPress
  const base: TextStyle = { color, fontSize, lineHeight: Math.round(fontSize * 1.3), ...style }
  const blocks = parseBlocks(linkify(text))
  const only = blocks[0]
  if (blocks.length === 1 && only?.kind === 'paragraph') return <Text style={base} onLongPress={blockLong} onPress={onPress}>{renderInline(parseInline(only.text), o)}</Text>
  return (
    <View style={{ gap: 4 }}>
      {blocks.map((b, i) => {
        const kids = renderInline(parseInline(b.text), o)
        switch (b.kind) {
          case 'heading': return <Text key={i} onLongPress={blockLong} onPress={onPress} style={[base, { fontWeight: '700', fontSize: fontSize + (b.level <= 2 ? 3 : 1) }]}>{kids}</Text>
          case 'bullet':
          case 'numbered': return (
            <View key={i} style={[s.li, { paddingLeft: b.indent * 14 }]}>
              <Text style={[base, s.mark]}>{b.kind === 'bullet' ? '•' : `${b.number}.`}</Text>
              <Text style={[base, { flex: 1, minWidth: 0 }]} onLongPress={blockLong} onPress={onPress}>{kids}</Text>
            </View>)
          case 'quote': return <View key={i} style={s.quote}><Text style={[base, { opacity: 0.8 }]} onLongPress={blockLong} onPress={onPress}>{kids}</Text></View>
          case 'paragraph': return <Text key={i} style={base} onLongPress={blockLong} onPress={onPress}>{kids}</Text>
        }
      })}
    </View>
  )
}

const s = StyleSheet.create({
  li: { flexDirection: 'row', gap: 6 },
  mark: { minWidth: 12 },
  quote: { borderLeftWidth: 3, borderLeftColor: 'rgba(127,127,127,0.5)', paddingLeft: 8 },
})
