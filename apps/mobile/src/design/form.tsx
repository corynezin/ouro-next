// Helpers for the SwiftUI forms (New, Settings, Goal, Agent details): a controlled text field, label/value rows, header
// buttons. The Lab's kv / ui.textfield / ui.texteditor.
import { useCallback, useEffect, useRef } from 'react'
import type { Ref } from 'react'
import { Pressable, Text as RNText } from 'react-native'
import { Button, Host, LabeledContent, Text, TextField, useNativeState } from '@expo/ui/swift-ui'
import type { TextFieldRef } from '@expo/ui/swift-ui'
import {
  autocorrectionDisabled, labelStyle, font, foregroundStyle, lineLimit, onSubmit as onSubmitMod,
  textInputAutocapitalization, textSelection,
} from '@expo/ui/swift-ui/modifiers'
import { C } from './colors.ts'

/** A SwiftUI TextField kept in step with `value` (changes from code, like a tapped suggestion, are pushed in). */
export function Field({ value, onChange, placeholder, multiline, mono, minLines = 4, onSubmit, plain, ref }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean; minLines?: number
  onSubmit?: () => void; /** no autocapitalization / autocorrection (names, paths) */ plain?: boolean
  ref?: Ref<TextFieldRef>
}) {
  const text = useNativeState(value)
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) { last.current = value; text.value = value }
  }, [value])
  const mods = [
    ...(multiline ? [lineLimit({ min: minLines, max: 14 })] : []),
    ...(mono ? [font({ design: 'monospaced', textStyle: 'footnote' })] : []),
    ...(plain ? [textInputAutocapitalization('never'), autocorrectionDisabled(true)] : []),
    ...(onSubmit ? [onSubmitMod(onSubmit)] : []),
  ]
  return (
    <TextField ref={ref} text={text} placeholder={placeholder} axis={multiline ? 'vertical' : 'horizontal'} modifiers={mods}
      onTextChange={(t) => { last.current = t; onChange(t) }} />
  )
}

/** A row: label left, value right (selectable). Nothing when there is no value. */
export function KV({ k, v, mono }: { k: string; v: string | null | undefined; mono?: boolean }) {
  if (!v) return null
  return (
    <LabeledContent label={k}>
      <Text modifiers={[textSelection(true), lineLimit(2), ...(mono ? [font({ design: 'monospaced', textStyle: 'footnote' })] : [])]}>{v}</Text>
    </LabeledContent>
  )
}

/** Plain colored text in a form (notes, errors). */
export const Note = ({ text, color = 'orange' }: { text: string; color?: string }) =>
  <Text modifiers={[foregroundStyle(color), textSelection(true)]}>{text}</Text>

/** A text button for the navigation bar (Done, Cancel, Start…). */
export function HeaderButton({ title, onPress, bold, disabled }: { title: string; onPress: () => void; bold?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={10} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
      <RNText style={{ fontSize: 17, color: disabled ? C.tertiary : C.accent, fontWeight: bold ? '600' : '400' }}>{title}</RNText>
    </Pressable>
  )
}

/** An SF Symbol button for the navigation bar. */
export function HeaderIcon({ symbol, onPress }: { symbol: string; onPress: () => void }) {
  return (
    <Host matchContents>
      <Button systemImage={symbol as any} label="" onPress={onPress} modifiers={[labelStyle('iconOnly')]} />
    </Host>
  )
}

/**
 * Blurs a form's fields before it changes its rows or goes away. A SwiftUI form whose rows change while a field has
 * focus can hit a UIKit assertion and abort the app (seen about 1 in 3 on New agent's Start). Pass `field` as each
 * Field's ref, and await `blurFields()` before such a change.
 */
export function useBlurFields() {
  const fields = useRef(new Set<TextFieldRef>())
  const field = useCallback((ref: TextFieldRef | null) => {
    if (!ref) return
    fields.current.add(ref)
    return () => { fields.current.delete(ref) }
  }, [])
  const blurFields = useCallback(() => Promise.all([...fields.current].map((ref) => ref.blur().catch(() => {}))), [])
  return { field, blurFields }
}
