// Fills a data directory with history through the store, for proving that restart time doesn't depend on it.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../server/src/store/store.ts'

export function seedHistory(dataDir: string, messageCount: number, now: number): void {
  mkdirSync(dataDir, { recursive: true })
  const store = new Store(join(dataDir, 'ouro.db'))
  const chatId = `seeded-${randomUUID()}`
  store.transaction(() => {
    store.insertChat({ id: chatId, kind: 'group', title: 'seeded', createdBy: 'human', createdAt: now, homeMachine: 'journey', members: [{ address: 'human', joinedAt: now }] })
    for (let index = 0; index < messageCount; index++) {
      store.insertMessage({ id: randomUUID(), chatId, from: 'human', at: now + index, text: `seeded message ${index}`, attachments: [], purpose: 'message', clientKey: null, posesAskId: null, answersAskId: null, relayedBy: null })
    }
  })
  store.close()
}
