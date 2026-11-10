// The ports of core/platform on a real phone. Everything specific to iOS or Expo that core needs is here.
import { AppState, Platform, Settings } from 'react-native'
import { transitionsOf } from '../core/platform/lifecycleTransitions.ts'
import type { AppStateName, LifecycleTransition } from '../core/platform/lifecycleTransitions.ts'
import { fetch as streamingFetch } from 'expo/fetch'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import type {
  AppLifecycle, Clock, DurableStore, FileUploadRequest, HttpRequest, HttpStream, IdSource, Network, SecureStorage,
} from '../core/platform/ports.ts'

export const nativeClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs, fire) {
    const timer = setTimeout(fire, delayMs)
    return () => clearTimeout(timer)
  },
}

/** Hermes has no global `crypto`, hence expo-crypto. */
export const nativeIds: IdSource = { newId: () => Crypto.randomUUID() }

const lifecycleListeners = new Map<LifecycleTransition, Set<() => void>>()
let previousAppState = appStateNameOf(AppState.currentState)
AppState.addEventListener('change', (state) => {
  const next = appStateNameOf(state)
  const fired = transitionsOf(previousAppState, next)
  previousAppState = next
  for (const transition of fired) for (const listener of lifecycleListeners.get(transition) ?? []) listener()
})

/** iOS reports only these three; 'unknown', a missing state and Android's 'extension' read as not active. */
function appStateNameOf(state: string | null | undefined): AppStateName {
  return state === 'active' ? 'active' : state === 'background' ? 'background' : 'inactive'
}

function onTransition(transition: LifecycleTransition, listener: () => void) {
  const listeners = lifecycleListeners.get(transition) ?? new Set()
  lifecycleListeners.set(transition, listeners)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const nativeLifecycle: AppLifecycle = {
  onForeground: (listener) => onTransition('foreground', listener),
  onBackground: (listener) => onTransition('background', listener),
  onSwitchingAway: (listener) => onTransition('switching_away', listener),
  onActiveAgain: (listener) => onTransition('active_again', listener),
  isActive: () => AppState.currentState === 'active',
}

const keychain: SecureStorage = {
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
}

const refusingKeychain: SecureStorage = {
  read: async () => { throw new Error('keychain unreadable for this launch (OuroUnreadableKeychain)') },
  write: async () => { throw new Error('keychain unreadable for this launch (OuroUnreadableKeychain)') },
  remove: async () => { throw new Error('keychain unreadable for this launch (OuroUnreadableKeychain)') },
}

/**
 * Test-only, so the startup-failure screen can be seen on a signed build: launched with `-OuroUnreadableKeychain YES`
 * (`xcrun simctl launch <device> <bundle id> -OuroUnreadableKeychain YES`, or Maestro's launchApp arguments) the keychain
 * refuses everything for that launch, as a locked keychain would. Launch arguments live only in the argument domain:
 * they are never saved, and nothing in the app sets them, so an ordinary launch never takes this path.
 */
const keychainRefusedForThisLaunch = Platform.OS === 'ios' && String(Settings.get('OuroUnreadableKeychain')) === 'YES'

export const nativeSecureStorage: SecureStorage = keychainRefusedForThisLaunch ? refusingKeychain : keychain

const databaseReady = (async () => {
  const database = await SQLite.openDatabaseAsync('ouro-local.db')
  await database.execAsync('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);')
  return database
})()

export const nativeDurableStore: DurableStore = {
  async read(key) {
    const database = await databaseReady
    const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM records WHERE key = ?', key)
    return row?.value ?? null
  },
  async write(key, value) {
    const database = await databaseReady
    await database.runAsync('INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  },
  async remove(key) {
    const database = await databaseReady
    await database.runAsync('DELETE FROM records WHERE key = ?', key)
  },
  async readKeysWithPrefix(prefix) {
    const database = await databaseReady
    return database.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM records WHERE substr(key, 1, ?) = ?', prefix.length, prefix)
  },
}

async function* decodedChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    // Releases the reader only: this doesn't close the connection. Aborting the request's signal does.
    void reader.cancel().catch(() => {})
  }
}

const noChunks: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {} }

export const nativeNetwork: Network = {
  async request(request: HttpRequest) {
    const response = await fetch(request.url, {
      method: request.method, headers: request.headers, body: request.body ?? undefined, signal: request.signal,
    })
    return { status: response.status, text: await response.text() }
  },
  // React Native's own fetch has no body stream.
  async openStream(request: HttpRequest): Promise<HttpStream> {
    const response = await streamingFetch(request.url, {
      method: request.method, headers: request.headers, signal: request.signal,
    })
    return { status: response.status, chunks: response.body ? decodedChunks(response.body) : noChunks }
  },
  async uploadFile(request: FileUploadRequest) {
    const file = await (await fetch(request.fileUri)).blob()
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: file, signal: request.signal })
    return { status: response.status, text: await response.text() }
  },
}

export const nativeDeps = {
  network: nativeNetwork,
  clock: nativeClock,
  lifecycle: nativeLifecycle,
  ids: nativeIds,
  secureStorage: nativeSecureStorage,
  durableStore: nativeDurableStore,
}
