// Contract-valid entities for tests, with only what a test cares about given.
import { DEFAULT_NOTIFICATION_SETTINGS } from '@ouro/contract'
import type { AgentEntity, ChatEntity, MessageEntity, ReadStateEntity, Snapshot } from '@ouro/contract'

export const VIEWER_ADDRESS = 'human'

export function snapshotOf(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    epoch: 'epoch-1',
    cursor: 0,
    viewer: { address: VIEWER_ADDRESS, personId: 'p1', personName: 'owner', isOwner: true, deviceId: 'd1', deviceName: 'phone' },
    server: {
      id: 'server',
      machineName: 'alpha',
      release: { id: 'r1', base: { kind: 'not_taking' } },
      sourceBackup: { state: 'not_applicable' },
      defaultModel: 'sonnet',
      models: [],
      limits: { agentLimit: 8, idleFoldMinutes: 30, budgetUsd: null, autoArchiveAfterHours: null, replyReminders: true },
      planUsage: { claude: null, chatgpt: null },
    },
    agents: [],
    chats: [],
    readStates: [],
    asks: [],
    goals: [],
    summaries: [],
    people: [],
    devices: [],
    notificationSettings: { id: 'p1', ...DEFAULT_NOTIFICATION_SETTINGS },
    integrations: [],
    computers: [],
    remoteAgents: [],
    remoteAsks: [],
    ...partial,
  }
}

export function agentOf(partial: Partial<AgentEntity> & { id: string; name: string }): AgentEntity {
  return {
    task: 'a task',
    folder: '/work',
    model: 'sonnet',
    parent: VIEWER_ADDRESS,
    createdBy: VIEWER_ADDRESS,
    createdAt: 1,
    state: { state: 'idle', since: 1, generation: 1 },
    stateNote: null,
    queuedDeliveries: 0,
    lastOutputAt: null,
    lastActivityAt: 1,
    interruptedBy: null,
    runningRelease: null,
    runningOldRelease: false,
    costUsd: 0,
    planShare: null,
    cache: null,
    lastTurnFailure: null,
    branch: null,
    ...partial,
  }
}

export function directChatOf(id: string, agentAddress: string): ChatEntity {
  return {
    id,
    kind: 'direct',
    title: null,
    members: [{ address: VIEWER_ADDRESS, joinedAt: 1 }, { address: agentAddress, joinedAt: 1 }],
    createdBy: VIEWER_ADDRESS,
    createdAt: 1,
    homeMachine: 'alpha',
    latestMessage: null,
  }
}

export function messageOf(partial: Partial<MessageEntity> & { seq: number; chatId: string }): MessageEntity {
  return {
    id: `m${partial.seq}`,
    from: 'alice',
    at: partial.seq * 1000,
    text: `message ${partial.seq}`,
    attachments: [],
    purpose: 'message',
    answersAskId: null,
    relayedBy: null,
    clientKey: null,
    posesAskId: null,
    deliveries: [],
    remoteDeliveries: [],
    ...partial,
  }
}

export function readStateOf(chatId: string, readThroughSeq: number, unreadCount = 0): ReadStateEntity {
  return { id: `read-${chatId}`, chatId, readThroughSeq, unreadCount }
}

export const changeFrame = (change: object) => ({ frame: 'change', change })
export const caughtUpFrame = (cursor: number) => ({ frame: 'caught_up', cursor })
export const agentUpsert = (cursor: number, agent: AgentEntity) => changeFrame({ cursor, entity: 'agent', id: agent.id, op: 'upsert', value: agent })
export const messageUpsert = (cursor: number, message: MessageEntity) => changeFrame({ cursor, entity: 'message', id: message.id, op: 'upsert', value: message })
export const readStateUpsert = (cursor: number, readState: ReadStateEntity) => changeFrame({ cursor, entity: 'read_state', id: readState.id, op: 'upsert', value: readState })
