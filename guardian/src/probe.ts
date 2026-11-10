// Judging a running server from outside, with nothing but HTTP through the same address phones use. A release can't weaken
// this: the probe and the expectations it compares against live here.
import { request } from 'node:http'
import { manifestProblem } from './manifest-check.ts'

export interface ProbeTarget {
  socketPath: string
  credential: string
  timeoutMs: number
}

export interface HistoryAnchor {
  chatId: string
  /** Null is the newest page. */
  before: number | null
  messageIds: string[]
}

/** What must still be true after a switch: people's conversations and agents don't vanish. */
export interface HealthBaseline {
  /** The newest phone update before the switch. A release must still serve it. */
  latestUpdateNumber: number | null
  machineId: string
  agentIds: string[]
  anchors: HistoryAnchor[]
}

/** The chats most recently written in: what people are using now. */
const RECENT_CHATS_SAMPLED = 4
/** The chats longest without a message: old history that nobody is looking at is what a regression hides unnoticed. */
const QUIET_CHATS_SAMPLED = 2
const BASELINE_PAGES_BACK = 6
const PAGE_LIMIT = 50

export class ProbeFailure extends Error {}

export function httpGetJson(target: ProbeTarget, path: string, options: { authenticated: boolean }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      socketPath: target.socketPath,
      path,
      method: 'GET',
      timeout: target.timeoutMs,
      headers: options.authenticated ? { authorization: `Bearer ${target.credential}` } : {},
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) return reject(new ProbeFailure(`GET ${path} answered ${response.statusCode}: ${text.slice(0, 200)}`))
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new ProbeFailure(`GET ${path} answered something unreadable`))
        }
      })
    })
    outgoing.on('timeout', () => outgoing.destroy(new ProbeFailure(`GET ${path} didn't answer within ${target.timeoutMs} ms`)))
    outgoing.on('error', (error) => reject(error instanceof ProbeFailure ? error : new ProbeFailure(`GET ${path} failed: ${error.message}`)))
    outgoing.end()
  })
}

interface SnapshotShape {
  agents: { id: string; state: { state: string } }[]
  chats: { id: string; latestMessage: { seq: number } | null }[]
}

interface HistoryShape {
  messages: { id: string; seq: number }[]
  hasOlder: boolean
}

interface IdentityShape {
  machineId: string
  releaseId: string
  latestUpdate: { updateNumber: number; runtimeVersion: string } | null
}

/** The manifest route as a phone meets it: plain HTTP, the headers expo-updates sends, no credential. */
export function fetchManifest(target: ProbeTarget, runtimeVersion: string): Promise<{ status: number; protocolVersion: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      socketPath: target.socketPath,
      path: '/updates/manifest',
      method: 'GET',
      timeout: target.timeoutMs,
      headers: { 'expo-platform': 'ios', 'expo-runtime-version': runtimeVersion, 'expo-protocol-version': '1', accept: 'multipart/mixed,application/expo+json,application/json', host: 'probe.invalid' },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, protocolVersion: (response.headers['expo-protocol-version'] as string | undefined) ?? null, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('timeout', () => outgoing.destroy(new ProbeFailure(`the update manifest didn't answer within ${target.timeoutMs} ms`)))
    outgoing.on('error', (error) => reject(error instanceof ProbeFailure ? error : new ProbeFailure(`the update manifest failed: ${error.message}`)))
    outgoing.end()
  })
}

/**
 * The phone-update route must never serve something that crashes expo-updates. With an update published, its manifest
 * must pass the guardian's own check; with none, the answer must be the protocol's "no update".
 */
export async function probeUpdateManifest(target: ProbeTarget, latestUpdate: IdentityShape['latestUpdate'], minimumUpdateNumber: number | null): Promise<void> {
  if (minimumUpdateNumber !== null && (latestUpdate === null || latestUpdate.updateNumber < minimumUpdateNumber)) {
    throw new ProbeFailure(`phone update ${minimumUpdateNumber} was published, and the server now reports ${latestUpdate?.updateNumber ?? 'none'}`)
  }
  if (latestUpdate === null) {
    const answer = await fetchManifest(target, 'ouro-probe-no-such-runtime')
    if (answer.status !== 204 || answer.protocolVersion !== '1') throw new ProbeFailure(`with no update, the manifest route answered ${answer.status} (protocol ${answer.protocolVersion}), not 204 with protocol 1`)
    return
  }
  const answer = await fetchManifest(target, latestUpdate.runtimeVersion)
  if (answer.status !== 200) throw new ProbeFailure(`the manifest for update ${latestUpdate.updateNumber} answered ${answer.status}`)
  let manifest: unknown
  try {
    manifest = JSON.parse(answer.body)
  } catch {
    throw new ProbeFailure('the update manifest is not JSON')
  }
  const problem = manifestProblem(manifest)
  if (problem) throw new ProbeFailure(`the update manifest would crash phones: ${problem}`)
}

async function readIdentity(target: ProbeTarget): Promise<IdentityShape> {
  return await httpGetJson(target, '/v2/identity', { authenticated: false }) as IdentityShape
}

async function readSnapshot(target: ProbeTarget): Promise<SnapshotShape> {
  const snapshot = await httpGetJson(target, '/v2/snapshot', { authenticated: true }) as SnapshotShape
  if (!Array.isArray(snapshot.agents) || !Array.isArray(snapshot.chats)) throw new ProbeFailure('the snapshot has no agent or chat list')
  return snapshot
}

function historyPath(chatId: string, before: number | null): string {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(before === null ? {} : { before: String(before) }) })
  return `/v2/chats/${encodeURIComponent(chatId)}/messages?${query}`
}

/**
 * Which chats the baseline reads: the most recently active and the quietest, each once, newest first. The same chats give
 * the same sample, so a check can be repeated.
 */
export function chatsToSample(chats: SnapshotShape['chats']): string[] {
  const byActivity = chats
    .flatMap((chat) => (chat.latestMessage === null ? [] : [{ id: chat.id, latestSeq: chat.latestMessage.seq }]))
    .sort((a, b) => b.latestSeq - a.latestSeq || a.id.localeCompare(b.id))
  const recent = byActivity.slice(0, RECENT_CHATS_SAMPLED)
  const quiet = byActivity.slice(Math.max(RECENT_CHATS_SAMPLED, byActivity.length - QUIET_CHATS_SAMPLED))
  return [...recent, ...quiet].map((chat) => chat.id)
}

/** A sample of conversations, reaching back through older pages: old history is what a bad release is most likely to lose. */
export async function takeBaseline(target: ProbeTarget): Promise<HealthBaseline> {
  const identity = await readIdentity(target)
  const snapshot = await readSnapshot(target)
  const chats = chatsToSample(snapshot.chats)
  const anchors: HistoryAnchor[] = []
  for (const chatId of chats) {
    let before: number | null = null
    for (let page = 0; page < BASELINE_PAGES_BACK; page++) {
      const history = await httpGetJson(target, historyPath(chatId, before), { authenticated: true }) as HistoryShape
      anchors.push({ chatId, before, messageIds: history.messages.map((message) => message.id) })
      if (!history.hasOlder || history.messages.length === 0) break
      before = history.messages[0]!.seq
    }
  }
  return { latestUpdateNumber: identity.latestUpdate?.updateNumber ?? null, machineId: identity.machineId, agentIds: snapshot.agents.map((agent) => agent.id), anchors }
}

/**
 * A page read now must still show everything it showed before. New messages can only add to it. The newest page may have
 * moved along, so only its still-recent part must overlap; older pages are immutable.
 */
export function compareHistoryPage(anchor: HistoryAnchor, messageIdsNow: readonly string[]): string | null {
  const now = new Set(messageIdsNow)
  if (anchor.before === null) {
    const lastBefore = anchor.messageIds.at(-1)
    if (lastBefore === undefined) return null
    const oldestNow = messageIdsNow[0]
    const stillInPage = anchor.messageIds.filter((id) => now.has(id))
    if (messageIdsNow.length === 0) return `chat ${anchor.chatId} now shows no messages at all, and had ${anchor.messageIds.length}`
    if (stillInPage.length === 0 && messageIdsNow.length < anchor.messageIds.length) return `chat ${anchor.chatId} no longer shows its latest messages (${oldestNow})`
    return null
  }
  const missing = anchor.messageIds.filter((id) => !now.has(id))
  if (missing.length > 0) return `chat ${anchor.chatId} lost ${missing.length} of ${anchor.messageIds.length} older messages from before seq ${anchor.before}`
  return null
}

/** Throws a ProbeFailure naming what's wrong. */
export async function probeHealth(target: ProbeTarget, expected: { releaseId: string | null; baseline: HealthBaseline | null }): Promise<void> {
  const identity = await readIdentity(target)
  if (expected.releaseId !== null && identity.releaseId !== expected.releaseId) throw new ProbeFailure(`the server says it is ${identity.releaseId}, expected ${expected.releaseId}`)
  const snapshot = await readSnapshot(target)
  const { baseline } = expected
  await probeUpdateManifest(target, identity.latestUpdate ?? null, baseline?.latestUpdateNumber ?? null)
  if (!baseline) {
    // With nothing to compare to, a read of one conversation still has to work.
    const chat = snapshot.chats.find((candidate) => candidate.latestMessage !== null)
    if (chat) await httpGetJson(target, historyPath(chat.id, null), { authenticated: true })
    return
  }
  if (identity.machineId !== baseline.machineId) throw new ProbeFailure(`this is machine ${identity.machineId}, expected ${baseline.machineId}`)
  const agentIdsNow = new Set(snapshot.agents.map((agent) => agent.id))
  const missingAgents = baseline.agentIds.filter((id) => !agentIdsNow.has(id))
  if (missingAgents.length > 0) throw new ProbeFailure(`${missingAgents.length} of ${baseline.agentIds.length} agents are missing from the list`)
  for (const anchor of baseline.anchors) {
    const history = await httpGetJson(target, historyPath(anchor.chatId, anchor.before), { authenticated: true }) as HistoryShape
    const problem = compareHistoryPage(anchor, history.messages.map((message) => message.id))
    if (problem) throw new ProbeFailure(problem)
  }
}
