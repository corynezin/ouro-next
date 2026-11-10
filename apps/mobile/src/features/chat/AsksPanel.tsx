// The open asks above a chat's composer: tap one to answer just it, or tap a choice. Renders chat/model.ts's asksPanel.
// Shared by a local agent's chat and a remote agent's.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AskChoices } from '../../design/AskChoices.tsx'
import { C } from '../../design/colors.ts'
import { Symbol } from '../../design/Symbol.tsx'
import type { PanelAskModel } from './model.ts'

export function AsksPanel({ rows, hint, setAnsweringAskId, onChoose, onOptions }: {
  rows: readonly PanelAskModel[]
  hint: string | null
  setAnsweringAskId: (askId: string | null) => void
  onChoose: (askId: string, choice: string) => boolean | void
  /** The options button, given the ask and its answer-just-this toggle. Absent: no button. */
  onOptions?: (ask: PanelAskModel, toggle: () => void) => void
}) {
  if (!rows.length) return null
  return (
    <View style={s.panel}>
      {rows.map((ask) => {
        const toggle = () => setAnsweringAskId(ask.answering ? null : ask.askId)
        return (
          <View key={ask.askId} style={s.row}>
            <Symbol name={ask.symbol.name} color={ask.symbol.color} size={12} />
            <View style={{ flex: 1, gap: 4 }}>
              <Pressable onPress={toggle}>
                <Text style={[s.text, { color: ask.answering ? C.blue : C.label }]} numberOfLines={2}>{ask.text}</Text>
              </Pressable>
              {ask.choices.length > 0 && <AskChoices choices={ask.choices} compact onChoose={(choice) => onChoose(ask.askId, choice)} />}
            </View>
            {onOptions && (
              <Pressable hitSlop={8} accessibilityLabel="Ask options" onPress={() => onOptions(ask, toggle)}>
                <Symbol name={ask.snoozed ? 'moon.zzz.fill' : 'ellipsis.circle'} size={15} color="blue" />
              </Pressable>
            )}
          </View>
        )
      })}
      {hint !== null && <Text style={{ fontSize: 11, color: C.secondary }}>{hint}</Text>}
    </View>
  )
}

const s = StyleSheet.create({
  panel: { backgroundColor: C.bar, paddingHorizontal: 18, gap: 4, paddingVertical: 5 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  text: { fontSize: 12, color: C.label },
})
