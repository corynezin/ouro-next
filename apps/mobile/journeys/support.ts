// What the app journeys share: a phone (AppCore) on Node's fetch and real timers, paired with a JourneyRun's server.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AppCore } from '../src/core/appCore.ts'
import { FakeLifecycle, MemoryDurableStore, MemorySecureStorage } from '../src/core/platform/fakes.ts'
import type { Clock, HttpStream, Network } from '../src/core/platform/ports.ts'
import type { ServerSession } from '../src/core/session/serverSession.ts'
import { chatItems, recipientLastOutputOf } from '../src/features/chat/model.ts'
import { directChatOf } from '../src/features/shared/agentFacts.ts'
import { waitFor } from '../../../journeys/harness.ts'
import type { JourneyRun } from '../../../journeys/harness.ts'

export const runs: JourneyRun[] = []
// A session left running retries its server every 2 seconds and keeps this process alive forever, so every phone is
// disposed here too, including one whose test failed before its own cleanup ran.
export const phones: AppCore[] = []
/** Each journey file calls this once: `after(cleanUp)`. */
export async function cleanUp() {
  for (const phone of phones) phone.activeSession?.dispose()
  await Promise.all(runs.map((run) => run.cleanup()))
}

async function* decodedChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  for await (const bytes of body) yield decoder.decode(bytes, { stream: true })
}

const noChunks: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {} }

export const nodeNetwork: Network = {
  async request(request) {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, signal: request.signal })
    return { status: response.status, text: await response.text() }
  },
  async openStream(request): Promise<HttpStream> {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, signal: request.signal })
    return { status: response.status, chunks: response.body ? decodedChunks(response.body) : noChunks }
  },
  async uploadFile(request) {
    const bytes = await readFile(new URL(request.fileUri))
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: bytes, signal: request.signal })
    return { status: response.status, text: await response.text() }
  },
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs, fire) {
    const timer = setTimeout(fire, delayMs)
    return () => clearTimeout(timer)
  },
}

/** What the phone asked the server for, so a test can see a refresh happen. */
export const requestedUrls: string[] = []
export const watchedNetwork: Network = {
  request(request) { requestedUrls.push(request.url); return nodeNetwork.request(request) },
  openStream(request) { requestedUrls.push(request.url); return nodeNetwork.openStream(request) },
  uploadFile(request) { return nodeNetwork.uploadFile(request) },
}

export function newPhone() {
  const phone = new AppCore({
    network: watchedNetwork,
    clock: realClock,
    lifecycle: new FakeLifecycle(),
    ids: { newId: () => randomUUID() },
    secureStorage: new MemorySecureStorage(),
    durableStore: new MemoryDurableStore(),
  })
  phones.push(phone)
  return phone
}

export async function pairedPhone(run: JourneyRun) {
  const output = await run.cli('pair')
  const code = /code: (\S+)/.exec(output)![1]!
  const phone = newPhone()
  await phone.start()
  await phone.pairAndActivate(run.url, code)
  const session = phone.activeSession!
  await waitFor('the stream to go live', () => session.connection.phase === 'live')
  return { phone, session }
}

export function conversationTexts(session: ServerSession, agentId: string) {
  const agent = session.store.agents.get(agentId)!
  const chat = directChatOf(session.store, agent)
  const messages = chat ? session.store.timeline(chat.id)?.messages ?? [] : []
  return chatItems({ messages, outbox: session.outbox.entriesIn(agentId), viewerAddress: session.store.viewer?.address, recipientLastOutputAt: recipientLastOutputOf(agent) })
    .map((item) => (item.kind === 'message' ? `${item.mine ? 'me' : 'it'}: ${item.message.text}` : `sending: ${item.entry.text}`))
    .reverse()
}
