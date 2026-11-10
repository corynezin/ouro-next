// The snooze sheet an ask offers on the agents list and in chat. Choices come from agentFacts' snoozeChoices.
import type { AskSnooze } from '@ouro/contract'
import type { ServerSession } from '../../core/session/serverSession.ts'
import { oneLine } from '../../design/format.ts'
import { actionSheet } from '../../design/menus.tsx'
import { snoozeChoices } from './agentFacts.ts'

/** Snoozes or wakes an ask; the stream brings back the changed ask. Says why when refused. */
export async function snoozeAsk(session: ServerSession, askId: string, snooze: AskSnooze | null, onError: (reason: string) => void) {
  const failure = await session.commandError('snooze_ask', { askId, snooze })
  if (failure !== null) onError(failure)
}

export function openSnoozeSheet(session: ServerSession, ask: { askId: string; text: string; snoozed: boolean }, onError: (reason: string) => void,
  firstOptions: { title: string; onPress: () => void }[] = []) {
  actionSheet(oneLine(ask.text).slice(0, 120), [
    ...firstOptions,
    ...snoozeChoices(ask.snoozed, Date.now()).map((choice) => ({ title: choice.title, onPress: () => { void snoozeAsk(session, ask.askId, choice.snooze, onError) } })),
  ])
}
