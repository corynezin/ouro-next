// The message box, iMessage style: a round + (photos, camera, files, paste), a rounded field that grows, the send arrow
// inside it once there is something to send; picked files show as chips above it. In a group: @ suggests members.
import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { Image } from 'expo-image'
import { C } from './colors.ts'
import { pickAttachments, type ComposerFile } from './composerFiles.ts'
import { attachOptions, composedSend, draftWithTakenBack } from './composerText.ts'
import type { PickSource } from './composerText.ts'
import { formatSize } from './format.ts'
import { actionSheet } from './menus.tsx'
import { activeMention, type MentionOption } from './messageText.ts'
import { Symbol } from './Symbol.tsx'

export function Composer({ initialText, onTextChange, placeholder, onSend, onError, fill, noFiles, mentions }: {
  /** The saved draft, read once when the composer appears. */
  initialText: string
  onTextChange: (text: string) => void
  placeholder: string
  onSend: (text: string, files: ComposerFile[]) => void
  onError: (reason: string) => void
  /** Put text and files back (Edit on a failed message); a new key each time. */
  fill?: { key: string; text: string; files: ComposerFile[] } | null
  /** Text only (a group's posts): no +. */
  noFiles?: boolean
  /** Who @ can complete to. */
  mentions?: readonly MentionOption[]
}) {
  const [text, setText] = useState(initialText)
  useEffect(() => { onTextChange(text) }, [text])
  const [files, setFiles] = useState<ComposerFile[]>([])
  // clear of the home indicator when the keyboard is down (as iMessage); just above the keyboard when it is up
  const bottom = useSafeAreaInsets().bottom
  const [keyboardUp, setKeyboardUp] = useState(false)
  useEffect(() => {
    const a = Keyboard.addListener('keyboardWillShow', () => setKeyboardUp(true))
    const b = Keyboard.addListener('keyboardWillHide', () => setKeyboardUp(false))
    return () => { a.remove(); b.remove() }
  }, [])
  // a multiline field doesn't shrink back when cleared: a new one after each send (focus kept)
  const [fieldGeneration, setFieldGeneration] = useState(0)
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  useEffect(() => { if (fieldGeneration) input.current?.focus() }, [fieldGeneration])
  useEffect(() => {
    if (!fill) return
    setText((t) => draftWithTakenBack(t, fill.text))
    setFiles((f) => [...f, ...fill.files])
  }, [fill?.key])

  const add = async (source: PickSource) => {
    const picked = await pickAttachments(source)
    if (picked.kind === 'failed') onError(picked.reason)
    else if (picked.files.length) setFiles((f) => [...f, ...picked.files])
  }
  const attach = async () => {
    const hasImage = await Clipboard.hasImageAsync().catch(() => false)
    actionSheet(undefined, attachOptions(hasImage).map(({ source, title }) => ({ title, onPress: () => add(source) })))
  }
  // the @word being typed: the field's cursor, or the end before it has reported one
  const [cursor, setCursor] = useState<number | null>(null)
  const typing = mentions ? activeMention(text, cursor ?? text.length, mentions) : null
  const complete = (o: MentionOption) => {
    if (!typing) return
    setText(`${text.slice(0, typing.start)}@${o.insert} ${text.slice(typing.end)}`)
    setCursor(null)
  }
  const composed = composedSend(text, files.length)
  const can = composed.sendable
  const send = () => {
    if (!can) return
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSend(composed.text, files)
    setText('')
    setFiles([])
    setFieldGeneration((g) => g + 1)
  }

  return (
    <View style={[s.wrap, { paddingBottom: keyboardUp ? 0 : Math.max(bottom - 4, 0) }]}>
      {files.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {files.map((f) => (
            <View key={f.localId} style={s.chip}>
              {f.isImage ? <Image source={{ uri: f.uri }} style={s.thumb} contentFit="cover" /> : <Symbol name="doc" size={18} color="secondary" />}
              <View style={{ maxWidth: 120 }}>
                <Text style={s.chipName} numberOfLines={1}>{f.fileName}</Text>
                {f.byteLength > 0 && <Text style={s.chipSize}>{formatSize(f.byteLength)}</Text>}
              </View>
              <Pressable hitSlop={8} onPress={() => setFiles((x) => x.filter((y) => y.localId !== f.localId))} accessibilityLabel={`Remove ${f.fileName}`}>
                <Symbol name="xmark.circle.fill" size={16} color="secondary" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      {!!typing?.options.length && (
        <ScrollView keyboardShouldPersistTaps="always" style={s.mentions}>
          {typing.options.map((o) => (
            <Pressable key={o.insert} onPress={() => complete(o)} style={({ pressed }) => [s.mention, pressed && { backgroundColor: C.pressed }]}
              accessibilityLabel={`Mention ${o.label}`}>
              <Text style={s.mentionName} numberOfLines={1}>{o.label}</Text>
              <Text style={s.chipSize}>@{o.insert}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={s.row}>
        {!noFiles && (
          <Pressable onPress={attach} style={s.plus} accessibilityLabel="Attach">
            <Symbol name="plus" size={17} color="secondary" />
          </Pressable>
        )}
        <View style={s.field}>
          <TextInput key={fieldGeneration} ref={input} style={s.input} value={text} onChangeText={setText} onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)} placeholder={placeholder} placeholderTextColor={C.tertiary}
            multiline autoCorrect spellCheck />
          {can && (
            <Pressable onPress={send} style={s.send} accessibilityLabel="Send" hitSlop={6}>
              <Symbol name="arrow.up" size={15} color="white" />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { backgroundColor: C.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.separator },
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  mentions: { maxHeight: 176 },
  mention: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, height: 44 },
  mentionName: { fontSize: 16, color: C.label, flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.fill, borderRadius: 10, padding: 6 },
  thumb: { width: 32, height: 32, borderRadius: 6 },
  chipName: { fontSize: 12, color: C.label },
  chipSize: { fontSize: 11, color: C.secondary },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  plus: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.fill, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 0.75, borderColor: C.opaqueSeparator, borderRadius: 18,
    backgroundColor: C.background, paddingLeft: 12, paddingRight: 3, minHeight: 34 },
  input: { flex: 1, fontSize: 17, color: C.label, paddingTop: 7, paddingBottom: 7, maxHeight: 140 },
  send: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
})
