// An open ask's choices as tappable buttons. The caller decides what a tap sends and guards against double taps.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { tapChoice } from './choiceTap.ts'
import type { ChooseChoice } from './choiceTap.ts'
import { C } from './colors.ts'

export function AskChoices({ choices, onChoose, compact }: { choices: readonly string[]; onChoose: ChooseChoice; compact?: boolean }) {
  return (
    <View style={s.row}>
      {choices.map((c) => (
        <Pressable key={c} onPress={() => tapChoice(c, onChoose, () => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) })} accessibilityRole="button" accessibilityLabel={`Answer ${c}`}
          style={({ pressed }) => [s.button, compact && s.compact, pressed && { opacity: 0.6 }]}>
          <Text style={[s.text, compact && s.compactText]} numberOfLines={2}>{c}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.tertiaryFill, maxWidth: '100%' },
  compact: { paddingHorizontal: 9, paddingVertical: 3 },
  text: { fontSize: 14, fontWeight: '600', color: C.blue },
  compactText: { fontSize: 12 },
})
