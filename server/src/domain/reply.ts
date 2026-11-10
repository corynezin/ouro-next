// Reply reminders. An agent's final text reaches no one, so a message from a person or an agent is owed a reply sent
// through ouro: in the chat it came in, in that turn or a later one. A turn that ends with nothing more to do and a reply
// still owed gets one reminder, and after it nothing from before is owed any more.
import type { DeliveryWake, MessagePurpose } from '@ouro/contract'

/** A message an agent took in through a finished turn, with the facts that decide whether it owes a reply. */
export interface TakenMessage {
  from: string
  fromKind: 'person' | 'agent'
  purpose: MessagePurpose
  wake: DeliveryWake
  /** Where a reply goes: the sender's address for a direct chat, the group's handle for a group. */
  replyTo: string
  /** It answers a question this agent asked. */
  answersOwnAsk: boolean
  /** The message before it in its chat was this agent's, so an agent sending it is writing back. */
  followsOwnMessage: boolean
  /** This agent has written in that chat since. */
  answeredInChat: boolean
}

/**
 * Owes nothing: an FYI, the task (its result answers it), a done report, the system's own notices and goal cycles, an
 * answer to this agent's question, and an agent writing back to this agent. A person's message is owed even then: they
 * expect to hear back.
 */
export function owesReply(message: TakenMessage): boolean {
  if (message.wake !== 'wake' || message.purpose !== 'message' || message.answeredInChat || message.answersOwnAsk) return false
  return message.fromKind === 'person' || !message.followsOwnMessage
}

/** The one reminder, naming each place a reply is owed. Null when none is. */
export function replyReminder(taken: TakenMessage[]): string | null {
  const owed = [...new Set(taken.filter(owesReply).map((message) => message.replyTo))]
  if (owed.length === 0) return null
  const first = owed[0]!
  const command = first.startsWith('#') ? `ouro send '${first}' "…"` : `ouro send ${first} "…"`
  const whose = owed.length > 1 ? `${owed.join(' and ')}'s messages have` : `${first}'s message has`
  return `${whose} no reply yet; your terminal is not seen. Reply with \`${command}\` (short, outcome first). If you are still working on it or waiting, say so in one line. This is the only reminder.`
}
