// A conversation's history on screen: its first page and older ones, with the footer that loads them. Shared by an agent's
// chat and a group room.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text } from 'react-native'
import type { ServerSession } from '../../core/session/serverSession.ts'
import { C } from '../../design/colors.ts'
import { historyFooter, historyLoadNote } from './model.ts'
import type { HistoryFooterModel } from './model.ts'

/** `chatId` null: the chat doesn't exist yet, so there is nothing to load. A failed load goes to `onNote` (CHAT-16). */
export function useHistory(session: ServerSession, chatId: string | null, onNote: (note: string | null) => void) {
  const [loading, setLoading] = useState(false)
  const timeline = chatId === null ? undefined : session.store.timeline(chatId)

  const loadOlder = async () => {
    if (loading || chatId === null) return
    setLoading(true)
    const loaded = await session.loadOlder(chatId)
    setLoading(false)
    onNote(historyLoadNote(loaded))
  }

  // Opening the chat starts its first page without saying how it went; this joins that same request, so a failure shows.
  useEffect(() => {
    if (chatId !== null && !session.store.timeline(chatId)) void loadOlder()
  }, [session, chatId])

  const footer = chatId === null ? null : historyFooter({ loaded: timeline !== undefined, hasOlder: timeline?.hasOlder === true, loading })
  return { timeline, footer, loadOlder, hasOlder: timeline?.hasOlder === true }
}

export function HistoryFooter({ footer, onLoad }: { footer: HistoryFooterModel | null; onLoad: () => void }) {
  if (footer === null) return null
  return (
    <Pressable onPress={onLoad} disabled={footer.kind === 'loading'} style={{ alignItems: 'center', paddingVertical: 8 }}>
      {footer.kind === 'loading' ? <ActivityIndicator /> : <Text style={{ color: C.blue, fontSize: 13 }}>{footer.label}</Text>}
    </Pressable>
  )
}
