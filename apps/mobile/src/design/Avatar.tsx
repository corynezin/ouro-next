// Offline avatars: agents get GitHub-style identicons on a neutral circle; people get Personas faces.
import { memo, useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import * as personas from '@dicebear/personas'
import { Image } from 'expo-image'
import { View } from 'react-native'
import { useDark } from './colors.ts'
import { identiconSvg } from './identicon.ts'
import { avatarModel } from './avatarModel.ts'

/** GitHub's light gray identicon backdrop and hairline, with dark-mode counterparts. Background is hex without `#`. */
const IDENTICON_LIGHT = { background: 'f0f0f0', border: '#dcdcdc' } as const
const IDENTICON_DARK = { background: '2c2c2e', border: '#48484a' } as const

/** `seed` picks the face and stays stable when an agent switches models; `model` is only announced in the label. */
export const Avatar = memo(function Avatar({ seed, kind, model, size = 32 }: {
  seed: string; kind: 'agent' | 'human'; model?: string; size?: number
}) {
  const dark = useDark()
  const human = kind === 'human'
  const palette = dark ? IDENTICON_DARK : IDENTICON_LIGHT
  const { company, capability } = avatarModel(human ? undefined : model)
  const uri = useMemo(() => {
    const svg = human
      ? createAvatar(personas, { seed, backgroundColor: ['d9dbe1', 'c4c8d1', 'e4e6eb'], backgroundType: ['gradientLinear'] }).toString()
      : identiconSvg(seed, palette.background)
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  }, [seed, human, palette.background])
  const stroke = human ? 0 : 1
  const diameter = size - stroke * 2
  const label = human ? `${seed}, person` : `${seed}${company ? `, ${company}` : ''}${model ? `, ${model}` : ''}${capability ? `, ${capability}` : ''}`
  return <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: palette.border, overflow: 'hidden' }}>
    <Image source={{ uri }} style={{ width: diameter, height: diameter, borderRadius: diameter / 2 }} contentFit="cover" accessibilityLabel={label} />
  </View>
})
