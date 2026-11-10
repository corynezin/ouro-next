// Busy (green), running idle (mint), done (a check) or stopped (a ring).
import { Text, View } from 'react-native'
import { C } from '../../design/colors.ts'
import type { StateDotKind } from './agentFacts.ts'

export function StateDot({ kind, size = 9 }: { kind: StateDotKind; size?: number }) {
  if (kind === 'done') return <Text accessibilityLabel="done" style={{ color: C.secondary, fontSize: size + 2, fontWeight: '800', lineHeight: size + 4 }}>✓</Text>
  const shape = kind === 'stopped' ? { borderWidth: 1.2, borderColor: C.secondary } : { backgroundColor: kind === 'busy' ? C.green : C.mint }
  return <View accessibilityLabel={kind} style={{ width: size, height: size, borderRadius: size / 2, ...shape }} />
}
