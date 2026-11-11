// Native menus (SwiftUI Menu through @expo/ui), action sheets and confirmations.
import { Fragment } from 'react'
import { ActionSheetIOS, Alert } from 'react-native'
import { Button, Divider, HStack, Host, Image, Menu, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui'
import { foregroundStyle, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers'
import { accent } from './theme.ts'
import type { NativeStackHeaderItem, NativeStackHeaderItemMenuAction, NativeStackHeaderItemMenuSubmenu } from '@react-navigation/native-stack'

export type MenuItem =
  | { kind?: 'button'; title: string; symbol?: string; destructive?: boolean; disabled?: boolean; onPress: () => void }
  | { kind: 'divider' }
  | { kind: 'picker'; title: string; value: string; options: { value: string; label: string }[]; inline?: boolean; onChange: (v: string) => void }
  | false | null | undefined | 0 | ''

function items(list: MenuItem[]) {
  return list.filter(Boolean).map((it, i) => {
    const x = it as Exclude<MenuItem, false | null | undefined | 0 | ''>
    if (x.kind === 'divider') return <Divider key={i} />
    if (x.kind === 'picker') {
      const picker = (
        <Picker key={i} label={x.title} selection={x.value} onSelectionChange={(v) => x.onChange(String(v))}
          modifiers={[pickerStyle(x.inline ? 'inline' : 'menu')]}>
          {x.options.map((o) => <Text key={o.value} modifiers={[tag(o.value)]}>{o.label}</Text>)}
        </Picker>
      )
      return x.inline ? <Section key={i} title={x.title}>{picker}</Section> : picker
    }
    return <Button key={i} label={x.title} systemImage={x.symbol as any} role={x.destructive ? 'destructive' : undefined} onPress={x.onPress} />
  })
}

/** A toolbar button that opens a native menu: an SF Symbol or a text label. */
export function MenuButton({ symbol, label, items: list }: { symbol?: string; label?: string; items: MenuItem[] }) {
  return (
    <Host matchContents>
      <Menu label={label ?? ''} systemImage={symbol} modifiers={[tint(accent)]}>{items(list)}</Menu>
    </Host>
  )
}

export interface Choice { key: string; label: string }

/**
 * A form row that picks one choice from a menu, drawn as a menu-style Picker row is: label, then the chosen value and
 * up-down chevrons. Its items are checkable toggles rather than a Picker's options, because UIKit aborts when a
 * single-selection menu's items change while it is open, as they do when the goal or agent it edits goes away.
 */
export function ChoiceMenu({ label, groups, chosenKey, onChoose }: {
  label: string
  /** A group with a title is a titled section of the menu. */
  groups: readonly { title: string | null; choices: readonly Choice[] }[]
  chosenKey: string
  onChoose: (key: string) => void
}) {
  const chosen = groups.flatMap((group) => group.choices).find((choice) => choice.key === chosenKey)
  const toggles = (choices: readonly Choice[]) => choices.map((choice) => (
    // Turning the chosen one off is refused: the Toggle shows only `isOn`, so it stays checked.
    <Toggle key={choice.key} label={choice.label} isOn={choice.key === chosenKey} onIsOnChange={(on) => { if (on) onChoose(choice.key) }} />
  ))
  return (
    <Menu label={(
      <HStack>
        <Text modifiers={[foregroundStyle('primary')]}>{label}</Text>
        <Spacer />
        <Text modifiers={[foregroundStyle('secondary')]}>{chosen?.label ?? ''}</Text>
        <Image systemName="chevron.up.chevron.down" size={12} modifiers={[foregroundStyle('secondary')]} />
      </HStack>
    )}>
      {groups.map((group, index) => (group.title === null
        ? <Fragment key={index}>{toggles(group.choices)}</Fragment>
        : <Section key={index} title={group.title}>{toggles(group.choices)}</Section>))}
    </Menu>
  )
}

/** An action sheet (long-press menus on bubbles and rows). */
export function actionSheet(title: string | undefined, options: { title: string; destructive?: boolean; onPress: () => void }[]) {
  const labels = [...options.map((o) => o.title), 'Cancel']
  const destructiveButtonIndex = options.map((o, i) => (o.destructive ? i : -1)).filter((i) => i >= 0)
  ActionSheetIOS.showActionSheetWithOptions({ title, options: labels, cancelButtonIndex: labels.length - 1, destructiveButtonIndex },
    (i) => { options[i]?.onPress() })
}

/** A native text prompt: the field sits in the alert, so the keyboard never covers it. Called with what was typed. */
export function prompt(title: string, message: string | undefined, action: string, onSubmit: (text: string) => void, defaultValue = '') {
  Alert.prompt(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, onPress: (text?: string) => onSubmit(text ?? '') }], 'plain-text', defaultValue)
}

/** A failure the person should see wherever they've scrolled to. */
export function alertFailure(message: string) {
  Alert.alert("Couldn't do that", message)
}

/** "Archive x?" with a destructive button; `destructive: false` for an action that loses nothing, which then isn't red. */
export function confirm(title: string, message: string, action: string, onConfirm: () => void, { destructive = true }: { destructive?: boolean } = {}) {
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: destructive ? 'destructive' : 'default', onPress: onConfirm }])
}

// ---- native bar-button menus (UIMenu on a UIBarButtonItem), for unstable_headerLeftItems / unstable_headerRightItems ----

type MenuEl = NativeStackHeaderItemMenuAction | NativeStackHeaderItemMenuSubmenu
const sf = (name?: string) => (name ? { type: 'sfSymbol' as const, name: name as any } : undefined)

/** Menu items as UIMenu elements: dividers split them into inline groups; a picker is a submenu of checked actions. */
export function menuElements(list: MenuItem[]): MenuEl[] {
  const groups: MenuEl[][] = [[]]
  for (const it of list) {
    if (!it) continue
    if (it.kind === 'divider') { groups.push([]); continue }
    const g = groups[groups.length - 1]!
    if (it.kind === 'picker') {
      g.push({ type: 'submenu', label: it.title, inline: !!it.inline, icon: undefined,
        items: it.options.map((o) => ({ type: 'action' as const, label: o.label, state: o.value === it.value ? 'on' as const : 'off' as const, onPress: () => it.onChange(o.value) })) })
      continue
    }
    g.push({ type: 'action', label: it.title, icon: sf(it.symbol), destructive: it.destructive, disabled: it.disabled, onPress: it.onPress })
  }
  const nonEmpty = groups.filter((g) => g.length)
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? []
  // no label: an inline group's label shows as a section title in the menu ("group1" did)
  return nonEmpty.map((g) => ({ type: 'submenu' as const, label: '', inline: true, items: g }))
}

export function barMenu(symbol: string, label: string, list: MenuItem[]): NativeStackHeaderItem {
  // The label alone isn't exposed for an icon item: without accessibilityLabel, VoiceOver and Maestro can't find it.
  return { type: 'menu', label, accessibilityLabel: label, icon: sf(symbol), tintColor: accent, menu: { items: menuElements(list) } } as NativeStackHeaderItem
}
export function barButton(symbol: string, label: string, onPress: () => void, o: { disabled?: boolean; badge?: number } = {}): NativeStackHeaderItem {
  return { type: 'button', label, accessibilityLabel: label, icon: sf(symbol), tintColor: accent, onPress, disabled: o.disabled, ...(o.badge ? { badge: { value: o.badge } } : {}) } as NativeStackHeaderItem
}
