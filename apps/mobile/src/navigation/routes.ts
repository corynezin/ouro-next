// Every screen and its params. Modal ones are presented as sheets. Screens are added here with their milestone.
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { MessageAt } from '../features/chat/model.ts'

export type Routes = {
  Agents: undefined
  /** `agentRef` is an id or a name: a link or a notification may have either. `at`: open at that message, from search;
   * else at the newest. */
  Chat: { agentRef: string; at?: MessageAt }
  Log: { agentRef: string }
  /** Every model request the agent made, and for one of them everything it was sent, with token counts. */
  Context: { agentRef: string }
  ContextRequest: { agentRef: string; n: number }
  Summaries: { agentRef: string }
  /** Every agent's latest summary. Reached only by a link, as in the reference. */
  AllSummaries: undefined
  Agent: { agentRef: string }
  Goal: { agentRef: string }
  Archived: undefined
  Chats: undefined
  ChatRoom: { chatId: string; at?: MessageAt }
  ChatInfo: { chatId: string }
  /** A chat member with no agent page here: a person, or an agent on another machine. */
  Person: { address: string }
  /** An agent on another of the person's computers: `<computer id>:<name>`. */
  RemoteChat: { remoteAgentId: string }
  NewGroup: undefined
  AddToChat: { chatId: string }
  New: undefined
  Servers: undefined
  Computers: undefined
  Settings: undefined
  /** Settings → Invite someone: a one-time code for a new person on this server. */
  Invite: undefined
  Claude: undefined
  ChatGPT: undefined
  OpenRouter: undefined
  /** `thenMakePrivateCopy`: the person came to connect GitHub to back up, so the private copy is made once it connects. */
  GitHub: { thenMakePrivateCopy?: boolean } | undefined
  AWS: undefined
  Pair: undefined
  SelectText: { text: string }
  /** A file sent in a chat, fetched with the session's authorisation. */
  File: { attachmentId: string; fileName: string; isImage: boolean }
}
export type ScreenProps<K extends keyof Routes> = NativeStackScreenProps<Routes, K>
