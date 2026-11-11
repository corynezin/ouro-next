import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TailscaleHost, TailscaleObservation } from '../adapters/tailscale.ts'
import { CommandRefused } from './failure.ts'
import { LOGIN_WAIT_KEEPS_AWAKE_MS, TailscaleConnection } from './tailscale.ts'

const log = () => {}

test('a server that needs no Tailscale says so, and refuses to connect or remove', async () => {
  const connection = new TailscaleConnection({ setup: { kind: 'not_needed' }, hostname: 'ouro-x', now: Date.now, log })
  assert.deepEqual(await connection.status(), { tailscale: { state: 'not_needed' }, lastFailure: null, neededForComputers: false })
  await assert.rejects(connection.connect(), (error: unknown) => error instanceof CommandRefused && error.code === 'tailscale_not_needed')
  await assert.rejects(connection.remove(), (error: unknown) => error instanceof CommandRefused && error.code === 'tailscale_not_needed')
})

test('a connect asked for again while one runs starts nothing more, nor does a remove asked for meanwhile', async () => {
  let installs = 0
  let finishInstall = () => {}
  let observation: TailscaleObservation = { kind: 'not_installed' }
  const host: TailscaleHost = {
    observe: async () => observation,
    install: () => new Promise((resolve) => { installs++; finishInstall = () => { observation = { kind: 'stopped' }; resolve() } }),
    startLogin: async (hostname) => { observation = { kind: 'needs_login', loginUrl: `https://login.invalid/${hostname}` } },
    remove: async () => { throw new Error('not while connecting') },
  }
  const connection = new TailscaleConnection({ setup: { kind: 'set_up_here', host, neededForComputers: true }, hostname: 'ouro-x', now: Date.now, log })
  assert.equal((await connection.connect()).tailscale.state, 'installing')
  assert.equal((await connection.connect()).tailscale.state, 'installing')
  assert.equal((await connection.remove()).tailscale.state, 'installing', 'the connect still runs')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(installs, 1)
  finishInstall()
  await connection.running
  assert.deepEqual(await connection.status(), { tailscale: { state: 'logging_in', loginUrl: 'https://login.invalid/ouro-x' }, lastFailure: null, neededForComputers: true })
})

test('connecting keeps the host awake, through the login waiting for the person, until it finishes', async () => {
  let now = 1_000
  let observation: TailscaleObservation = { kind: 'stopped' }
  const host: TailscaleHost = {
    observe: async () => observation,
    install: async () => {},
    startLogin: async () => { observation = { kind: 'needs_login', loginUrl: 'https://login.invalid/x' } },
    remove: async () => { observation = { kind: 'not_installed' } },
  }
  const connection = new TailscaleConnection({ setup: { kind: 'set_up_here', host, neededForComputers: true }, hostname: 'ouro-x', now: () => now, log })
  assert.equal(connection.keepsHostAwake(), false)
  await connection.connect()
  assert.equal(connection.keepsHostAwake(), true, 'while installing')
  await connection.running
  now += 60_000
  assert.equal(connection.keepsHostAwake(), true, 'while the login waits')

  observation = { kind: 'running', ip: '100.64.0.1' }
  connection.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(connection.keepsHostAwake(), false, 'the tick saw the login finish')
})

test('a login never approved keeps the host awake only for a while, and a remove ends it', async () => {
  let now = 1_000
  let observation: TailscaleObservation = { kind: 'stopped' }
  const host: TailscaleHost = {
    observe: async () => observation,
    install: async () => {},
    startLogin: async () => { observation = { kind: 'needs_login', loginUrl: 'https://login.invalid/x' } },
    remove: async () => { observation = { kind: 'not_installed' } },
  }
  const connection = new TailscaleConnection({ setup: { kind: 'set_up_here', host, neededForComputers: true }, hostname: 'ouro-x', now: () => now, log })
  await connection.connect()
  await connection.running
  now += LOGIN_WAIT_KEEPS_AWAKE_MS
  assert.equal(connection.keepsHostAwake(), false)
  assert.equal((await connection.status()).tailscale.state, 'logging_in', 'the login itself still waits')

  now += 1_000
  await connection.connect()
  await connection.running
  assert.equal(connection.keepsHostAwake(), true, 'a new connect waits afresh')
  await connection.remove()
  await connection.running
  assert.equal(connection.keepsHostAwake(), false)
})

test('a server that reaches computers without Tailscale can still connect it, and says it is optional', async () => {
  let observation: TailscaleObservation = { kind: 'not_installed' }
  const host: TailscaleHost = {
    observe: async () => observation,
    install: async () => { observation = { kind: 'stopped' } },
    startLogin: async () => { observation = { kind: 'needs_login', loginUrl: 'https://login.invalid/y' } },
    remove: async () => { observation = { kind: 'not_installed' } },
  }
  const connection = new TailscaleConnection({ setup: { kind: 'set_up_here', host, neededForComputers: false }, hostname: 'ouro-y', now: Date.now, log })
  assert.deepEqual(await connection.status(), { tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: false })
  await connection.connect()
  await connection.running
  assert.deepEqual(await connection.status(), { tailscale: { state: 'logging_in', loginUrl: 'https://login.invalid/y' }, lastFailure: null, neededForComputers: false })
})
