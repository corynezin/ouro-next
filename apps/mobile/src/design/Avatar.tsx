// Offline Notionists avatars: company rings and shared capability backgrounds. The toggle in Settings turns agents back
// to the people's style.
import { createContext, memo, useContext, useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import * as personas from '@dicebear/personas'
import * as notionists from '@dicebear/notionists'
import { Image } from 'expo-image'
import { View } from 'react-native'
import { avatarModel, CAPABILITY_COLORS, COMPANY_RING_COLORS } from './avatarModel.ts'

/** Provided at the root from the "Model avatars" preference. */
export const ModelAvatarsEnabled = createContext(true)

/** `seed` stays stable when an agent switches models; `model` only changes its ring and background. */
export const Avatar = memo(function Avatar({ seed, kind, model, size = 32 }: {
  seed: string; kind: 'agent' | 'human'; model?: string; size?: number
}) {
  const enabled = useContext(ModelAvatarsEnabled)
  const human = kind === 'human'
  const { company, capability } = avatarModel(human ? undefined : model)
  const uri = useMemo(() => {
    if (!enabled || human) {
      const svg = createAvatar(personas, { seed, backgroundColor: ['d9dbe1', 'c4c8d1', 'e4e6eb'], backgroundType: ['gradientLinear'] }).toString()
      return `data:image/svg+xml,${encodeURIComponent(svg)}`
    }
    const svg = createAvatar(notionists, {
      seed, backgroundColor: [capability ? CAPABILITY_COLORS[capability] : 'c4c8d1'],
      gestureProbability: 0, bodyIconProbability: 0,
    }).toString()
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  }, [seed, enabled, human, capability])
  const stroke = enabled && !human ? Math.max(3, size * 0.075) : 0
  const diameter = size - stroke * 2
  const label = human ? `${seed}, person` : `${seed}${company ? `, ${company}` : ''}${model ? `, ${model}` : ''}${capability ? `, ${capability}` : ''}`
  return <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: stroke,
    borderColor: company ? COMPANY_RING_COLORS[company] : '#9299a5', overflow: 'hidden' }}>
    <Image source={{ uri }} style={{ width: diameter, height: diameter, borderRadius: diameter / 2 }} contentFit="cover" accessibilityLabel={label} />
  </View>
})
