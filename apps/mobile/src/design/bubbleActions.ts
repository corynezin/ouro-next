// A bubble's long-press sheet, apart from the sheet that shows it. Pure.

export interface BubbleAction { title: string; destructive?: boolean; onPress: () => void }

export interface TextHandlers { copyText: (text: string) => void; selectText: (text: string) => void }

/** Copy and Select text for words on screen: a bubble's text, or a done report's summary (CHAT-43). */
export function textActions(text: string, handlers: TextHandlers): BubbleAction[] {
  return [{ title: 'Copy', onPress: () => handlers.copyText(text) }, { title: 'Select text', onPress: () => handlers.selectText(text) }]
}

/** The bubble's own actions (a failed send's, say) first, then the text ones when it has text (CHAT-21). */
export function bubbleActions(own: readonly BubbleAction[], text: string, handlers: TextHandlers): BubbleAction[] {
  return [...own, ...(text ? textActions(text, handlers) : [])]
}

/**
 * Which presses the words in a bubble take themselves. Words with a tap of their own take the touch from the bubble's
 * Pressable, so they must take its long-press too, or a long-press on them reads as a tap (a failed send's sheet without
 * Copy and Select text). Words without a tap leave both to the Pressable when it handles them (`insidePressable`).
 */
export function wordsPresses(insidePressable: boolean, onPress: (() => void) | undefined, onLongPress: (() => void) | undefined) {
  return { onPress, onLongPress: insidePressable && !onPress ? undefined : onLongPress }
}
