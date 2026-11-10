// iOS system colors (light/dark), as the Lab's named colors map to SwiftUI's.
import { PlatformColor, useColorScheme, type ColorValue } from 'react-native'
import { accent } from './theme.ts'

const P = (n: string) => PlatformColor(n) as unknown as ColorValue
export const C = {
  label: P('label'), secondary: P('secondaryLabel'), tertiary: P('tertiaryLabel'),
  background: P('systemBackground'), groupedBackground: P('systemGroupedBackground'), secondaryBackground: P('secondarySystemBackground'),
  fill: P('secondarySystemFill'), tertiaryFill: P('tertiarySystemFill'), separator: P('separator'), opaqueSeparator: P('opaqueSeparator'),
  bar: P('secondarySystemBackground'),
  /** A pressed row: opaque (a see-through fill showed the swipe buttons under the row). */
  pressed: P('systemGray5'),
  blue: P('systemBlue'), green: P('systemGreen'), mint: P('systemMint'), orange: P('systemOrange'), red: P('systemRed'),
  yellow: P('systemYellow'), teal: P('systemTeal'), indigo: P('systemIndigo'), gray: P('systemGray'), link: P('link'),
  accent,
}
export type ColorName = keyof typeof C
export const color = (n: string | undefined): ColorValue | undefined => (n ? (C as Record<string, ColorValue>)[n] ?? n : undefined)
export const useDark = () => useColorScheme() === 'dark'
