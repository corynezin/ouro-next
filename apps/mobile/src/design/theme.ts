// Look and the over-the-air marker. Pure values, so this file also runs under node.
export const accent = '#007AFF'
export const otaLabel = 'Ouro Next · JS over the air'

/** Your message bubbles. */
export const myBubble = '#007AFF' // iMessage blue

/** The palette other people's bubbles cycle through: one stable colour per sender. */
export const senderColors = ['#0A84FF', '#FF9500', '#34C759', '#AF52DE', '#FF2D55', '#00A3A1', '#5E5CE6']

/** A stable colour for a sender's name, so different people in a thread are told apart at a glance. */
export const senderColor = (name: string): string => {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0
  return senderColors[h % senderColors.length]!
}

/** A translucent wash of a hex colour, for bubble backgrounds. */
export const tint = (hex: string, alpha: number): string => {
  const v = parseInt(hex.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}
