// An SF Symbol (expo-image's sf: source), tinted. Colors as hex: the symbol tint doesn't take PlatformColor.
import { Image } from 'expo-image'
import { useColorScheme } from 'react-native'

const HEX: Record<string, [string, string]> = { // [light, dark]
  blue: ['#007AFF', '#0A84FF'], green: ['#34C759', '#30D158'], mint: ['#00C7BE', '#63E6E2'], orange: ['#FF9500', '#FF9F0A'],
  red: ['#FF3B30', '#FF453A'], yellow: ['#FFCC00', '#FFD60A'], teal: ['#30B0C7', '#40C8E0'], indigo: ['#5856D6', '#5E5CE6'],
  secondary: ['#8A8A8E', '#98989F'], label: ['#000000', '#FFFFFF'], white: ['#FFFFFF', '#FFFFFF'], gray: ['#8E8E93', '#8E8E93'],
}
export function useHex() {
  const dark = useColorScheme() === 'dark' ? 1 : 0
  return (c: string) => HEX[c]?.[dark] ?? c
}

export function Symbol({ name, size = 17, color = 'label' }: { name: string; size?: number; color?: string }) {
  const hex = useHex()
  return <Image source={`sf:${name}`} style={{ width: size, height: size }} tintColor={hex(color)} contentFit="contain" />
}
