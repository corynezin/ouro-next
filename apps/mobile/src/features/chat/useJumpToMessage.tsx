// Opening a chat at a message from search: pages back until it is loaded, scrolls to it, and marks it for a moment.
// Steps come from jumpStep in model.ts; this only runs them against the list.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { View } from 'react-native'
import type { FlatList } from 'react-native'
import type { ApiResult } from '../../core/session/serverApi.ts'
import { failureText } from '../../core/session/serverApi.ts'
import { C } from '../../design/colors.ts'
import { JUMP_COPY, jumpStep } from './model.ts'
import type { ChatItem, MessageAt } from './model.ts'

const MARK_MS = 3000
/** Scrolling far past what is drawn fails; each retry lands nearer, by the average height. */
const MAX_SCROLL_TRIES = 12

export function useJumpToMessage(input: {
  target: MessageAt | undefined
  items: readonly ChatItem[]
  /** The chat's newest page is in. */
  loaded: boolean
  hasOlder: boolean
  loadOlder: () => Promise<ApiResult<void>>
  list: RefObject<FlatList<ChatItem> | null>
  onNote: (text: string) => void
}) {
  const { target, items, loaded, hasOlder, loadOlder, list, onNote } = input
  const [markedMessageId, setMarkedMessageId] = useState<string | null>(null)
  const [pagesLoaded, setPagesLoaded] = useState(0)
  const handledMessageId = useRef<string | null>(null)
  const loadingOlder = useRef(false)
  const scrollIndex = useRef(0)
  const scrollTries = useRef(0)

  const scroll = useCallback(() => list.current?.scrollToIndex({ index: scrollIndex.current, animated: false, viewPosition: 0.5 }), [list])

  useEffect(() => {
    if (!target || !loaded || loadingOlder.current || handledMessageId.current === target.messageId) return
    const step = jumpStep(items, target, hasOlder, pagesLoaded)
    if (step.kind === 'load_older') {
      loadingOlder.current = true
      void loadOlder().then((loadedOlder) => {
        loadingOlder.current = false
        if (loadedOlder.ok) { setPagesLoaded((pages) => pages + 1); return }
        handledMessageId.current = target.messageId
        onNote(failureText(loadedOlder.failure))
      })
      return
    }
    handledMessageId.current = target.messageId
    if (step.kind === 'too_far') onNote(JUMP_COPY.tooFar)
    else if (step.kind === 'not_here') onNote(JUMP_COPY.notHere)
    else {
      scrollIndex.current = step.index
      scrollTries.current = 0
      setMarkedMessageId(step.messageId)
      setTimeout(scroll, 50) // once the list has drawn the loaded items
    }
  }, [target?.messageId, items, loaded, hasOlder, pagesLoaded])

  useEffect(() => {
    if (markedMessageId === null) return
    const timer = setTimeout(() => setMarkedMessageId(null), MARK_MS)
    return () => clearTimeout(timer)
  }, [markedMessageId])

  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    if (scrollTries.current++ >= MAX_SCROLL_TRIES) return
    list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
    setTimeout(scroll, 50)
  }, [list, scroll])

  return { markedMessageId, onScrollToIndexFailed }
}

/** A message jumped to, marked behind for a moment. */
export function Marked({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return children
  return <View style={{ backgroundColor: C.fill, borderRadius: 10, marginHorizontal: -8, paddingHorizontal: 8, paddingVertical: 4 }}>{children}</View>
}
