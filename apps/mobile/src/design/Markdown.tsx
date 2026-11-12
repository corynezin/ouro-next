// Markdown as agents write it: paragraphs, headings, - / 1. lists, > quotes, **bold**, *italic*, `code`, [links](url) and
// bare web addresses.
import { Fragment, type ReactNode } from 'react'
import { Linking, StyleSheet, Text, View, type ColorValue, type TextStyle } from 'react-native'
import { C, useDark } from './colors.ts'
import { Symbol } from './Symbol.tsx'
import { linkify, parseBlocks, parseInline, type InlineRun } from './messageText.ts'
import { wordsPresses } from './bubbleActions.ts'
import { parseUpdateMarkUrl } from '@ouro/contract'
import { useUpdateMark, type UpdateMarkTone } from './UpdateMarks.tsx'

// [light, dark]: deeper tones than the system colors, which read garish as text on a gray bubble.
type MarkLook = { symbol: string; ink: [string, string]; wash: [string, string] }
const MARK_LOOK: Record<UpdateMarkTone, MarkLook> = {
  in_app: { symbol: 'checkmark.circle.fill', ink: ['#1F7A3A', '#5BD88A'], wash: ['rgba(52,199,89,0.16)', 'rgba(48,209,88,0.18)'] },
  not_yet: { symbol: 'arrow.down.circle.fill', ink: ['#A65A00', '#FFB547'], wash: ['rgba(255,149,0,0.16)', 'rgba(255,159,10,0.18)'] },
  unsure: { symbol: 'questionmark.circle.fill', ink: ['#6C6C70', '#AEAEB2'], wash: ['rgba(127,127,127,0.14)', 'rgba(127,127,127,0.22)'] },
}

/** An agent's `ouro publish` mark: whether that update is in this app, as the root says, in this kit's colors. */
function useMark(updateNumber: number, machineId: string) {
  const dark = useDark() ? 1 : 0
  const mark = useUpdateMark(updateNumber, machineId)
  const look = MARK_LOOK[mark.tone]
  return { text: mark.text, inlineText: mark.inlineText, symbol: look.symbol, ink: look.ink[dark], wash: look.wash[dark] }
}

/** A mark inside a sentence: tinted text. */
function UpdateMark({ updateNumber, machineId, onLongPress }: { updateNumber: number; machineId: string; onLongPress?: () => void }) {
  const mark = useMark(updateNumber, machineId)
  return <Text style={{ color: mark.ink, fontWeight: '600' }} onLongPress={onLongPress}>{mark.inlineText}</Text>
}

/** A mark on a line of its own: a capsule with its symbol. */
function UpdateMarkPill({ updateNumber, machineId, onLongPress, onPress, fontSize }: { updateNumber: number; machineId: string; onLongPress?: () => void; onPress?: () => void; fontSize: number }) {
  const mark = useMark(updateNumber, machineId)
  return (
    <View style={[s.pill, { backgroundColor: mark.wash }]}>
      <Symbol name={mark.symbol} size={fontSize} color={mark.ink} />
      <Text style={{ color: mark.ink, fontWeight: '600', fontSize: fontSize - 1, flexShrink: 1 }} onLongPress={onLongPress} onPress={onPress}>{mark.text}</Text>
    </View>
  )
}

/** The mark a paragraph is made of, alone, or null. */
function loneMark(text: string) {
  const runs = parseInline(text.trim())
  const only = runs.length === 1 ? runs[0] : undefined
  return only?.kind === 'link' ? parseUpdateMarkUrl(only.url) : null
}

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
      case 'link': {
        const mark = parseUpdateMarkUrl(p.url)
        if (mark) return <UpdateMark key={k} {...mark} onLongPress={o.onLongPress} />
        return <Text key={k} style={{ color: o.linkColor, textDecorationLine: 'underline' }} onPress={() => openLink(p.url)} onLongPress={o.onLongPress}>{p.text}</Text>
      }
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
  const lone = only?.kind === 'paragraph' && blocks.length === 1 ? loneMark(only.text) : null
  if (lone) return <UpdateMarkPill {...lone} onLongPress={blockLong} onPress={onPress} fontSize={fontSize} />
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
          case 'paragraph': {
            const mark = loneMark(b.text)
            if (mark) return <UpdateMarkPill key={i} {...mark} onLongPress={blockLong} onPress={onPress} fontSize={fontSize} />
            return <Text key={i} style={base} onLongPress={blockLong} onPress={onPress}>{kids}</Text>
          }
        }
      })}
    </View>
  )
}

const s = StyleSheet.create({
  li: { flexDirection: 'row', gap: 6 },
  mark: { minWidth: 12 },
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingVertical: 5, paddingLeft: 8, paddingRight: 11, borderRadius: 999, marginVertical: 2 },
  quote: { borderLeftWidth: 3, borderLeftColor: 'rgba(127,127,127,0.5)', paddingLeft: 8 },
})
