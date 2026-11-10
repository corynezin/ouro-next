// Where a tapped notification lands: the Agents list with that conversation on top, unless it is already on screen.
import type { PushPlace } from '../core/push/pushCenter.ts'
import { agentByRef } from '../features/shared/agentFacts.ts'
import type { StoreView } from '../features/shared/agentFacts.ts'
import type { Routes } from './routes.ts'

export type PushPlaceRoute = { name: 'Chat'; params: Routes['Chat'] } | { name: 'ChatRoom'; params: Routes['ChatRoom'] }

export function routeOfPushPlace(place: PushPlace): PushPlaceRoute {
  return place.kind === 'agent_chat' ? { name: 'Chat', params: { agentRef: place.agentId } } : { name: 'ChatRoom', params: { chatId: place.chatId } }
}

/** A Chat route may name its agent by name or id. */
export function isShowingPushPlace(current: { name: string; params?: object } | undefined, place: PushPlace, store: StoreView): boolean {
  if (!current?.params) return false
  if (place.kind === 'room') return current.name === 'ChatRoom' && 'chatId' in current.params && current.params.chatId === place.chatId
  if (current.name !== 'Chat' || !('agentRef' in current.params) || typeof current.params.agentRef !== 'string') return false
  return agentByRef(store, current.params.agentRef)?.id === place.agentId
}
